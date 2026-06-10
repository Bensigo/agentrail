"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { Copy, Trash2, Plus } from "lucide-react";
import { SkeletonTable } from "../../../../components/loading-skeleton";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

interface PendingInvite {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  token: string;
  createdAt: string;
}

interface CurrentMember {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
}

// ─── API response shapes (snake_case, as returned by the route handlers) ────────

interface MembersApiResponse {
  caller_role: "owner" | "admin" | "member";
  caller_user_id: string;
  members: Array<{
    user_id: string;
    name: string | null;
    email: string | null;
    role: "owner" | "admin" | "member";
    joined_at: string;
  }>;
}

interface ApiInvite {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  token: string;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MembersPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params.workspaceId;

  // Members state
  const [members, setMembers] = useState<Member[]>([]);
  const [currentMember, setCurrentMember] = useState<CurrentMember | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState("");

  // Invites state
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError] = useState("");

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteEmailError, setInviteEmailError] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteFormError, setInviteFormError] = useState("");

  // Revoke state
  const [revoking, setRevoking] = useState<string | null>(null);

  // Copy state (tracks which invite id just got copied)
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError("");
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/members`);
      if (!res.ok) {
        setMembersError(`Failed to load members (${res.status}).`);
        return;
      }
      const data = await res.json() as MembersApiResponse;
      const rows = data.members ?? [];
      setMembers(
        rows.map((m) => ({
          id: m.user_id,
          email: m.email ?? "",
          name: m.name ?? "",
          role: m.role,
          joinedAt: m.joined_at,
        }))
      );
      const me = rows.find((m) => m.user_id === data.caller_user_id);
      setCurrentMember({
        id: data.caller_user_id,
        email: me?.email ?? "",
        name: me?.name ?? "",
        role: data.caller_role,
      });
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
      const data = await res.json() as { invites: ApiInvite[] };
      setInvites(
        (data.invites ?? []).map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          token: i.token,
          createdAt: i.created_at,
        }))
      );
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

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInviteEmailError("");
    setInviteFormError("");

    const email = inviteEmail.trim();
    if (!email) {
      setInviteEmailError("Email is required.");
      return;
    }
    if (!isValidEmail(email)) {
      setInviteEmailError("Invalid email address.");
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
        const body = await res.json().catch(() => ({})) as { error?: { message?: string } | string };
        const msg =
          typeof body?.error === "object"
            ? body.error?.message
            : typeof body?.error === "string"
            ? body.error
            : undefined;
        setInviteFormError(msg ?? `Failed to send invite (${res.status}).`);
        return;
      }
      const data = await res.json() as { invite: ApiInvite };
      const newInvite: PendingInvite = {
        id: data.invite.id,
        email: data.invite.email,
        role: data.invite.role,
        token: data.invite.token,
        createdAt: data.invite.created_at,
      };
      setInvites((prev) => [newInvite, ...prev]);
      setInviteEmail("");
    } catch {
      setInviteFormError("Network error. Please try again.");
    } finally {
      setInviteSubmitting(false);
    }
  }

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
      // Silent — row stays; user can retry
    } finally {
      setRevoking(null);
    }
  }

  function handleCopyLink(invite: PendingInvite) {
    const url = `${window.location.origin}/invite/${invite.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  const isAdmin = currentMember ? canManage(currentMember.role) : false;

  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      {/* ── Members ── */}
      <section>
        <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Members</h1>

        {membersLoading && <SkeletonTable columns={4} rows={5} />}

        {!membersLoading && membersError && (
          <div className="rounded border border-[#e5484d]/30 bg-[#e5484d]/10 px-4 py-3 text-sm text-[#ff9592]">
            {membersError}
          </div>
        )}

        {!membersLoading && !membersError && members.length === 0 && (
          <div className="py-10 text-center text-sm text-[var(--gray-09)]">
            No workspace members yet.
          </div>
        )}

        {!membersLoading && !membersError && members.length > 0 && (
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
                {members.map((m) => {
                  const isYou = currentMember?.id === m.id;
                  return (
                    <tr
                      key={m.id}
                      className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                      style={{ height: "36px" }}
                    >
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-12)]">
                          {m.email}
                        </span>
                        {isYou && (
                          <span className="ml-1.5 text-xs text-[var(--gray-09)]">(you)</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-xs text-[var(--gray-11)]">{m.name || "—"}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <RoleBadge role={m.role} />
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-10)]">
                          {formatDate(m.joinedAt)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Pending invites ── */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--gray-12)]">Pending invites</h2>
        </div>

        {invitesLoading && <SkeletonTable columns={4} rows={3} />}

        {!invitesLoading && invitesError && (
          <div className="rounded border border-[#e5484d]/30 bg-[#e5484d]/10 px-4 py-3 text-sm text-[#ff9592]">
            {invitesError}
          </div>
        )}

        {!invitesLoading && !invitesError && invites.length === 0 && (
          <div className="py-8 text-center text-sm text-[var(--gray-09)]">
            No pending invites.
          </div>
        )}

        {!invitesLoading && !invitesError && invites.length > 0 && (
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
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Accept link
                  </th>
                  {isAdmin && (
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                    style={{ height: "36px" }}
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs text-[var(--gray-12)]">{inv.email}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <RoleBadge role={inv.role} />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs text-[var(--gray-10)]">
                        {formatDate(inv.createdAt)}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        onClick={() => handleCopyLink(inv)}
                        className="flex h-7 items-center gap-1.5 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-2.5 text-xs text-[var(--gray-12)] transition-colors hover:border-[var(--gray-08)]"
                        title={`Copy accept link for ${inv.email}`}
                      >
                        <Copy size={12} />
                        {copiedId === inv.id ? "Copied!" : "Copy link"}
                      </button>
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-1.5">
                        <button
                          onClick={() => handleRevoke(inv.id)}
                          disabled={revoking === inv.id}
                          className="flex h-7 items-center gap-1.5 rounded border border-[#e5484d]/30 bg-[var(--gray-03)] px-2.5 text-xs text-[#ff9592] transition-colors hover:border-[#e5484d]/50 disabled:cursor-not-allowed disabled:opacity-50"
                          title={`Revoke invite for ${inv.email}`}
                        >
                          <Trash2 size={12} />
                          {revoking === inv.id ? "Revoking…" : "Revoke"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Invite form (owner/admin only) ── */}
      {isAdmin && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Invite a workspace member</h2>
          <form
            onSubmit={handleInviteSubmit}
            className="flex flex-wrap items-start gap-3"
          >
            <div className="flex flex-col gap-1">
              <input
                type="text"
                value={inviteEmail}
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                  setInviteEmailError("");
                }}
                placeholder="name@example.com"
                className={[
                  "h-8 w-64 rounded border bg-[var(--gray-02)] px-3 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                  "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] transition-colors duration-150",
                  inviteEmailError
                    ? "border-[#e5484d]"
                    : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
                ].join(" ")}
              />
              {inviteEmailError && (
                <span className="text-xs text-[#ff9592]">{inviteEmailError}</span>
              )}
            </div>

            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
              className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] transition-colors duration-150"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>

            <button
              type="submit"
              disabled={inviteSubmitting}
              className="flex h-8 items-center gap-1.5 rounded bg-[#ffe629] px-3 text-sm font-medium text-black transition-colors hover:bg-[#ffdc00] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={14} />
              {inviteSubmitting ? "Sending…" : "Send invite"}
            </button>

            {inviteFormError && (
              <span className="w-full text-xs text-[#ff9592]">{inviteFormError}</span>
            )}
          </form>
        </section>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    owner:
      "bg-[#6e56cf]/20 border-[#6e56cf]/30 text-[#baa7ff]",
    admin:
      "bg-[#0090ff]/20 border-[#0090ff]/30 text-[#70b8ff]",
    member:
      "bg-[var(--gray-04)] border-[var(--gray-06)] text-[var(--gray-11)]",
  };
  return (
    <span
      className={[
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium",
        styles[role] ?? styles.member,
      ].join(" ")}
    >
      {role}
    </span>
  );
}
