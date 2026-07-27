import type { ConnectCommandAction, WorkspaceRef } from "./connect-command";

function list(options: WorkspaceRef[]): string {
  return options.map((o) => `- ${o.name}`).join("\n");
}

export function renderConnectReply(
  action: ConnectCommandAction,
  ctx: { linkUrl?: string; expiresAt?: Date; consoleUrl: string }
): string {
  switch (action.kind) {
    case "send_link":
      return ctx.linkUrl
        ? `Open this to connect your account:\n${ctx.linkUrl}\n\nIt works once, and expires in 30 minutes.`
        : `I couldn't create a connect link right now. Try /connect again in a moment.`;
    case "no_workspaces":
      return `Your account is connected, but you're not in a workspace yet. Create one at ${ctx.consoleUrl}, then send /connect again.`;
    case "pin":
      return `Connected to ${action.workspace.name}.`;
    case "repin":
      return `Moved this chat from ${action.from.name} to ${action.to.name}. Everyone here is now working in ${action.to.name}.`;
    case "repin_refused":
      return `This chat is already connected to a workspace you're not a member of, so I can't move it. Someone who is a member can, or you can change it in the console.`;
    case "already_pinned":
      // `workspace` is null when the requester cannot reach the current pin —
      // we must not name it, so the copy stays deliberately vague.
      return action.alternatives.length
        ? `This chat is connected to ${action.workspace?.name ?? "a workspace"}. To switch:\n${list(action.alternatives)}\n\nSend /connect <name>.`
        : `This chat is connected to ${action.workspace?.name ?? "a workspace"}.`;
    case "choose":
      return `Which workspace should this chat use?\n${list(action.options)}\n\nSend /connect <name>.`;
    case "unknown_workspace":
      return `I don't have a workspace by that name. Yours:\n${list(action.options)}\n\nSend /connect <name>.`;
  }
}
