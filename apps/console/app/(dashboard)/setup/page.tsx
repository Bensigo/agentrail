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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

interface FieldError {
  field: string;
  message: string;
}

interface EmailChip {
  email: string;
  error?: string;
}

export default function SetupPage() {
  const router = useRouter();

  // Step 1: create workspace
  const [step, setStep] = useState<"create" | "invite">("create");
  const [createdId, setCreatedId] = useState("");

  // Step 1 state
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; general?: string }>({});

  // Step 2 state
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [chipInput, setChipInput] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteGeneralError, setInviteGeneralError] = useState("");

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
      setCreatedId(workspace.id);
      setStep("invite");
    } catch {
      setErrors({ general: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  function addChip(raw: string) {
    const email = raw.trim();
    if (!email) return;
    if (chips.some((c) => c.email === email)) {
      setChipInput("");
      return;
    }
    if (!isValidEmail(email)) {
      setChips((prev) => [...prev, { email, error: "Invalid email" }]);
    } else {
      setChips((prev) => [...prev, { email }]);
    }
    setChipInput("");
  }

  function removeChip(idx: number) {
    setChips((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleChipKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addChip(chipInput);
    } else if (e.key === "Backspace" && chipInput === "") {
      setChips((prev) => prev.slice(0, -1));
    }
  }

  async function handleSendInvites(e: React.FormEvent) {
    e.preventDefault();
    setInviteGeneralError("");

    // Flush any pending input
    const pending = chipInput.trim();
    let finalChips = chips;
    if (pending) {
      const newChip: EmailChip = isValidEmail(pending)
        ? { email: pending }
        : { email: pending, error: "Invalid email" };
      finalChips = [...chips, newChip];
      setChips(finalChips);
      setChipInput("");
    }

    const valid = finalChips.filter((c) => !c.error);
    if (finalChips.length > 0 && valid.length === 0) {
      setInviteGeneralError("Fix invalid emails or skip to continue.");
      return;
    }

    if (valid.length === 0) {
      // No chips — treat same as skip
      router.push(`/dashboard/${createdId}`);
      return;
    }

    setInviting(true);
    for (const chip of valid) {
      try {
        await fetch(`/api/v1/workspaces/${createdId}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: chip.email, role: inviteRole }),
        });
      } catch {
        // Partial failures are acceptable
      }
    }
    setInviting(false);
    router.push(`/dashboard/${createdId}`);
  }

  function handleSkip() {
    router.push(`/dashboard/${createdId}`);
  }

  if (step === "invite") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
        <div className="w-full max-w-md">
          <div className="mb-1 flex items-center gap-2 text-xs text-[var(--gray-09)]">
            <span className="text-[var(--gray-07)]">Step 1</span>
            <span className="text-[var(--gray-06)]">/</span>
            <span className="text-[var(--gray-12)] font-medium">Step 2</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
            Invite your team
          </h1>
          <p className="mt-2 text-sm text-[var(--gray-09)]">
            Optional. Add workspace members by email. You can also do this later from the Members page.
          </p>

          <form onSubmit={handleSendInvites} className="mt-8 space-y-5">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Email addresses
              </label>
              <div
                className="mt-1.5 flex min-h-[64px] flex-wrap gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-2 focus-within:ring-2 focus-within:ring-[#ffe629] focus-within:ring-offset-2 focus-within:ring-offset-[var(--gray-00)] transition-colors duration-150"
              >
                {chips.map((chip, idx) => (
                  <span
                    key={idx}
                    className={[
                      "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-mono",
                      chip.error
                        ? "bg-[#e5484d]/20 border border-[#e5484d]/40 text-[#ff9592]"
                        : "bg-[var(--gray-04)] border border-[var(--gray-06)] text-[var(--gray-12)]",
                    ].join(" ")}
                    title={chip.error}
                  >
                    {chip.email}
                    {chip.error && (
                      <span className="mr-0.5 text-[10px] text-[#ff9592]" title={chip.error}>!</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeChip(idx)}
                      className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                      aria-label={`Remove ${chip.email}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={chipInput}
                  onChange={(e) => setChipInput(e.target.value)}
                  onKeyDown={handleChipKeyDown}
                  onBlur={() => chipInput.trim() && addChip(chipInput)}
                  placeholder={chips.length === 0 ? "name@example.com, press Enter to add" : ""}
                  className="min-w-[180px] flex-1 bg-transparent text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] outline-none"
                />
              </div>
              {chips.some((c) => c.error) && (
                <p className="mt-1 text-xs text-[#ff9592]">
                  Invalid emails are highlighted. Remove or fix them before sending.
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="inviteRole"
                className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
              >
                Role
              </label>
              <select
                id="inviteRole"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
                className="mt-1.5 block w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] transition-colors duration-150"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <p className="mt-1 text-xs text-[var(--gray-09)]">
                Owners cannot be granted via invite.
              </p>
            </div>

            {inviteGeneralError && (
              <p className="text-xs text-[#ff9592]">{inviteGeneralError}</p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={inviting}
                className="flex-1 rounded bg-[#ffe629] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {inviting ? "Sending…" : "Send invites"}
              </button>
              <button
                type="button"
                onClick={handleSkip}
                disabled={inviting}
                className="rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-4 py-2 text-sm font-medium text-[var(--gray-12)] transition-colors duration-150 hover:border-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
      <div className="w-full max-w-md">
        <div className="mb-1 text-xs text-[var(--gray-09)]">
          Step 1 of 2
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
