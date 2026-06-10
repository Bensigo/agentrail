"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

type InviteRole = "member" | "admin";

interface ChipState {
  email: string;
  error?: string;
  status?: "sending" | "sent" | "failed";
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
  const [newWorkspaceId, setNewWorkspaceId] = useState("");
  const [chips, setChips] = useState<ChipState[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [inviting, setInviting] = useState(false);
  const [inviteGeneral, setInviteGeneral] = useState("");

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
      setNewWorkspaceId(workspace.id);
      setStep(2);
    } catch {
      setErrors({ general: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  // Email chip handling
  function addChip(raw: string) {
    const email = raw.trim();
    if (!email) return;
    const exists = chips.some((c) => c.email.toLowerCase() === email.toLowerCase());
    if (exists) {
      setEmailInput("");
      return;
    }
    const error = EMAIL_RE.test(email) ? undefined : "Invalid email address";
    setChips((prev) => [...prev, { email, error }]);
    setEmailInput("");
  }

  function removeChip(index: number) {
    setChips((prev) => prev.filter((_, i) => i !== index));
  }

  function handleEmailKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      addChip(emailInput);
    } else if (e.key === "Backspace" && emailInput === "" && chips.length > 0) {
      removeChip(chips.length - 1);
    }
  }

  function handleEmailBlur() {
    if (emailInput.trim()) {
      addChip(emailInput);
    }
  }

  async function handleSendInvites() {
    // Flush any remaining text in input
    const remaining = emailInput.trim();
    let allChips = chips;
    if (remaining) {
      const exists = allChips.some((c) => c.email.toLowerCase() === remaining.toLowerCase());
      if (!exists) {
        const error = EMAIL_RE.test(remaining) ? undefined : "Invalid email address";
        allChips = [...allChips, { email: remaining, error }];
        setChips(allChips);
        setEmailInput("");
      }
    }

    const validChips = allChips.filter((c) => !c.error);
    if (validChips.length === 0) {
      router.push(`/dashboard/${newWorkspaceId}`);
      return;
    }

    setInviting(true);
    setInviteGeneral("");

    // Mark all valid chips as "sending"
    setChips((prev) =>
      prev.map((c) => (!c.error ? { ...c, status: "sending" } : c))
    );

    const results = await Promise.allSettled(
      validChips.map(async (chip) => {
        const res = await fetch(`/api/v1/workspaces/${newWorkspaceId}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: chip.email, role: inviteRole }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(typeof body.error === "string" ? body.error : "Failed");
        }
        return chip.email;
      })
    );

    // Update chip statuses
    const statusMap: Record<string, "sent" | "failed"> = {};
    const errorMap: Record<string, string> = {};
    results.forEach((r, i) => {
      const email = validChips[i].email;
      if (r.status === "fulfilled") {
        statusMap[email] = "sent";
      } else {
        statusMap[email] = "failed";
        errorMap[email] = r.reason instanceof Error ? r.reason.message : "Failed";
      }
    });

    setChips((prev) =>
      prev.map((c) => {
        if (statusMap[c.email]) {
          return { ...c, status: statusMap[c.email], error: errorMap[c.email] };
        }
        return c;
      })
    );

    setInviting(false);
    router.push(`/dashboard/${newWorkspaceId}`);
  }

  function handleSkip() {
    router.push(`/dashboard/${newWorkspaceId}`);
  }

  if (step === 2) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
            Invite your team
          </h1>
          <p className="mt-2 text-sm text-[var(--gray-09)]">
            Add workspace members by email. This step is optional — you can invite people later from the Members page.
          </p>

          <div className="mt-8 space-y-5">
            {/* Email chips input */}
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Email addresses
              </label>
              <div
                className="mt-1.5 min-h-[44px] w-full cursor-text rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1.5 flex flex-wrap gap-1 focus-within:ring-2 focus-within:ring-[#ffe629] focus-within:ring-offset-2 focus-within:ring-offset-[var(--gray-00)]"
                onClick={() => {
                  const input = document.getElementById("email-chip-input");
                  if (input) input.focus();
                }}
              >
                {chips.map((chip, i) => (
                  <span
                    key={i}
                    className={[
                      "inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs",
                      chip.status === "sent"
                        ? "bg-[#1a3a1a] text-[#4ade80]"
                        : chip.error
                        ? "bg-[#3a1a1a] text-[#ff9592] border border-[#e5484d]"
                        : "bg-[var(--gray-04)] text-[var(--gray-12)]",
                    ].join(" ")}
                    title={chip.error}
                  >
                    {chip.email}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeChip(i); }}
                      className="ml-0.5 text-[var(--gray-08)] hover:text-[var(--gray-12)]"
                      aria-label={`Remove ${chip.email}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="email-chip-input"
                  type="text"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={handleEmailKeyDown}
                  onBlur={handleEmailBlur}
                  placeholder={chips.length === 0 ? "name@example.com, …" : ""}
                  className="min-w-[160px] flex-1 bg-transparent text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none"
                />
              </div>
              <p className="mt-1 text-xs text-[var(--gray-09)]">
                Press Enter, comma, or Space to add each address.
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
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                className="mt-1.5 block w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            {inviteGeneral && (
              <p className="text-xs text-[#ff9592]">{inviteGeneral}</p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleSendInvites}
                disabled={inviting}
                className="flex-1 rounded bg-[#ffe629] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {inviting ? "Sending…" : "Send invites"}
              </button>
              <button
                type="button"
                onClick={handleSkip}
                disabled={inviting}
                className="rounded border border-[var(--gray-05)] px-4 py-2 text-sm text-[var(--gray-09)] transition-colors duration-150 hover:border-[var(--gray-08)] hover:text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
      <div className="w-full max-w-md">
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
