import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { commandMock, closeMock } = vi.hoisted(() => ({
  commandMock: vi.fn(),
  closeMock: vi.fn(),
}));

// migrate.ts imports "./client.js" (not "./schema") — the .js suffix is
// required for the compiled deploy-time bundle to resolve under Node's ESM
// loader (see packages/db-clickhouse/tsconfig.build.json); the mock path must
// match that specifier exactly.
vi.mock("./client.js", () => ({
  client: {
    command: commandMock,
    close: closeMock,
  },
}));

import { main, runClickHouseMigrations } from "./migrate";

describe("runClickHouseMigrations", () => {
  beforeEach(() => {
    commandMock.mockReset().mockResolvedValue(undefined);
    closeMock.mockReset().mockResolvedValue(undefined);
  });

  it("applies every CREATE TABLE / ALTER TABLE statement and closes the client", async () => {
    await runClickHouseMigrations({ command: commandMock, close: closeMock });

    const queries = commandMock.mock.calls.map(([arg]) => arg.query as string);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS run_events"))
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS failure_events"))
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS context_packs"))
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS context_events"))
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS index_snapshots"))
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS cost_events"))
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS afk_run_events"))
    ).toBe(true);
    expect(
      queries.some((q) =>
        q.includes("CREATE TABLE IF NOT EXISTS wiki_compile_events")
      )
    ).toBe(true);
    // Every ALTER in this script is additive/idempotent by construction.
    expect(
      queries
        .filter((q) => q.includes("ALTER TABLE"))
        .every((q) => q.includes("ADD COLUMN IF NOT EXISTS"))
    ).toBe(true);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: running twice issues the identical statement list and neither run throws", async () => {
    await runClickHouseMigrations({ command: commandMock, close: closeMock });
    const firstQueries = commandMock.mock.calls.map(([arg]) => arg.query as string);

    commandMock.mockClear();
    closeMock.mockClear();
    await expect(
      runClickHouseMigrations({ command: commandMock, close: closeMock })
    ).resolves.toBeUndefined();
    const secondQueries = commandMock.mock.calls.map(([arg]) => arg.query as string);

    expect(secondQueries).toEqual(firstQueries);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a genuine failure instead of swallowing it", async () => {
    commandMock.mockReset().mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      runClickHouseMigrations({ command: commandMock, close: closeMock })
    ).rejects.toThrow("connection refused");
    // The rejected command short-circuits the sequence before close() runs.
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe("main() — skip-vs-run deploy semantics", () => {
  const originalUrl = process.env.CLICKHOUSE_URL;

  beforeEach(() => {
    commandMock.mockReset().mockResolvedValue(undefined);
    closeMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.CLICKHOUSE_URL;
    else process.env.CLICKHOUSE_URL = originalUrl;
  });

  it("skips and resolves 0 when CLICKHOUSE_URL is unset, without touching the client", async () => {
    delete process.env.CLICKHOUSE_URL;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main();

    expect(code).toBe(0);
    expect(commandMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some(([msg]) =>
        String(msg).includes("skipping ClickHouse migrations")
      )
    ).toBe(true);
    logSpy.mockRestore();
  });

  it("runs migrations and resolves 0 when CLICKHOUSE_URL is set and migrations succeed", async () => {
    process.env.CLICKHOUSE_URL = "http://clickhouse.railway.internal:8123";

    const code = await main();

    expect(code).toBe(0);
    expect(commandMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects (so the caller exits non-zero) when CLICKHOUSE_URL is set but migration genuinely fails", async () => {
    process.env.CLICKHOUSE_URL = "http://clickhouse.railway.internal:8123";
    commandMock.mockReset().mockRejectedValueOnce(new Error("boom"));

    await expect(main()).rejects.toThrow("boom");
  });
});
