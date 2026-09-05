import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolOptions: undefined as Record<string, unknown> | undefined,
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: vi.fn(function MockPool(options: Record<string, unknown>) {
    mocks.poolOptions = options;
    return { connect: mocks.connect, end: mocks.end };
  }),
}));

import { cleanupNeonTables, FRAMEWORK_STATE_TABLES } from "../state/neonCleanup.js";

describe("Neon startup cleanup", () => {
  beforeEach(() => {
    mocks.poolOptions = undefined;
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.connect.mockReset();
    mocks.end.mockReset();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.end.mockResolvedValue(undefined);
  });

  it("deletes and verifies exactly the framework tables with bounded database waits", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
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

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql.startsWith("DELETE FROM "))).toEqual(
      FRAMEWORK_STATE_TABLES.map((table) => `DELETE FROM ${table}`),
    );
    expect(mocks.poolOptions).toMatchObject({
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
    });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("releases the connection and closes the pool when cleanup fails", async () => {
    const failure = new Error("delete failed");
    mocks.query.mockImplementationOnce(async () => ({
      rows: [{ database: "content", schema: "public" }],
      rowCount: 1,
    })).mockRejectedValueOnce(failure);

    await expect(cleanupNeonTables({
      connectionString: "postgresql://test.invalid/database",
      logger: { log: vi.fn(), warn: vi.fn() },
    })).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
