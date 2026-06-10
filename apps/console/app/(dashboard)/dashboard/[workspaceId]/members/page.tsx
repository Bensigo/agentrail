"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Copy, Trash2 } from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type MemberRole = "owner" | "admin" | "member";
type InviteRole = "member" | "admin";

interface WorkspaceMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  joinedAt: string;
}

interface PendingInvite {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  createdAt: string;
}

function RoleBadge({ role }: { role: MemberRole | InviteRole }) {
  const styles: Record<string, string> = {
    owner: "bg-[#2a1a3a] text-[#c084fc]",
    admin: "bg-[#1a2a3a] text-[#60a5fa]",
    member: "bg-[var(--gray-03)] text-[var(--gray-10)]",
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${styles[role] ?? styles.member}`}>
      {role}
    </span>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

export default function MembersPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params.workspaceId;

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState("");

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError] = useState("");

  const [callerUserId, setCallerUserId] = useState("");
  const [callerRole, setCallerRole] = useState<MemberRole | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [inviteError, setInviteError] = useState("");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);

  // Revoke state
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError("");
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/members`);
      if (!res.ok) {
        setMembersError(`Failed to load members (${res.status}).`);
        return;
      }
      const data = await res.json() as { members: WorkspaceMember[]; currentUserId?: string };
      setMembers(data.members ?? []);
      if (data.currentUserId) setCallerUserId(data.currentUserId);
      // Determine caller's role from the member list
      const me = (data.members ?? []).find((m: WorkspaceMember) => m.userId === data.currentUserId);
      if (me) setCallerRole(me.role);
    } catch {
      setMembersError("Network error loading members.");
    } finally {
      setMembersLoading(false);
    }
  }, [workspaceId]);

  const fetchInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError("");
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`);
      if (!res.ok) {
        setInvitesError(`Failed to load pending invites (${res.status}).`);
        return;
      }
      const data = await res.json() as { invites: PendingInvite[] };
      setInvites(data.invites ?? []);
    } catch {
      setInvitesError("Network error loading invites.");
    } finally {
      setInvitesLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchMembers();
    fetchInvites();
  }, [fetchMembers, fetchInvites]);

  async function handleRevoke(inviteId: string) {
    setRevoking(inviteId);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites/${inviteId}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 404) {
        setInvites((prev) => prev.filter((inv) => inv.id !== inviteId));
      }
    } catch {
      // silently ignore — row stays in place
    } finally {
      setRevoking(null);
    }
  }

  function handleCopyLink(token: string) {
    const link = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopyFeedback(token);
      setTimeout(() => setCopyFeedback(null), 2000);
    }).catch(() => {
      // fallback: show link in alert
      window.prompt("Copy invite link:", link);
    });
  }

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInviteError("");
    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setInviteError("Enter a valid email address.");
      return;
    }
    setInviteSubmitting(true);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setInviteError(typeof body.error === "string" ? body.error : `Request failed (${res.status}).`);
        return;
      }
      const body = await res.json() as { invite?: PendingInvite };
      if (body.invite) {
        setInvites((prev) => [...prev, body.invite!]);
      } else {
        // Re-fetch to pick up the new invite
        fetchInvites();
      }
      setInviteEmail("");
    } catch {
      setInviteError("Network error. Please try again.");
    } finally {
      setInviteSubmitting(false);
    }
  }

  const canManage = callerRole === "owner" || callerRole === "admin";

  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      {/* Members section */}
      <section>
        <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Members</h1>

        {membersLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
            ))}
          </div>
        ) : membersError ? (
          <div className="rounded border border-[#e5484d33] bg-[#3a1a1a] px-4 py-3 text-sm text-[#ff9592]">
            {membersError}
          </div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-sm text-[var(--gray-09)]">
            No workspace members yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded border border-[var(--gray-05)]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Email</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Name</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Role</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isYou = member.userId === callerUserId;
                  return (
                    <tr
                      key={member.id}
                      className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                      style={{ height: "34px" }}
                    >
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-12)]">{member.email}</span>
                        {isYou && (
                          <span className="ml-2 text-xs text-[var(--gray-08)]">(you)</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-xs text-[var(--gray-11)]">{member.name ?? "—"}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <RoleBadge role={member.role} />
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-09)]">{formatDate(member.joinedAt)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending invites section */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Pending invites</h2>

        {invitesLoading ? (
          <div className="space-y-2">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
            ))}
          </div>
        ) : invitesError ? (
          <div className="rounded border border-[#e5484d33] bg-[#3a1a1a] px-4 py-3 text-sm text-[#ff9592]">
            {invitesError}
          </div>
        ) : invites.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-sm text-[var(--gray-09)]">
            No pending invites.
          </div>
        ) : (
          <div className="overflow-hidden rounded border border-[var(--gray-05)]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Email</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Role</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Sent</th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                    style={{ height: "34px" }}
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs text-[var(--gray-12)]">{inv.email}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <RoleBadge role={inv.role} />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs text-[var(--gray-09)]">{formatDate(inv.createdAt)}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleCopyLink(inv.token)}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--gray-09)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
                          title="Copy accept link"
                        >
                          <Copy className="h-3 w-3" />
                          {copyFeedback === inv.token ? "Copied!" : "Copy link"}
                        </button>
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => handleRevoke(inv.id)}
                            disabled={revoking === inv.id}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[#ff9592] transition-colors hover:bg-[#3a1a1a] disabled:opacity-50"
                            title="Revoke invite"
                          >
                            <Trash2 className="h-3 w-3" />
                            {revoking === inv.id ? "Revoking…" : "Revoke"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Invite form — owner/admin only */}
      {canManage && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Invite a workspace member</h2>
          <form
            onSubmit={handleInviteSubmit}
            className="flex flex-wrap items-end gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-4"
          >
            <div className="flex-1 min-w-[200px]">
              <label
                htmlFor="new-invite-email"
                className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
              >
                Email
              </label>
              <input
                id="new-invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => { setInviteEmail(e.target.value); setInviteError(""); }}
                placeholder="name@example.com"
                className={[
                  "mt-1.5 block w-full rounded border bg-[var(--gray-02)] px-3 py-2 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                  "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] transition-colors duration-150",
                  inviteError ? "border-[#e5484d]" : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
                ].join(" ")}
              />
              {inviteError && (
                <p className="mt-1 text-xs text-[#ff9592]">{inviteError}</p>
              )}
            </div>
            <div>
              <label
                htmlFor="new-invite-role"
                className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
              >
                Role
              </label>
              <select
                id="new-invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                className="mt-1.5 block rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={inviteSubmitting}
              className="rounded bg-[#ffe629] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inviteSubmitting ? "Inviting…" : "Send invite"}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
