import { auth, signIn } from "@agentrail/auth";
import {
  consumeChatIdentityLinkToken,
  bindChatIdentityUser,
  bindChatIdentityWorkspace,
  listWorkspacesForUser,
} from "@agentrail/db-postgres";
import { decideConnectIdentityBind } from "../../../../lib/connect-bind-decision";
import { sendConnectBindConfirmation } from "../../../../lib/connect-bind-confirmation";
import {
  completeConnectOwnerElect,
  buildOwnerElectCompletionLine,
} from "../../../../lib/connect-owner-elect-completion";

interface Props {
  params: Promise<{ token: string }>;
}

/**
 * /connect/[token] — the connect-GitHub landing page Jace's in-chat link
 * points at (spec §4.2, issue #1263). Structure copied from
 * (auth)/invite/[token]/page.tsx: a signed-out visitor gets a minimal
 * explanation + GitHub sign-in that round-trips back to this same path; a
 * signed-in visitor drives the actual bind. Styling matches invite's plain
 * inline-style markup exactly — no new design-system work here.
 */
export default async function ConnectPage({ params }: Props) {
  const { token } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "system-ui, sans-serif",
          gap: "1rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
          Jace sent you this link to connect your GitHub
        </h1>
        <p style={{ color: "#666" }}>
          Sign in with GitHub to finish connecting your account.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", {
              redirectTo: `/connect/${token}`,
            });
          }}
        >
          <button
            type="submit"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.75rem 1.5rem",
              fontSize: "1rem",
              fontWeight: 500,
              background: "#24292e",
              color: "var(--gray-13)",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Sign in with GitHub
          </button>
        </form>
      </main>
    );
  }

  // Consuming is ONE atomic, single-use operation
  // (queries/chat_identities.ts `consumeChatIdentityLinkToken`): null covers
  // an expired token, an already-used token, AND an unknown token alike,
  // indistinguishably by design (spec §4.2 AC3) — never leak which case it
  // was; the remedy is the same either way. This also means a reload of THIS
  // page after a successful bind below hits this same branch on the second
  // pass, since the first call already consumed the token — showing
  // "expired" on a refresh is expected, not a bug, because the success
  // screen already told the user it worked.
  const identity = await consumeChatIdentityLinkToken(token);

  // Reused verbatim below for the foreign_user case too (review fix,
  // #1263 PR ①): an identity claimed by someone else must render as
  // INDISTINGUISHABLE from "no such token" — same title, same body, same
  // element — never a different message that would confirm the token was
  // real and reveal it belongs to another account.
  const expiredOrUsedScreen = (
    <ConnectMessage
      title="Link expired or already used"
      body="Ask Jace for a fresh connect link in the chat."
    />
  );

  if (!identity) {
    return expiredOrUsedScreen;
  }

  // Workspace completion rule (spec §4.2, controller-resolved): auto-bind
  // the workspace only when there's exactly one unambiguous answer AND the
  // identity doesn't already have one. See decideConnectWorkspaceBind's own
  // doc-comment for the zero/many rationale. Never creates a membership or a
  // workspace (#1264 owns workspace creation) — only binds to one that
  // already exists.
  //
  // decideConnectIdentityBind (review fix, #1263 PR ①) gates this: a
  // consumed token whose identity is already linked to a DIFFERENT user
  // (foreign_user) is a hijack attempt — never bind, never workspace-bind,
  // render the same expired/unknown screen as above. Redeeming twice as the
  // rightful owner (already_yours) is idempotent success. See the helper's
  // own doc-comment for the full truth table.
  const memberships = await listWorkspacesForUser(session.user.id);
  const decision = decideConnectIdentityBind({
    identity: { userId: identity.userId, workspaceId: identity.workspaceId },
    sessionUserId: session.user.id,
    memberships: memberships.map((m) => ({ id: m.id, name: m.name })),
  });

  if (decision.kind === "foreign_user") {
    return expiredOrUsedScreen;
  }

  if (decision.kind === "fresh_bind") {
    await bindChatIdentityUser(identity.id, session.user.id);
  }

  if (decision.workspaceDecision.action === "bind") {
    await bindChatIdentityWorkspace(identity.id, decision.workspaceDecision.workspace.id);
  }

  // Owner-elect completion (issue #1264 PR ②): `identity.workspaceId` here is
  // the value captured ABOVE, from `consumeChatIdentityLinkToken`'s return —
  // BEFORE any of this request's own mutations. Non-null means the identity
  // already carried a workspace (most commonly one Jace's `create_workspace`
  // tool created ownerless, issue #1264 PR ①). This is deliberately NOT
  // `decision.workspaceDecision`'s workspace id (the #1263 auto-bind-to-an-
  // existing-membership path just above): that action only ever fires when
  // `identity.workspaceId` was null to begin with, so the two never overlap
  // in one request. Safe to call unconditionally — see
  // connect-owner-elect-completion.ts's doc-comment for why an already-owned
  // workspace makes this a harmless no-op. Awaited (not fire-and-forget, per
  // the confirmation send below): the success screen needs to know
  // completed/name before it renders, but this itself never throws.
  const ownerElectCompletion = await completeConnectOwnerElect({
    workspaceId: identity.workspaceId,
    userId: session.user.id,
  });

  const user = session.user as typeof session.user & {
    email?: string;
    name?: string;
  };
  const accountLabel = user.name ?? user.email ?? "your GitHub account";

  // Fire-and-forget: Jace's in-thread confirmation (issue #1263 PR ②) is
  // best-effort and must never fail or delay this page's own render. Never
  // awaited by this render path; the trailing `.catch` is a second,
  // belt-and-suspenders guard on top of the helper's own internal catch (see
  // connect-bind-confirmation.ts) — a rejection here should be structurally
  // impossible already, but nothing about rendering this page may ever
  // depend on that promise settling.
  void sendConnectBindConfirmation({
    chatIdentityId: identity.id,
    decision,
    accountLabel,
    ownerElectCompletion,
  }).catch(() => {});

  const ownerElectCompletionLine = buildOwnerElectCompletionLine(ownerElectCompletion);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        gap: "0.75rem",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem" }}>You&apos;re connected</h1>
      <p style={{ color: "#666", maxWidth: "40ch" }}>
        {accountLabel} is now linked
        {decision.workspaceDecision.action === "bind"
          ? ` to ${decision.workspaceDecision.workspace.name}`
          : ""}
        . Jace will confirm in the chat.
      </p>
      {ownerElectCompletionLine ? (
        <p style={{ color: "#666", maxWidth: "40ch" }}>{ownerElectCompletionLine}</p>
      ) : null}
    </main>
  );
}

function ConnectMessage({ title, body }: { title: string; body: string }) {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        gap: "0.75rem",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem" }}>{title}</h1>
      <p style={{ color: "#666", maxWidth: "40ch" }}>{body}</p>
    </main>
  );
}
