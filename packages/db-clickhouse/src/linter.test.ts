import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  client: {
    query: vi.fn(),
  },
}));

import { client } from "./client";
import {
  AgentBehaviorLinter,
  DEFAULT_BEHAVIOR_THRESHOLDS,
} from "./linter";

const WORKSPACE_ID = "ws-1";
const RUN_ID = "run-1";

function row(
  eventId: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    event_id: eventId,
    payload: JSON.stringify({
      type: "agent_activity",
      ...payload,
    }),
  };
}

function mockRows(rows: Record<string, unknown>[]) {
  vi.mocked(client.query).mockResolvedValue({
    json: vi.fn().mockResolvedValue(rows),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentBehaviorLinter", () => {
  it("fires excessive_file_reads independently", async () => {
    mockRows([
      row("evt-files", {
        files_read_count: DEFAULT_BEHAVIOR_THRESHOLDS.maxFilesReadCount + 1,
      }),
    ]);

    await expect(AgentBehaviorLinter(WORKSPACE_ID, RUN_ID)).resolves.toEqual([
      {
        rule: "excessive_file_reads",
        severity: "warning",
        evidence_event_id: "evt-files",
      },
    ]);
  });

  it("fires full_file_read independently", async () => {
    mockRows([row("evt-full", { full_file_read: 1 })]);

    await expect(AgentBehaviorLinter(WORKSPACE_ID, RUN_ID)).resolves.toEqual([
      {
        rule: "full_file_read",
        severity: "warning",
        evidence_event_id: "evt-full",
      },
    ]);
  });

  it("fires tool_loop independently", async () => {
    mockRows([
      row("evt-loop", {
        tool_loop_count: DEFAULT_BEHAVIOR_THRESHOLDS.maxToolLoopCount + 1,
      }),
    ]);

    await expect(AgentBehaviorLinter(WORKSPACE_ID, RUN_ID)).resolves.toEqual([
      {
        rule: "tool_loop",
        severity: "warning",
        evidence_event_id: "evt-loop",
      },
    ]);
  });

  it("fires context_blind_edit independently", async () => {
    mockRows([row("evt-edit", { edit_without_context: 1 })]);

    await expect(AgentBehaviorLinter(WORKSPACE_ID, RUN_ID)).resolves.toEqual([
      {
        rule: "context_blind_edit",
        severity: "error",
        evidence_event_id: "evt-edit",
      },
    ]);
  });

  it("fires verification_skip independently", async () => {
    mockRows([row("evt-verify", { verification_skip: 1 })]);

    await expect(AgentBehaviorLinter(WORKSPACE_ID, RUN_ID)).resolves.toEqual([
      {
        rule: "verification_skip",
        severity: "error",
        evidence_event_id: "evt-verify",
      },
    ]);
  });

  it("returns an empty array for a clean run", async () => {
    mockRows([
      row("evt-clean", {
        files_read_count: DEFAULT_BEHAVIOR_THRESHOLDS.maxFilesReadCount,
        full_file_read: 0,
        tool_loop_count: DEFAULT_BEHAVIOR_THRESHOLDS.maxToolLoopCount,
        edit_without_context: 0,
        verification_skip: 0,
      }),
    ]);

    await expect(AgentBehaviorLinter(WORKSPACE_ID, RUN_ID)).resolves.toEqual(
      []
    );
  });

  it("honors workspace-level threshold overrides passed by caller", async () => {
    mockRows([row("evt-files", { files_read_count: 12 })]);

    await expect(
      AgentBehaviorLinter(WORKSPACE_ID, RUN_ID, { maxFilesReadCount: 20 })
    ).resolves.toEqual([]);
  });
});
