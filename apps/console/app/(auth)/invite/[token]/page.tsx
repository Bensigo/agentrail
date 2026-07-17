import { auth, signIn } from "@agentrail/auth";
import {
  getInviteByToken,
  getWorkspaceMembership,
  claimInvitesForUser,
} from "@agentrail/db-postgres";
import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
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
          You have been invited to join AgentRail
        </h1>
        <p style={{ color: "#666" }}>Sign in with GitHub to accept your invite.</p>
        <form
          action={async () => {
            "use server";
            await signIn("github", {
              redirectTo: `/invite/${token}`,
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

  const invite = await getInviteByToken(token);

  if (!invite) {
    return (
      <InviteMessage
        title="Invite not found"
        body="This invite link is invalid or has already been used."
      />
    );
  }

  const now = new Date();

  if (invite.status === "revoked") {
    return (
      <InviteMessage
        title="Invite revoked"
        body="This invite has been revoked by the workspace admin."
      />
    );
  }

  if (invite.status === "accepted") {
    redirect(`/dashboard/${invite.workspaceId}`);
  }

  if (invite.expiresAt < now) {
    return (
      <InviteMessage
        title="Invite expired"
        body="This invite link has expired. Please ask the workspace admin to send a new invite."
      />
    );
  }

  // Check if already a member
  const existing = await getWorkspaceMembership(
    session.user.id,
    invite.workspaceId
  );
  if (existing) {
    redirect(`/dashboard/${invite.workspaceId}`);
  }

  const email = (session.user as typeof session.user & { email?: string }).email;
  if (!email) {
    return (
      <InviteMessage
        title="No email on account"
        body="Your GitHub account has no public email. Please add one and try again."
      />
    );
  }

  // Claim the invite
  await claimInvitesForUser({ userId: session.user.id, email });

  // After claiming, verify the invite was accepted
  const refreshed = await getInviteByToken(token);
  if (refreshed?.status === "accepted") {
    redirect(`/dashboard/${invite.workspaceId}`);
  }

  // The email on the session doesn't match the invite email
  return (
    <InviteMessage
      title="Email mismatch"
      body="This invite was sent to a different email address. Sign in with the account that received the invite."
    />
  );
}

function InviteMessage({ title, body }: { title: string; body: string }) {
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
