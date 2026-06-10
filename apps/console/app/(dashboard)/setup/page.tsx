"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldError {
  field: string;
  message: string;
}

interface EmailChip {
  email: string;
  invalid: boolean;
}

export default function SetupPage() {
  const router = useRouter();

  // Step 1: create workspace
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; general?: string }>({});

  // Step 2: invite team
  const [step, setStep] = useState<1 | 2>(1);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(toSlug(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlug(value);
    setSlugEdited(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setSubmitting(true);

    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });

      const data = await res.json() as
        | { id: string; name: string; slug: string }
        | { error: { code: string; field?: string; message: string } | string };

      if (!res.ok) {
        if (typeof data === "object" && "error" in data && typeof data.error === "object" && data.error !== null && "field" in data.error) {
          const err = data.error as FieldError;
          if (err.field === "name") {
            setErrors({ name: err.message });
          } else if (err.field === "slug") {
            setErrors({ slug: err.message });
          } else {
            setErrors({ general: err.message });
          }
        } else {
          setErrors({ general: "Something went wrong. Please try again." });
        }
        return;
      }

      const workspace = data as { id: string; name: string; slug: string };
      setWorkspaceId(workspace.id);
      setStep(2);
    } catch {
      setErrors({ general: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  function commitEmailInput() {
    const raw = emailInput.trim();
    if (!raw) return;
    const emails = raw.split(/[\s,;]+/).filter(Boolean);
    const newChips: EmailChip[] = emails.map((email) => ({
      email,
      invalid: !EMAIL_RE.test(email),
    }));
    setChips((prev) => [...prev, ...newChips]);
    setEmailInput("");
  }

  function handleEmailKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === "Tab") {
      e.preventDefault();
      commitEmailInput();
    } else if (e.key === "Backspace" && emailInput === "" && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
    }
  }

  function removeChip(index: number) {
    setChips((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSendInvites() {
    commitEmailInput();
    const currentChips = chips.concat(
      emailInput.trim()
        ? emailInput
            .trim()
            .split(/[\s,;]+/)
            .filter(Boolean)
            .map((email) => ({ email, invalid: !EMAIL_RE.test(email) }))
        : []
    );
    setEmailInput("");

    const validChips = currentChips.filter((c) => !c.invalid);
    if (validChips.length === 0) {
      router.push(`/dashboard/${workspaceId}`);
      return;
    }

    setInviting(true);
    setInviteError(null);

    let failCount = 0;
    for (const chip of validChips) {
      try {
        const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: chip.email, role }),
        });
        if (!res.ok) failCount++;
      } catch {
        failCount++;
      }
    }

    setInviting(false);

    if (failCount > 0 && failCount < validChips.length) {
      setInviteError(
        `${validChips.length - failCount} of ${validChips.length} invites sent. Continuing anyway.`
      );
      setTimeout(() => router.push(`/dashboard/${workspaceId}`), 1500);
    } else if (failCount === validChips.length && validChips.length > 0) {
      setInviteError("All invites failed. You can retry or skip.");
    } else {
      router.push(`/dashboard/${workspaceId}`);
    }
  }

  function handleSkip() {
    router.push(`/dashboard/${workspaceId}`);
  }

  // ── Step 1: Create workspace ──────────────────────────────────────────────
  if (step === 1) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ffe629] text-xs font-bold text-black">
              1
            </span>
            <span className="text-xs text-[var(--gray-09)]">
              Step 1 of 2 — Create workspace
            </span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
            Create a workspace
          </h1>
          <p className="mt-2 text-sm text-[var(--gray-09)]">
            Create your first workspace to get started.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div>
              <label
                htmlFor="name"
                className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
              >
                Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My workspace"
                maxLength={80}
                autoFocus
                className={[
                  "mt-1.5 block w-full rounded border bg-[var(--gray-02)] px-3 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                  "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]",
                  "transition-colors duration-150",
                  errors.name
                    ? "border-[#e5484d]"
                    : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
                ].join(" ")}
              />
              {errors.name && (
                <p className="mt-1 text-xs text-[#ff9592]">{errors.name}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="slug"
                className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
              >
                Slug
              </label>
              <input
                id="slug"
                type="text"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="my-workspace"
                className={[
                  "mt-1.5 block w-full rounded border bg-[var(--gray-02)] px-3 py-2 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                  "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]",
                  "transition-colors duration-150",
                  errors.slug
                    ? "border-[#e5484d]"
                    : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
                ].join(" ")}
              />
              <p className="mt-1 text-xs text-[var(--gray-09)]">
                Lowercase letters, digits, and hyphens only. 2–32 characters.
              </p>
              {errors.slug && (
                <p className="mt-1 text-xs text-[#ff9592]">{errors.slug}</p>
              )}
            </div>

            {errors.general && (
              <p className="text-xs text-[#ff9592]">{errors.general}</p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded bg-[#ffe629] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create workspace"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Step 2: Invite team ───────────────────────────────────────────────────
  const hasInvalidChips = chips.some((c) => c.invalid);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-09)]">
            1
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ffe629] text-xs font-bold text-black">
            2
          </span>
          <span className="text-xs text-[var(--gray-09)]">
            Step 2 of 2 — Invite your team
          </span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
          Invite your team
        </h1>
        <p className="mt-2 text-sm text-[var(--gray-09)]">
          Optional. Add workspace members now or skip and invite later.
        </p>

        <div className="mt-8 space-y-5">
          {/* Email chips input */}
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Email addresses
            </label>
            <div
              className={[
                "mt-1.5 min-h-[40px] w-full rounded border bg-[var(--gray-02)] px-2 py-1.5",
                "focus-within:ring-2 focus-within:ring-[#ffe629] focus-within:ring-offset-2 focus-within:ring-offset-[var(--gray-00)]",
                "transition-colors duration-150",
                hasInvalidChips
                  ? "border-[#e5484d]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
            >
              <div className="flex flex-wrap gap-1">
                {chips.map((chip, i) => (
                  <span
                    key={i}
                    className={[
                      "flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs",
                      chip.invalid
                        ? "bg-[#3b1212] text-[#ff9592]"
                        : "bg-[var(--gray-04)] text-[var(--gray-12)]",
                    ].join(" ")}
                  >
                    {chip.email}
                    <button
                      type="button"
                      onClick={() => removeChip(i)}
                      className="ml-0.5 opacity-60 hover:opacity-100"
                      aria-label={`Remove ${chip.email}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={handleEmailKeyDown}
                  onBlur={commitEmailInput}
                  placeholder={chips.length === 0 ? "alice@example.com, bob@example.com" : ""}
                  className="flex-1 min-w-[160px] bg-transparent text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none"
                />
              </div>
            </div>
            {hasInvalidChips && (
              <p className="mt-1 text-xs text-[#ff9592]">
                Invalid email addresses are highlighted. Remove or fix them before sending.
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--gray-09)]">
              Separate multiple addresses with comma, space, or Enter.
            </p>
          </div>

          {/* Role selector */}
          <div>
            <label
              htmlFor="invite-role"
              className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
            >
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "admin")}
              className="mt-1.5 block w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] hover:border-[var(--gray-08)] transition-colors duration-150"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <p className="mt-1 text-xs text-[var(--gray-09)]">
              Owner role cannot be granted via invite.
            </p>
          </div>

          {inviteError && (
            <p className="text-xs text-[#ff9592]">{inviteError}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleSendInvites}
              disabled={inviting || hasInvalidChips}
              className="flex-1 rounded bg-[#ffe629] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inviting ? "Sending…" : "Send invites"}
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={inviting}
              className="flex-1 rounded border border-[var(--gray-05)] bg-[var(--gray-03)] px-4 py-2 text-sm font-medium text-[var(--gray-12)] transition-colors duration-150 hover:border-[var(--gray-08)] hover:bg-[var(--gray-04)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
