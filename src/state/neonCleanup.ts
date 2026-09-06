import { Pool } from "pg";

export const FRAMEWORK_STATE_TABLES = [
  "agent_custom_state",
  "agent_events",
  "agent_todos",
  "agent_runs",
  "checkpoint_writes",
  "checkpoints",
] as const;
const NEON_CONNECTION_TIMEOUT_MS = 10_000;
const NEON_STATEMENT_TIMEOUT_MS = 30_000;
const NEON_QUERY_TIMEOUT_MS = 35_000;

export interface NeonCleanupLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface NeonCleanupOptions {
  connectionString?: string;
  logger?: NeonCleanupLogger;
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
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: NEON_CONNECTION_TIMEOUT_MS,
    statement_timeout: NEON_STATEMENT_TIMEOUT_MS,
    query_timeout: NEON_QUERY_TIMEOUT_MS,
  });
  try {
    logger.log("Connecting to Neon database...");
    const client = await pool.connect();
    try {
      logger.log("Starting cleanup of framework state tables...");

      const identity = await client.query<{ database: string; schema: string }>(
        "SELECT current_database() AS database, current_schema() AS schema",
      );
      logger.log(`Connected database: ${identity.rows[0]?.database ?? "unknown"}`);
      logger.log(`Connected schema: ${identity.rows[0]?.schema ?? "unknown"}`);

      for (const table of FRAMEWORK_STATE_TABLES) {
        try {
          const before = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM ${table}`,
          );
          logger.log(`Deleting ${before.rows[0]?.count ?? "0"} rows from table: ${table}`);
          const result = await client.query(`DELETE FROM ${table}`);
          const after = await client.query<{ count: string }>(
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
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
