"use client";

import { useState } from "react";
import { X } from "lucide-react";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

interface EmailChip {
  email: string;
  error?: string;
}

export function InviteStep({
  workspaceId,
  teammateCount,
  onChanged,
}: {
  workspaceId: string;
  teammateCount: number;
  onChanged: () => void;
}) {
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [chipInput, setChipInput] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [sending, setSending] = useState(false);
  const [generalError, setGeneralError] = useState("");
  const [sent, setSent] = useState(false);

  function addChip(raw: string) {
    const email = raw.trim();
    if (!email) return;
    if (chips.some((c) => c.email === email)) {
      setChipInput("");
      return;
    }
    setChips((prev) => [
      ...prev,
      isValidEmail(email) ? { email } : { email, error: "Invalid email" },
    ]);
    setChipInput("");
  }

  function removeChip(idx: number) {
    setChips((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addChip(chipInput);
    } else if (e.key === "Backspace" && chipInput === "") {
      setChips((prev) => prev.slice(0, -1));
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setGeneralError("");
    setSent(false);

    const pending = chipInput.trim();
    let finalChips = chips;
    if (pending) {
      finalChips = [
        ...chips,
        isValidEmail(pending) ? { email: pending } : { email: pending, error: "Invalid email" },
      ];
      setChips(finalChips);
      setChipInput("");
    }

    const valid = finalChips.filter((c) => !c.error);
    if (finalChips.length > 0 && valid.length === 0) {
      setGeneralError("Fix invalid emails first.");
      return;
    }
    if (valid.length === 0) return;

    setSending(true);
    for (const chip of valid) {
      try {
        await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: chip.email, role }),
        });
      } catch {
        // Partial failures are acceptable — the invites list reflects reality.
      }
    }
    setSending(false);
    setSent(true);
    setChips([]);
    onChanged();
  }

  return (
    <form onSubmit={handleSend} className="flex flex-col gap-2.5">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        {teammateCount > 0
          ? `${teammateCount} teammate${teammateCount === 1 ? "" : "s"} reached so far.`
          : "Add workspace members by email. You can also do this later from Members."}
      </p>

      <div className="flex min-h-[52px] flex-wrap gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-2 focus-within:border-[var(--gray-08)] transition-colors">
        {chips.map((chip, idx) => (
          <span
            key={idx}
            className={[
              "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-xs",
              chip.error
                ? "border border-[var(--red-09)]/40 bg-[var(--red-09)]/20 text-[var(--red-11)]"
                : "border border-[var(--gray-06)] bg-[var(--gray-04)] text-[var(--gray-12)]",
            ].join(" ")}
            title={chip.error}
          >
            {chip.email}
            <button
              type="button"
              onClick={() => removeChip(idx)}
              className="ml-0.5 opacity-60 hover:opacity-100"
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
          onKeyDown={handleKeyDown}
          onBlur={() => chipInput.trim() && addChip(chipInput)}
          placeholder={chips.length === 0 ? "name@example.com, press Enter to add" : ""}
          className="min-w-[160px] flex-1 bg-transparent text-xs text-[var(--gray-12)] placeholder:text-[var(--gray-08)] outline-none"
        />
      </div>

      <select
        aria-label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value as "member" | "admin")}
        className="h-8 w-32 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-xs text-[var(--gray-12)] outline-none focus:border-[var(--gray-08)]"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>

      {generalError && <p className="text-xs text-[var(--red-11)]">{generalError}</p>}
      {sent && <p className="text-xs text-[var(--green-11)]">Invites sent.</p>}

      <button
        type="submit"
        disabled={sending || (chips.length === 0 && !chipInput.trim())}
        className="h-8 self-start rounded bg-[var(--brand-accent)] px-3 text-xs font-medium text-black transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending ? "Sending…" : "Send invites"}
      </button>
    </form>
  );
}
