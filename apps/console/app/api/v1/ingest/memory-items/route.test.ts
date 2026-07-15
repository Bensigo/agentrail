import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  insertMemoryItems: vi.fn(),
  replaceMemoryItemsByWriter: vi.fn(),
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import {
  insertMemoryItems,
  replaceMemoryItemsByWriter,
  getRepository,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";
const RUN_ID = "00000000-0000-0000-0000-000000000099";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/memory-items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  run_id: RUN_ID,
  repository_id: REPO,
  items: [
    { content: "Always mock subprocess in tests", tags: ["testing"] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
  } as never);
  vi.mocked(getRepository).mockResolvedValue({ id: REPO, workspaceId: WS } as never);
  vi.mocked(insertMemoryItems).mockResolvedValue(undefined);
  vi.mocked(replaceMemoryItemsByWriter).mockResolvedValue(undefined);
});

describe("POST /api/v1/ingest/memory-items", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + ok:true and insertMemoryItems called on valid body", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(insertMemoryItems).toHaveBeenCalledWith({
      workspaceId: WS,
      repositoryId: REPO,
      source: "review",
      items: [
        { content: "Always mock subprocess in tests", tags: ["testing", `run:${RUN_ID}`] },
      ],
    });
  });

  it("does not duplicate run tag if already present", async () => {
    const bodyWithTag = {
      ...valid,
      items: [
        {
          content: "Some note",
          tags: [`run:${RUN_ID}`, "extra"],
        },
      ],
    };
    await POST(req(bodyWithTag));
    expect(insertMemoryItems).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ tags: [`run:${RUN_ID}`, "extra"] }),
        ],
      })
    );
  });

  it("404 when repo not in workspace", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("400 on missing run_id", async () => {
    const { run_id: _omit, ...noRunId } = valid;
    const res = await POST(req(noRunId));
    expect(res.status).toBe(400);
  });

  it("400 on missing repository_id", async () => {
    const { repository_id: _omit, ...noRepo } = valid;
    const res = await POST(req(noRepo));
    expect(res.status).toBe(400);
  });

  it("400 on item with empty content", async () => {
    const res = await POST(req({ ...valid, items: [{ content: "", tags: [] }] }));
    expect(res.status).toBe(400);
  });

  it("400 on items with non-string tag", async () => {
    const res = await POST(
      req({ ...valid, items: [{ content: "note", tags: [123] }] })
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON", async () => {
    const badReq = new NextRequest("http://localhost/api/v1/ingest/memory-items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ar_test" },
      body: "not json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  it("502 when insertMemoryItems throws", async () => {
    vi.mocked(insertMemoryItems).mockRejectedValue(new Error("db down"));
    const res = await POST(req(valid));
    expect(res.status).toBe(502);
  });

  it("422 + recorded reason when an item contains a credential, and does not insert", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = {
      ...valid,
      items: [
        {
          content: "prod aws key is AKIAIOSFODNN7EXAMPLE, do not lose it",
          tags: ["secops"],
        },
      ],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/credential-shaped/i);
    // Reason is recorded and names the kind, without echoing the secret value.
    expect(json.reason).toContain("aws_access_key_id");
    expect(json.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(insertMemoryItems).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rejects the whole batch if only one item is credential-shaped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = {
      ...valid,
      items: [
        { content: "a perfectly fine note", tags: [] },
        { content: "token ghp_abcdef0123456789ABCDEFabcdef01234567", tags: [] },
      ],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(422);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("allows prose that merely mentions the word password", async () => {
    const body = {
      ...valid,
      items: [{ content: "Reset your password on the settings page.", tags: [] }],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(202);
    expect(insertMemoryItems).toHaveBeenCalled();
  });

  it("forwards written_by, source, and per-item type when provided", async () => {
    const body = {
      run_id: RUN_ID,
      repository_id: REPO,
      written_by: "onboarder",
      source: "onboard",
      items: [
        { content: "Prefer pnpm over npm here", tags: ["setup"], type: "preference" },
        { content: "We chose Postgres over Mongo", tags: ["adr"], type: "decision" },
      ],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(202);
    expect(insertMemoryItems).toHaveBeenCalledWith({
      workspaceId: WS,
      repositoryId: REPO,
      source: "onboard",
      writtenBy: "onboarder",
      items: [
        {
          content: "Prefer pnpm over npm here",
          tags: ["setup", `run:${RUN_ID}`],
          type: "preference",
        },
        {
          content: "We chose Postgres over Mongo",
          tags: ["adr", `run:${RUN_ID}`],
          type: "decision",
        },
      ],
    });
  });

  it("backward compat: no source/written_by/type -> source review, type undefined", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    // Legacy body maps to source "review"; writtenBy is left undefined so the
    // query layer falls back to source, and item type is undefined so the query
    // layer falls back to "fact". No `type` is forced onto the item here.
    expect(insertMemoryItems).toHaveBeenCalledWith({
      workspaceId: WS,
      repositoryId: REPO,
      source: "review",
      items: [
        { content: "Always mock subprocess in tests", tags: ["testing", `run:${RUN_ID}`] },
      ],
    });
    const callArg = vi.mocked(insertMemoryItems).mock.calls[0][0];
    expect(callArg.source).toBe("review");
    expect(callArg.writtenBy).toBeUndefined();
    expect(callArg.items[0].type).toBeUndefined();
  });

  it("400 on item with an out-of-enum type, and does not insert", async () => {
    const body = {
      ...valid,
      items: [{ content: "note", tags: [], type: "bogus" }],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("replace_by_writer + written_by -> replaceMemoryItemsByWriter, not insert", async () => {
    const body = {
      run_id: RUN_ID,
      repository_id: REPO,
      written_by: "onboarder",
      source: "onboard",
      replace_by_writer: true,
      items: [
        { content: "Prefer pnpm over npm here", tags: ["setup"], type: "preference" },
      ],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(replaceMemoryItemsByWriter).toHaveBeenCalledTimes(1);
    expect(replaceMemoryItemsByWriter).toHaveBeenCalledWith({
      workspaceId: WS,
      repositoryId: REPO,
      writtenBy: "onboarder",
      source: "onboard",
      items: [
        {
          content: "Prefer pnpm over npm here",
          tags: ["setup", `run:${RUN_ID}`],
          type: "preference",
        },
      ],
    });
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("backward compat: no replace_by_writer -> insertMemoryItems, not replace", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(insertMemoryItems).toHaveBeenCalledWith({
      workspaceId: WS,
      repositoryId: REPO,
      source: "review",
      items: [
        { content: "Always mock subprocess in tests", tags: ["testing", `run:${RUN_ID}`] },
      ],
    });
    expect(replaceMemoryItemsByWriter).not.toHaveBeenCalled();
  });

  it("replace_by_writer without written_by falls back to insert path", async () => {
    const body = {
      run_id: RUN_ID,
      repository_id: REPO,
      source: "onboard",
      replace_by_writer: true,
      items: [{ content: "A note without a writer", tags: ["setup"] }],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(202);
    expect(insertMemoryItems).toHaveBeenCalledTimes(1);
    expect(replaceMemoryItemsByWriter).not.toHaveBeenCalled();
  });

  it("400 on non-boolean replace_by_writer, and touches neither db fn", async () => {
    const body = {
      ...valid,
      written_by: "onboarder",
      replace_by_writer: "yes",
    };
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(insertMemoryItems).not.toHaveBeenCalled();
    expect(replaceMemoryItemsByWriter).not.toHaveBeenCalled();
  });
});
