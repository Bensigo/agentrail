/**
 * Pure recognition + decision for the in-chat `/connect` command.
 *
 * Handled in the console dispatcher BEFORE workspace resolution, so it works
 * on exactly the conversations that are broken (no jace_sessions row needed)
 * and never reaches the model — recognition is exact string matching, not
 * classification. See docs/superpowers/specs/2026-07-27-jace-connect-command-design.md.
 */

const COMMAND = "/connect";

/** Discord guild messages arrive mention-prefixed: `<@123> /connect`. */
const LEADING_MENTION = /^<@!?\d+>\s*/;

/**
 * Recognize `/connect [workspace]`. The token must be FIRST — a message that
 * merely contains "/connect" is a normal message and reaches Jace unchanged.
 * A trailing `@botname` (Telegram groups) is stripped from the token only.
 */
export function parseConnectCommand(text: string): {
  isCommand: boolean;
  arg: string;
} {
  const stripped = String(text ?? "").trim().replace(LEADING_MENTION, "");
  if (!stripped) return { isCommand: false, arg: "" };

  const firstSpace = stripped.search(/\s/);
  const rawToken = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
  const token = rawToken.split("@")[0]!.toLowerCase();
  if (token !== COMMAND) return { isCommand: false, arg: "" };

  const arg = firstSpace === -1 ? "" : stripped.slice(firstSpace).trim();
  return { isCommand: true, arg };
}

export interface WorkspaceRef {
  id: string;
  name: string;
}

/** The current pin. `name` is null when the requester cannot reach it — in
 * that case nothing about it may be echoed back (see `repin_refused`). */
export interface PinnedRef {
  id: string;
  name: string | null;
}

export type ConnectCommandAction =
  | { kind: "send_link" }
  | { kind: "no_workspaces" }
  | { kind: "pin"; workspace: WorkspaceRef }
  | { kind: "repin"; from: WorkspaceRef; to: WorkspaceRef }
  | { kind: "repin_refused" }
  | { kind: "already_pinned"; workspace: WorkspaceRef | null; alternatives: WorkspaceRef[] }
  | { kind: "choose"; options: WorkspaceRef[] }
  | { kind: "unknown_workspace"; options: WorkspaceRef[] };

export interface DecideConnectCommandInput {
  arg: string;
  identity: { userId: string | null };
  pinned: PinnedRef | null;
  reachable: WorkspaceRef[];
}

/** Exact, case-insensitive name match. Returns null for zero OR 2+ matches —
 * an ambiguous name must re-render the list, never silently pick one. */
function matchWorkspace(arg: string, reachable: WorkspaceRef[]): WorkspaceRef | null {
  const wanted = arg.trim().toLowerCase();
  if (!wanted) return null;
  const hits = reachable.filter((w) => w.name.toLowerCase() === wanted);
  return hits.length === 1 ? hits[0]! : null;
}

export function decideConnectCommand(
  input: DecideConnectCommandInput
): ConnectCommandAction {
  const { identity, pinned, reachable } = input;
  const arg = input.arg.trim();

  // Account linking always comes first — the arg is meaningless until we know
  // which user this chat account belongs to.
  if (identity.userId == null) return { kind: "send_link" };
  if (reachable.length === 0) return { kind: "no_workspaces" };

  const target = arg ? matchWorkspace(arg, reachable) : null;
  if (arg && !target) return { kind: "unknown_workspace", options: reachable };

  if (!pinned) {
    if (target) return { kind: "pin", workspace: target };
    if (reachable.length === 1) return { kind: "pin", workspace: reachable[0]! };
    return { kind: "choose", options: reachable };
  }

  const alternatives = reachable.filter((w) => w.id !== pinned.id);
  // Resolve the current pin against `reachable` up front: this is the only
  // safe source of a name/id pair to echo back. `pinned` itself must never be
  // returned in an action — the requester may not have standing in it.
  const current = reachable.find((w) => w.id === pinned.id) ?? null;

  if (!target || target.id === pinned.id) {
    return { kind: "already_pinned", workspace: current, alternatives };
  }

  // Authority rule: you may move a conversation BETWEEN workspaces you have
  // standing in, but you may not move one out of a workspace you are a
  // stranger to. `pinned.name` is non-null exactly when it is reachable.
  if (!current) return { kind: "repin_refused" };

  return { kind: "repin", from: current, to: target };
}
