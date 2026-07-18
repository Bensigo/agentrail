import { describe, it, expect, beforeEach, vi } from "vitest";

// Same "mock db.execute, control the returned rows" approach as
// channel_inbox-dead-letters.test.ts — enqueueChannelMessage issues a raw
// `sql` INSERT, not the query builder, so there is no `.where(...)` condition
// to render the way jace_sessions-intro-anchor.test.ts does. The INSERT's own
// {sql, params} (via drizzle's PgDialect.sqlToQuery, empirically confirmed to
// accept a raw `sql` tagged-template result the same as a query-builder
// condition) IS the argument-level assertion surface here: params are
// positional in column order, so asserting the full params array proves
// which value landed in the workspace_id slot vs the chat_identity_id slot —
// not just that `execute` was called.
const mockState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    execute: mockState.execute,
  },
}));

import { enqueueChannelMessage } from "./channel_inbox.js";

describe("enqueueChannelMessage — either-anchor guard", () => {
  beforeEach(() => {
    mockState.execute.mockReset();
  });

  it("throws before issuing any INSERT when neither workspaceId nor chatIdentityId is given", async () => {
    await expect(
      enqueueChannelMessage({
        channel: "telegram",
        conversationKey: "chat-1",
        providerMessageId: "chat-1:1",
        payload: { text: "hi" },
      })
    ).rejects.toThrow(
      /enqueueChannelMessage: requires either workspaceId or chatIdentityId/
    );
    expect(mockState.execute).not.toHaveBeenCalled();
  });
});

describe("enqueueChannelMessage — anchor column placement", () => {
  beforeEach(() => {
    mockState.execute.mockReset();
  });

  it("locks the column<->position mapping: full rendered SQL text + params for a workspace-anchored insert", async () => {
    mockState.execute.mockResolvedValueOnce([{ id: "row-1" }]);

    const result = await enqueueChannelMessage({
      workspaceId: "ws-1",
      channel: "telegram",
      conversationKey: "chat-1",
      kind: "message",
      senderId: "555",
      senderDisplay: "Ada",
      providerMessageId: "chat-1:1",
      payload: { text: "hi" },
    });

    expect(result).toEqual({ id: "row-1", deduped: false });
    expect(mockState.execute).toHaveBeenCalledTimes(1);

    const captured = mockState.execute.mock.calls[0]?.[0];
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const rendered = new PgDialect().sqlToQuery(captured);

    // Column list order, locked once here; the other tests below only need
    // to check `.params` since this proves the position<->column mapping.
    expect(rendered.sql).toContain(
      "INSERT INTO channel_inbox (\n      workspace_id, chat_identity_id, channel, conversation_key, kind,\n      sender_id, sender_display, provider_message_id, payload\n    )"
    );
    expect(rendered.sql).toContain("ON CONFLICT (channel, provider_message_id) DO NOTHING");
    expect(rendered.params).toEqual([
      "ws-1", // workspace_id
      null, // chat_identity_id
      "telegram", // channel
      "chat-1", // conversation_key
      "message", // kind
      "555", // sender_id
      "Ada", // sender_display
      "chat-1:1", // provider_message_id
      JSON.stringify({ text: "hi" }), // payload
    ]);
  });

  it("anchors on chat_identity_id (workspace_id NULL) for an intro (pre-workspace) sender", async () => {
    mockState.execute.mockResolvedValueOnce([{ id: "row-2" }]);

    await enqueueChannelMessage({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "chat-2",
      senderId: "999",
      senderDisplay: "Grace",
      providerMessageId: "chat-2:7",
      payload: { text: "hello" },
    });

    const captured = mockState.execute.mock.calls[0]?.[0];
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const rendered = new PgDialect().sqlToQuery(captured);

    expect(rendered.params[0]).toBeNull(); // workspace_id
    expect(rendered.params[1]).toBe("chat-identity-1"); // chat_identity_id
  });

  it("defaults kind/senderId/senderDisplay and returns deduped:true on a conflicting redelivery", async () => {
    mockState.execute.mockResolvedValueOnce([]); // ON CONFLICT DO NOTHING -> no row

    const result = await enqueueChannelMessage({
      workspaceId: "ws-1",
      channel: "telegram",
      conversationKey: "chat-1",
      providerMessageId: "chat-1:1",
      payload: { text: "hi" },
    });

    expect(result).toEqual({ id: null, deduped: true });

    const captured = mockState.execute.mock.calls[0]?.[0];
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const rendered = new PgDialect().sqlToQuery(captured);
    expect(rendered.params[4]).toBe("message"); // kind default
    expect(rendered.params[5]).toBe(""); // sender_id default
    expect(rendered.params[6]).toBe(""); // sender_display default
  });
});
