import { describe, it, expect, beforeEach, vi } from "vitest";

// Same "mock db.execute, render the captured sql via PgDialect" approach as
// channel_inbox-enqueue.test.ts — completeChannelMessage issues a raw `sql`
// UPDATE, not the query builder.
const mockState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    execute: mockState.execute,
  },
}));

import { completeChannelMessage } from "./channel_inbox.js";

describe("completeChannelMessage — token scrub (fix-1-brief.md finding 6 minor)", () => {
  beforeEach(() => {
    mockState.execute.mockReset();
    mockState.execute.mockResolvedValue([]);
  });

  it("sets state to 'done' AND scrubs interactionToken/applicationId out of the stored payload jsonb", async () => {
    await completeChannelMessage("row-1");

    expect(mockState.execute).toHaveBeenCalledTimes(1);
    const captured = mockState.execute.mock.calls[0]?.[0];
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const rendered = new PgDialect().sqlToQuery(captured);

    expect(rendered.sql).toContain("state = 'done'");
    expect(rendered.sql).toContain("payload = payload - 'interactionToken' - 'applicationId'");
    expect(rendered.sql).toContain("WHERE id =");
    expect(rendered.params).toEqual(["row-1"]);
  });

  it("issues the exact same statement regardless of which row id is completed — one unconditional code path for every channel (Telegram/Slack/console rows never carry these keys, so the scrub is a no-op for them; Postgres's jsonb '-' operator removing an absent key is documented, standard behavior — this package has no live-Postgres testing to re-verify it against, see channel_inbox-dead-letters.test.ts's header comment)", async () => {
    await completeChannelMessage("row-2");
    await completeChannelMessage("row-3");

    const { PgDialect } = await import("drizzle-orm/pg-core");
    const dialect = new PgDialect();
    const first = dialect.sqlToQuery(mockState.execute.mock.calls[0]?.[0]);
    const second = dialect.sqlToQuery(mockState.execute.mock.calls[1]?.[0]);

    expect(first.sql).toBe(second.sql); // identical SQL shape — completeChannelMessage takes only an id, so it CANNOT branch by channel/payload content
    expect(first.params).toEqual(["row-2"]);
    expect(second.params).toEqual(["row-3"]);
  });
});
