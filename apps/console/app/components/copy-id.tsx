"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { shortId } from "./id-display";

interface CopyIdProps {
  id: string;
  label?: string;
  /** Leading characters of `id` to show before the ellipsis. */
  visibleChars?: number;
  className?: string;
}

/**
 * Names-over-ids primitive (#1283): a short id + copy button, with the full
 * id available via the button (clipboard) and a `title` hover tooltip.
 * Never renders the full id as visible text content. Lifted from the
 * `ConnectCliPanel` copy-button pattern
 * (api-keys/components/connect-cli-panel.tsx) into one shared component for
 * every other surface where an id remains genuinely useful.
 */
export function CopyId({ id, label, visibleChars, className }: CopyIdProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5${className ? ` ${className}` : ""}`}
      title={id}
    >
      {label && <span className="text-xs text-[var(--gray-09)]">{label}</span>}
      <code className="font-mono text-xs text-[var(--gray-10)]">
        {shortId(id, visibleChars)}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy ${label ?? "id"}`}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border border-[var(--gray-06)] bg-[var(--gray-04)] text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)]"
      >
        {copied ? (
          <Check size={10} className="text-[var(--green-11)]" />
        ) : (
          <Copy size={10} />
        )}
      </button>
    </span>
  );
}
