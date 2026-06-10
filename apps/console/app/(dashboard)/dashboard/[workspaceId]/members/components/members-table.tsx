"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";

export interface MemberRow {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  joined_at: string;
}

interface MembersTableProps {
  workspaceId: string;
  initialMembers: MemberRow[];
  currentUserId: string | null;
  canAdd: boolean;
  callerRole: string | null;
}

function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    owner:
      "bg-[#ffe629]/20 text-[#ffe629] border border-[#ffe629]/30",
    admin:
      "bg-[#6e56cf]/20 text-[#baa7ff] border border-[#6e56cf]/30",
    member:
      "bg-[var(--gray-04)] text-[var(--gray-11)] border border-[var(--gray-06)]",
    viewer:
      "bg-[var(--gray-03)] text-[var(--gray-09)] border border-[var(--gray-05)]",
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${styles[role] ?? styles.member}`}
    >
      {role}
    </span>
  );
}

interface AddMemberFormProps {
  workspaceId: string;
  callerRole: string | null;
  onAdded: (member: MemberRow) => void;
}

function AddMemberForm({ workspaceId, callerRole, onAdded }: AddMemberFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.message) {
          setError(data.message);
        } else if (data.error === "already_member") {
          setError("This user is already a workspace member.");
        } else {
          setError(data.error ?? "Failed to add member.");
        }
        return;
      }

      onAdded(data.member as MemberRow);
      setEmail("");
      setRole("member");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        Add workspace member
      </p>
      <div className="flex items-center gap-2">
        <input
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="h-8 flex-1 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "member" | "admin")}
          className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
        >
          <option value="member">member</option>
          {callerRole === "owner" && <option value="admin">admin</option>}
        </select>
        <button
          type="submit"
          disabled={loading}
          className="flex h-8 items-center gap-1.5 rounded bg-[#ffe629] px-3 text-sm font-medium text-black transition-colors hover:bg-[#ffdc00] disabled:opacity-50"
        >
          <UserPlus size={14} />
          {loading ? "Adding…" : "Add"}
        </button>
      </div>
      {error && (
        <p className="text-xs text-[#ff9592]">{error}</p>
      )}
    </form>
  );
}

export function MembersTable({
  workspaceId,
  initialMembers,
  currentUserId,
  canAdd,
  callerRole,
}: MembersTableProps) {
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);

  function handleAdded(newMember: MemberRow) {
    setMembers((prev) => [newMember, ...prev]);
  }

  return (
    <div className="flex flex-col gap-3">
      {canAdd && (
        <AddMemberForm
          workspaceId={workspaceId}
          callerRole={callerRole}
          onAdded={handleAdded}
        />
      )}

      {members.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-sm text-[var(--gray-09)]">
          Only you so far. Add a teammate by email.
        </div>
      ) : (
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
                const isYou = m.user_id === currentUserId;
                return (
                  <tr
                    key={m.user_id}
                    className="border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                    style={{ height: "36px" }}
                  >
                    <td className="px-3 py-1.5">
                      <code className="font-mono text-xs text-[var(--gray-12)]">
                        {m.email ?? "—"}
                      </code>
                      {isYou && (
                        <span className="ml-2 text-xs text-[var(--gray-09)]">(you)</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="text-xs text-[var(--gray-11)]">
                        {m.name ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <RoleBadge role={m.role} />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs text-[var(--gray-10)]">
                        {new Date(m.joined_at).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "2-digit",
                        })}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
