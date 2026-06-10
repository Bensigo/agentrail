"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Copy, Trash2 } from "lucide-react";

interface WorkspaceMember {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  joinedAt: string;
  userId: string;
}

interface PendingInvite {
  id: string;
  email: string;
  role: "admin" | "member";
  token: string;
  createdAt: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function MembersPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params.workspaceId;

  // Members state
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);

  // Invites state
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError] = useState<string | null>(null);

  // Current user session
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);

  // Caller role (derived from members list)
  const [callerRole, setCallerRole] = useState<"owner" | "admin" | "member" | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);

  // Revoke state
  const [revoking, setRevoking] = useState<string | null>(null);

  // Copied state
  const [copied, setCopied] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/members`);
      if (!res.ok) {
        if (res.status === 404) {
          setMembers([]);
        } else {
          setMembersError(`Failed to load members (${res.status})`);
        }
        return;
      }
      const data = await res.json() as { members?: WorkspaceMember[] } | WorkspaceMember[];
      const list = Array.isArray(data) ? data : (data.members ?? []);
      setMembers(list);
    } catch {
      setMembersError("Network error loading members.");
    } finally {
      setMembersLoading(false);
    }
  }, [workspaceId]);

  const fetchInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`);
      if (!res.ok) {
        if (res.status === 404) {
          setInvites([]);
        } else {
          setInvitesError(`Failed to load invites (${res.status})`);
        }
        return;
      }
      const data = await res.json() as { invites?: PendingInvite[] } | PendingInvite[];
      const list = Array.isArray(data) ? data : (data.invites ?? []);
      setInvites(list);
    } catch {
      setInvitesError("Network error loading invites.");
    } finally {
      setInvitesLoading(false);
    }
  }, [workspaceId]);

  // Fetch current session email
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.ok ? r.json() : null)
      .then((s) => {
        if (s?.user?.email) setCurrentEmail(s.user.email);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetchMembers();
    fetchInvites();
  }, [fetchMembers, fetchInvites]);

  // Derive caller role after members + session are loaded
  useEffect(() => {
    if (currentEmail && members.length > 0) {
      const self = members.find((m) => m.email === currentEmail);
      setCallerRole(self?.role ?? "member");
    } else if (!membersLoading && members.length === 0) {
      setCallerRole("member");
    }
  }, [currentEmail, members, membersLoading]);

  const isPrivileged = callerRole === "owner" || callerRole === "admin";

  async function handleRevoke(inviteId: string) {
    setRevoking(inviteId);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/invites/${inviteId}`,
        { method: "DELETE" }
      );
      if (res.ok || res.status === 404) {
        setInvites((prev) => prev.filter((i) => i.id !== inviteId));
      } else {
        setInvitesError(`Failed to revoke invite (${res.status})`);
      }
    } catch {
      setInvitesError("Network error revoking invite.");
    } finally {
      setRevoking(null);
    }
  }

  function handleCopyLink(token: string) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    navigator.clipboard.writeText(`${origin}/invite/${token}`).then(() => {
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInviteEmailError(null);
    setInviteError(null);

    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setInviteEmailError("Enter a valid email address.");
      return;
    }

    setInviteSubmitting(true);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });

      if (res.ok || res.status === 201) {
        const newInvite = await res.json() as PendingInvite;
        setInvites((prev) => [newInvite, ...prev]);
        setInviteEmail("");
        setInviteRole("member");
      } else if (res.status === 404) {
        // API not yet available; show informational message
        setInviteError("Invite API not available yet. Try again once the backend is deployed.");
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string | { message?: string } };
        const msg =
          typeof body.error === "string"
            ? body.error
            : body.error?.message ?? `Failed to send invite (${res.status})`;
        setInviteError(msg);
      }
    } catch {
      setInviteError("Network error sending invite.");
    } finally {
      setInviteSubmitting(false);
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderMembersSection() {
    if (membersLoading) {
      return (
        <div className="space-y-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
          ))}
        </div>
      );
    }

    if (membersError) {
      return (
        <div className="rounded border border-[#e5484d]/30 bg-[#3b1212] px-4 py-3 text-xs text-[#ff9592]">
          {membersError}
        </div>
      );
    }

    if (members.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-sm text-[var(--gray-09)]">
          No workspace members yet.
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded border border-[var(--gray-05)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Email
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Name
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Role
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isYou = currentEmail && member.email === currentEmail;
              return (
                <tr
                  key={member.id}
                  className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-12)]">
                      {member.email}
                    </span>
                    {isYou && (
                      <span className="ml-2 text-xs text-[var(--gray-09)]">(you)</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="text-xs text-[var(--gray-11)]">
                      {member.name ?? <span className="text-[var(--gray-08)]">—</span>}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={[
                        "rounded-sm px-1.5 py-0.5 text-xs font-medium",
                        member.role === "owner"
                          ? "bg-[#2d1f00] text-[#ffa057]"
                          : member.role === "admin"
                          ? "bg-[#1a1f3a] text-[#70b8ff]"
                          : "bg-[var(--gray-04)] text-[var(--gray-11)]",
                      ].join(" ")}
                    >
                      {member.role}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-09)]">
                      {formatDate(member.joinedAt)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderPendingInvitesSection() {
    if (invitesLoading) {
      return (
        <div className="space-y-2">
          {[1, 2].map((n) => (
            <div key={n} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
          ))}
        </div>
      );
    }

    if (invitesError) {
      return (
        <div className="rounded border border-[#e5484d]/30 bg-[#3b1212] px-4 py-3 text-xs text-[#ff9592]">
          {invitesError}
        </div>
      );
    }

    if (invites.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-8 text-sm text-[var(--gray-09)]">
          No pending invites.
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded border border-[var(--gray-05)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Email
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Role
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Sent
              </th>
              {isPrivileged && (
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr
                key={invite.id}
                className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                style={{ height: "34px" }}
              >
                <td className="px-3 py-1.5">
                  <span className="font-mono text-xs text-[var(--gray-12)]">
                    {invite.email}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className={[
                      "rounded-sm px-1.5 py-0.5 text-xs font-medium",
                      invite.role === "admin"
                        ? "bg-[#1a1f3a] text-[#70b8ff]"
                        : "bg-[var(--gray-04)] text-[var(--gray-11)]",
                    ].join(" ")}
                  >
                    {invite.role}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <span className="font-mono text-xs text-[var(--gray-09)]">
                    {formatDate(invite.createdAt)}
                  </span>
                </td>
                {isPrivileged && (
                  <td className="px-3 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopyLink(invite.token)}
                        title="Copy invite link"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--gray-09)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
                      >
                        <Copy className="h-3 w-3" />
                        {copied === invite.token ? "Copied!" : "Copy link"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRevoke(invite.id)}
                        disabled={revoking === invite.id}
                        title="Revoke invite"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[#ff9592] transition-colors hover:bg-[#3b1212] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        {revoking === invite.id ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderInviteForm() {
    if (!isPrivileged) return null;

    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--gray-09)]">
          Send invite
        </h3>
        <form onSubmit={handleInviteSubmit} className="flex items-start gap-3">
          <div className="flex-1">
            <input
              type="text"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value);
                setInviteEmailError(null);
              }}
              placeholder="email@example.com"
              className={[
                "block w-full rounded border bg-[var(--gray-01)] px-3 py-1.5 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]",
                "transition-colors duration-150",
                inviteEmailError
                  ? "border-[#e5484d]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
            />
            {inviteEmailError && (
              <p className="mt-1 text-xs text-[#ff9592]">{inviteEmailError}</p>
            )}
          </div>
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
            className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 py-1.5 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)] hover:border-[var(--gray-08)] transition-colors duration-150"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            disabled={inviteSubmitting}
            className="rounded bg-[#ffe629] px-3 py-1.5 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)] disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
          >
            {inviteSubmitting ? "Sending…" : "Send invite"}
          </button>
        </form>
        {inviteError && (
          <p className="mt-2 text-xs text-[#ff9592]">{inviteError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      {/* Members section */}
      <section>
        <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Members</h1>
        {renderMembersSection()}
      </section>

      {/* Pending invites section */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Pending invites</h2>
        {renderPendingInvitesSection()}
      </section>

      {/* Invite form — owner/admin only */}
      {isPrivileged && (
        <section>
          {renderInviteForm()}
        </section>
      )}
    </div>
  );
}
