"use client";

import { useState } from "react";
import { X, Plus } from "lucide-react";

export interface InvitedMember {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  token: string;
  createdAt: string;
}

interface ApiInvite {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  token: string;
  created_at: string;
}

interface InviteMemberDialogProps {
  workspaceId: string;
  onInvited: (invite: InvitedMember) => void;
  onClose: () => void;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function InviteMemberDialog({
  workspaceId,
  onInvited,
  onClose,
}: InviteMemberDialogProps) {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");
    setFormError("");

    const trimmed = email.trim();
    if (!trimmed) {
      setEmailError("Email is required.");
      return;
    }
    if (!isValidEmail(trimmed)) {
      setEmailError("Invalid email address.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string } | string;
        };
        const msg =
          typeof body?.error === "object"
            ? body.error?.message
            : typeof body?.error === "string"
            ? body.error
            : undefined;
        setFormError(msg ?? `Failed to send invite (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { invite: ApiInvite };
      onInvited({
        id: data.invite.id,
        email: data.invite.email,
        role: data.invite.role,
        token: data.invite.token,
        createdAt: data.invite.created_at,
      });
      onClose();
    } catch {
      setFormError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-md rounded bg-[var(--gray-02)] border border-[var(--gray-05)] p-6"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-4">
          Invite a workspace member
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--gray-10)]" htmlFor="invite-email">
              Email
            </label>
            <input
              id="invite-email"
              type="text"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError("");
              }}
              placeholder="name@example.com"
              className={[
                "h-8 rounded bg-[var(--gray-01)] border px-3 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)] transition-colors duration-150",
                emailError
                  ? "border-[var(--red-09)]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
              autoFocus
            />
            {emailError && <p className="text-xs text-[var(--red-11)]">{emailError}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--gray-10)]" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "admin")}
              className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-3 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)] transition-colors duration-150"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          {formError && <p className="text-xs text-[var(--red-11)]">{formError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex h-8 items-center gap-1.5 rounded bg-[var(--yellow-09)] px-4 text-sm font-medium text-black transition-colors hover:bg-[var(--yellow-09-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={14} />
              {submitting ? "Sending…" : "Send invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
