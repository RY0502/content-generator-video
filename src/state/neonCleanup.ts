import { neon, type FullQueryResults } from "@neondatabase/serverless";

export const FRAMEWORK_STATE_TABLES = [
  "agent_custom_state",
  "agent_events",
  "agent_todos",
  "agent_runs",
  "checkpoint_writes",
  "checkpoints",
] as const;
const NEON_HTTP_QUERY_TIMEOUT_MS = 35_000;
const DEFAULT_NEON_CLEANUP_MAX_ATTEMPTS = 3;
const MAX_NEON_CLEANUP_ATTEMPTS = 5;
const DEFAULT_NEON_CLEANUP_RETRY_DELAY_MS = 1_000;
const MAX_NEON_CLEANUP_RETRY_DELAY_MS = 10_000;

export interface NeonCleanupLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface NeonCleanupOptions {
  connectionString?: string;
  logger?: NeonCleanupLogger;
  /** Total connection/cleanup attempts. Clamped to keep startup bounded. */
  maxAttempts?: number;
  /** Initial retry delay. Later retries use bounded exponential backoff. */
  retryDelayMs?: number;
}

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorChain(error: unknown): Array<{ code?: unknown; message?: unknown; name?: unknown }> {
  const chain: Array<{ code?: unknown; message?: unknown; name?: unknown }> = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const item = current as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      cause?: unknown;
      sourceError?: unknown;
    };
    chain.push(item);
    pending.push(item.cause, item.sourceError);
  }
  return chain;
}

/**
 * Only connectivity failures are safe to retry. In particular, PostgreSQL
 * statement timeouts, authentication failures, and schema/SQL errors must
 * surface immediately instead of being hidden behind repeated cleanup calls.
 */
function isTransientNeonConnectivityError(error: unknown): boolean {
  const chain = errorChain(error);

  // A five-character PostgreSQL SQLSTATE outside connection-exception class
  // 08 is a database error, even if an outer wrapper mentions a timeout.
  if (chain.some((item) => {
    const code = typeof item.code === "string" ? item.code.toUpperCase() : "";
    return /^[0-9A-Z]{5}$/.test(code)
      && !TRANSIENT_NETWORK_ERROR_CODES.has(code)
      && !code.startsWith("08");
  })) {
    return false;
  }

  for (const item of chain) {
    const code = typeof item.code === "string" ? item.code.toUpperCase() : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (
      TRANSIENT_NETWORK_ERROR_CODES.has(code)
      || code.startsWith("08")
      || name === "AbortError"
      || name === "TimeoutError"
    ) {
      return true;
    }
  }

  return chain.some((item) => {
    const message = typeof item.message === "string" ? item.message : "";
    return /(?:^Query read timeout$|^timeout exceeded when trying to connect$|connection (?:terminated|closed|reset|refused)(?: unexpectedly)?|connection timeout|connect(?:ion)? timed out|socket hang up|server closed the connection unexpectedly|client has encountered a connection error|temporary failure in name resolution|getaddrinfo EAI_AGAIN|error connecting to database|fetch failed|server error \(HTTP status (?:408|425|429|500|502|503|504)\))/i.test(message);
  });
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function retryDelay(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(MAX_NEON_CLEANUP_RETRY_DELAY_MS, baseDelayMs * (2 ** (failedAttempt - 1)));
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function cleanupNeonTablesAttempt(
  connectionString: string,
  logger: NeonCleanupLogger,
  attempt: number,
  maxAttempts: number,
): Promise<void> {
  // Match the framework's stateless Neon HTTPS transport. A fresh query
  // function per attempt also ensures no failed request state is reused.
  const sql = neon<false, true>(connectionString, { fullResults: true });
  const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
  ): Promise<FullQueryResults<false> & { rows: Row[] }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NEON_HTTP_QUERY_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await sql(statement, [], {
        fetchOptions: { signal: controller.signal },
      }) as FullQueryResults<false> & { rows: Row[] };
    } finally {
      clearTimeout(timeout);
    }
  };

  logger.log(`Connecting to Neon database (attempt ${attempt}/${maxAttempts})...`);
  const identity = await query<{ database: string; schema: string }>(
    "SELECT current_database() AS database, current_schema() AS schema",
  );
  logger.log("Starting cleanup of framework state tables...");
  logger.log(`Connected database: ${identity.rows[0]?.database ?? "unknown"}`);
  logger.log(`Connected schema: ${identity.rows[0]?.schema ?? "unknown"}`);

  for (const table of FRAMEWORK_STATE_TABLES) {
    try {
      const before = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table}`,
      );
      logger.log(`Deleting ${before.rows[0]?.count ?? "0"} rows from table: ${table}`);
      const result = await query(`DELETE FROM ${table}`);
      const after = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table}`,
      );
      const remaining = after.rows[0]?.count ?? "unknown";
      if (remaining !== "0") {
        throw new Error(`Cleanup verification failed: ${remaining} rows remain in ${table}`);
      }
      logger.log(`Deleted ${result.rowCount ?? 0} rows from ${table}; remaining: ${remaining}`);
    } catch (error) {
      const postgresError = error as { code?: string };
      if (postgresError.code === "42P01") {
        logger.warn(`Table ${table} does not exist; skipped.`);
        continue;
      }
      throw error;
    }
  }

  logger.log("Neon framework-state cleanup completed and verified.");
}

/**
 * Deletes only framework run/checkpoint state. Domain episode and Agnes state
 * lives in Turso and is intentionally untouched so a later invocation resumes
 * the same episode and provider receipts.
 */
export async function cleanupNeonTables(options: NeonCleanupOptions = {}): Promise<void> {
  const connectionString = options.connectionString ?? process.env.NEON_DATABASE_URL;
  if (!connectionString?.trim()) {
    throw new Error("NEON_DATABASE_URL environment variable is not set.");
  }

  const logger = options.logger ?? console;
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_NEON_CLEANUP_MAX_ATTEMPTS,
    1,
    MAX_NEON_CLEANUP_ATTEMPTS,
  );
  const baseRetryDelayMs = boundedInteger(
    options.retryDelayMs,
    DEFAULT_NEON_CLEANUP_RETRY_DELAY_MS,
    0,
    MAX_NEON_CLEANUP_RETRY_DELAY_MS,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await cleanupNeonTablesAttempt(connectionString, logger, attempt, maxAttempts);
      return;
    } catch (error) {
      if (!isTransientNeonConnectivityError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = retryDelay(baseRetryDelayMs, attempt);
      logger.warn(
        `Neon cleanup attempt ${attempt}/${maxAttempts} failed with a transient connectivity error: ${describeError(error)}. `
        + `Retrying with a fresh HTTPS query client in ${delayMs}ms.`,
      );
      await wait(delayMs);
    }
  }
}
