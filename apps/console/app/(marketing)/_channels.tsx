"use client";

import { useEffect, useRef, useState } from "react";
import {
  TelegramBrand,
  SlackBrand,
  DiscordBrand,
} from "../(dashboard)/dashboard/[workspaceId]/connectors/components/brand-icons";
import type { MessageJaceCta } from "./_cta";
import type { ChannelCard } from "./_channel-cards";

/**
 * "Where you'll find me" — landing v2's scroll-pinned channel scene
 * (plan: docs/superpowers/plans/2026-07-22-landing-v2.md §Task 7).
 *
 * PRESENTATION vs LINKS (owner ruling 2026-07-22, recorded in TASTE.md by
 * PR 3/3): the owner chose to present Telegram, Slack, and Discord as equal
 * panels — overriding the render-nothing default the #1284/#1285 honesty
 * gate applies to footer cards. The LINKS still respect that gate: each
 * button uses the channel's real URL only when its resolver provides one
 * (Telegram via `_cta.ts`, Slack/Discord via `_channel-cards.ts`'s
 * env-gated resolvers), and falls back to the GitHub sign-in action
 * otherwise — never a dead link, never a fabricated destination.
 *
 * Scroll mechanics: the pinned variant renders only for motion-ok visitors
 * at ≥sm (CSS hides it below sm); `prefers-reduced-motion` gets the static
 * stack at every width. Progress comes from one passive scroll listener +
 * rAF read of the container rect — transform/opacity swaps only, 200ms
 * ease-out, matching the house motion rules.
 */

interface ChannelPanel {
  id: "telegram" | "slack" | "discord";
  name: string;
  line: string;
  buttonLabel: string;
}

const PANELS: ChannelPanel[] = [
  {
    id: "telegram",
    name: "Telegram",
    line: "DM me on Telegram. A message becomes a brief in under a minute.",
    buttonLabel: "Message Jace on Telegram",
  },
  {
    id: "slack",
    name: "Slack",
    line: "Add me to a channel. Mention me with a task and approve from the thread.",
    buttonLabel: "Add Jace to Slack",
  },
  {
    id: "discord",
    name: "Discord",
    line: "Drop me in your server. I post briefs and outcome pings where the team can see them.",
    buttonLabel: "Add Jace to Discord",
  },
];

function PanelIcon({ id, size }: { id: ChannelPanel["id"]; size: number }) {
  if (id === "telegram") return <TelegramBrand size={size} />;
  if (id === "slack") return <SlackBrand size={size} />;
  return <DiscordBrand size={size} />;
}

export function Channels({
  cta,
  slack,
  discord,
  signInAction,
}: {
  cta: MessageJaceCta;
  slack: ChannelCard | null;
  discord: ChannelCard | null;
  signInAction: () => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const scrollable = rect.height - window.innerHeight;
        if (scrollable <= 0) return;
        const progress = Math.min(1, Math.max(0, -rect.top / scrollable));
        setActive(Math.min(PANELS.length - 1, Math.floor(progress * PANELS.length)));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const hrefFor = (id: ChannelPanel["id"]): string | null => {
    if (id === "telegram") return cta.kind === "telegram" && cta.href ? cta.href : null;
    if (id === "slack") return slack?.href ?? null;
    return discord?.href ?? null;
  };

  const staticStack = (
    <div className={reducedMotion ? "flex flex-col gap-6" : "flex flex-col gap-6 sm:hidden"}>
      {PANELS.map((panel) => (
        <div
          key={panel.id}
          className="flex flex-col items-start gap-4 rounded-xl border border-[var(--gray-06)] bg-[var(--gray-00)] p-6 sm:p-8"
        >
          <div className="flex items-center gap-3">
            <PanelIcon id={panel.id} size={28} />
            <span className="font-bold text-[var(--gray-12)]">{panel.name}</span>
          </div>
          <p className="max-w-[46ch] text-[var(--gray-11)]">{panel.line}</p>
          <ChannelButton label={panel.buttonLabel} href={hrefFor(panel.id)} signInAction={signInAction} />
        </div>
      ))}
    </div>
  );

  if (reducedMotion) return staticStack;

  return (
    <>
      {staticStack}
      <div ref={containerRef} className="relative hidden h-[280vh] sm:block">
        <div className="sticky top-24 flex h-[calc(100vh-8rem)] items-center">
          <div className="grid w-full grid-cols-[auto_1fr] items-center gap-16">
            {/* Channel rail — where you are in the story. */}
            <div className="flex flex-col gap-3">
              {PANELS.map((panel, i) => (
                <div
                  key={panel.id}
                  className={
                    i === active
                      ? "flex items-center gap-3 rounded-lg border border-[var(--gray-06)] bg-[var(--gray-00)] px-4 py-3 shadow-sm transition-colors duration-200"
                      : "flex items-center gap-3 rounded-lg border border-transparent px-4 py-3 opacity-50 transition-[opacity,background-color] duration-200"
                  }
                >
                  <PanelIcon id={panel.id} size={22} />
                  <span className="font-bold text-[var(--gray-12)]">{panel.name}</span>
                </div>
              ))}
            </div>

            {/* Active panel — opacity/translate swap only. */}
            <div className="relative h-[320px]">
              {PANELS.map((panel, i) => (
                <div
                  key={panel.id}
                  aria-hidden={i !== active}
                  className={
                    i === active
                      ? "absolute inset-0 flex translate-y-0 flex-col items-center justify-center gap-5 rounded-xl border border-[var(--gray-06)] bg-[var(--gray-00)] p-10 opacity-100 shadow-sm transition-[opacity,transform] duration-200 ease-out"
                      : "pointer-events-none absolute inset-0 flex translate-y-2 flex-col items-center justify-center gap-5 rounded-xl border border-[var(--gray-06)] bg-[var(--gray-00)] p-10 opacity-0 transition-[opacity,transform] duration-200 ease-out"
                  }
                >
                  <PanelIcon id={panel.id} size={56} />
                  <p className="max-w-[40ch] text-center text-[var(--gray-11)]">{panel.line}</p>
                  <ChannelButton label={panel.buttonLabel} href={hrefFor(panel.id)} signInAction={signInAction} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Lemon-fill action — real channel URL when its resolver provides one,
 *  the sign-in server action otherwise. Same class recipe as the nav pill
 *  CTA so every filled button on the page matches. */
function ChannelButton({
  label,
  href,
  signInAction,
}: {
  label: string;
  href: string | null;
  signInAction: () => Promise<void>;
}) {
  const classes =
    "inline-flex items-center gap-2 rounded-md bg-[var(--accent-fill)] px-5 py-2.5 font-bold text-[var(--accent-fill-text)] transition-[transform,background-color] duration-200 hover:bg-[var(--accent-fill-hover)] active:scale-[0.97]";
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {label}
      </a>
    );
  }
  return (
    <form action={signInAction}>
      <button type="submit" className={classes}>
        {label}
      </button>
    </form>
  );
}
