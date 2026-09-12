import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  neon: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: mocks.neon,
}));

import { cleanupNeonTables, FRAMEWORK_STATE_TABLES } from "../state/neonCleanup.js";

describe("Neon startup cleanup", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.neon.mockReset();
    mocks.sql.mockReset();
    mocks.neon.mockReturnValue(mocks.sql);
  });

  it("deletes and verifies exactly the framework tables over bounded HTTPS requests", async () => {
    mocks.sql.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_database")) {
        return { rows: [{ database: "content", schema: "public" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const statements = mocks.sql.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql.startsWith("DELETE FROM "))).toEqual(
      FRAMEWORK_STATE_TABLES.map((table) => `DELETE FROM ${table}`),
    );
    expect(mocks.neon).toHaveBeenCalledOnce();
    expect(mocks.neon).toHaveBeenCalledWith(
      "postgresql://test.invalid/database",
      { fullResults: true },
    );
    for (const [, parameters, options] of mocks.sql.mock.calls) {
      expect(parameters).toEqual([]);
      expect(options).toMatchObject({ fetchOptions: { signal: expect.any(AbortSignal) } });
    }
  });

  it("retries a connection timeout with a fresh HTTPS query client and then succeeds", async () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const timeout = Object.assign(new Error("request failed"), {
      name: "NeonDbError",
      sourceError: Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }),
    });
    mocks.sql.mockRejectedValueOnce(timeout).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_database")) {
        return { rows: [{ database: "content", schema: "public" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger,
      maxAttempts: 3,
      retryDelayMs: 0,
    });

    expect(mocks.neon).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      "transient connectivity error: request failed",
    ));
    expect(logger.log).toHaveBeenCalledWith("Connecting to Neon database (attempt 2/3)...");
  });

  it("retries an interrupted cleanup from the first table without changing table order", async () => {
    const connectionLost = new Error("Query read timeout");
    let identityCalls = 0;
    mocks.sql.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_database")) {
        identityCalls += 1;
        return { rows: [{ database: "content", schema: "public" }], rowCount: 1 };
      }
      if (identityCalls === 1 && sql === `DELETE FROM ${FRAMEWORK_STATE_TABLES[0]}`) {
        throw connectionLost;
      }
      if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    const deletes = mocks.sql.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.startsWith("DELETE FROM "));
    expect(deletes).toEqual([
      `DELETE FROM ${FRAMEWORK_STATE_TABLES[0]}`,
      ...FRAMEWORK_STATE_TABLES.map((table) => `DELETE FROM ${table}`),
    ]);
    expect(mocks.neon).toHaveBeenCalledTimes(2);
  });

  it("does not retry PostgreSQL statement timeouts or other SQL errors", async () => {
    const statementTimeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    mocks.sql.mockRejectedValueOnce(statementTimeout);

    await expect(cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
      maxAttempts: 3,
      retryDelayMs: 0,
    })).rejects.toBe(statementTimeout);

    expect(mocks.neon).toHaveBeenCalledOnce();
  });

  it("does not retry authentication failures", async () => {
    const authFailure = Object.assign(new Error("password authentication failed"), { code: "28P01" });
    mocks.sql.mockRejectedValueOnce(authFailure);

    await expect(cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
      maxAttempts: 3,
      retryDelayMs: 0,
    })).rejects.toBe(authFailure);

    expect(mocks.neon).toHaveBeenCalledOnce();
  });

  it("stops after the configured number of transient attempts", async () => {
    const timeout = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    mocks.sql.mockRejectedValue(timeout);

    await expect(cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
      maxAttempts: 3,
      retryDelayMs: 0,
    })).rejects.toBe(timeout);

    expect(mocks.neon).toHaveBeenCalledTimes(3);
  });

  it("surfaces a non-transient cleanup failure without retrying", async () => {
    const failure = new Error("delete failed");
    mocks.sql.mockImplementationOnce(async () => ({
      rows: [{ database: "content", schema: "public" }],
      rowCount: 1,
    })).mockRejectedValueOnce(failure);

    await expect(cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
    })).rejects.toBe(failure);
    expect(mocks.neon).toHaveBeenCalledOnce();
  });

  it("aborts an HTTPS query after the bounded query timeout", async () => {
    vi.useFakeTimers();
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    mocks.sql.mockImplementation((
      _sql: string,
      _parameters: unknown[],
      options: { fetchOptions: { signal: AbortSignal } },
    ) => new Promise((_resolve, reject) => {
      options.fetchOptions.signal.addEventListener("abort", () => reject(timeout), { once: true });
    }));

    const assertion = expect(cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
      maxAttempts: 1,
    })).rejects.toBe(timeout);

    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
  });
});
