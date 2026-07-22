import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Auth-v2 shell pieces — the landing's design language (paper surface,
 * ink borders, hard offset shadows, lemon press buttons, mono voice) for
 * the auth front doors (/login, /signup/*). Class-recipe constants +
 * tiny components instead of a wrapping layout component so each page
 * keeps `<main>` as its ROOT element — `signup/[token]/page.test.ts`
 * asserts that structure (root.type === "main") and must stay honest.
 *
 * The visual recipes mirror (marketing)/page.tsx's INK_BUTTON and card
 * treatment; if the landing's recipe evolves, evolve this with it.
 */

export const AUTH_MAIN =
  "flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--paper)] px-6 py-16 text-center text-[var(--gray-12)]";

export const AUTH_INK_BUTTON =
  "inline-flex items-center gap-2.5 rounded-md border-2 border-[var(--gray-13)] bg-[var(--accent-fill)] px-6 py-3 font-bold text-[var(--accent-fill-text)] shadow-[4px_4px_0_0_var(--gray-13)] transition-[transform,background-color,box-shadow] duration-150 ease-out hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-[var(--accent-fill-hover)] hover:shadow-[2px_2px_0_0_var(--gray-13)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]";

/** The ink card every auth moment sits in. */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-5 rounded-xl border-2 border-[var(--gray-13)] bg-[var(--gray-00)] px-8 py-10 shadow-[6px_6px_0_0_var(--gray-13)]">
      {children}
    </div>
  );
}

/** Canonical avatar disc (TASTE.md mascot canon) fronting each card. */
export function JaceAvatar() {
  return (
    <Image
      src="/jace-avatar.png"
      alt=""
      width={64}
      height={64}
      priority
      className="rounded-full"
    />
  );
}

/** The quiet way back to the front page. */
export function BackToJace() {
  return (
    <Link
      href="/"
      className="text-body-sm rounded-sm text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
    >
      ← Back to Jace
    </Link>
  );
}
