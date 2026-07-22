"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Count-up numeral for the landing's numbers section (landing v2 §Task 10).
 * Runs ONCE when 50% visible: 600ms ease-out from 0 via rAF — a scroll-
 * triggered state change on transform-free text, so it animates a rendered
 * number, not layout. Reduced motion (or no IntersectionObserver) renders
 * the final value immediately and never animates.
 */
export function CountUp({ value, className }: { value: number; className: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(value);
      return;
    }
    const el = ref.current;
    if (!el) return;
    // Arm at 0 on hydration (the section lives far below the fold), so the
    // trigger counts 0 -> value instead of visibly dropping value -> 0.
    setShown(0);
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const DURATION_MS = 600;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / DURATION_MS);
          const eased = 1 - (1 - t) * (1 - t);
          setShown(Math.round(eased * value));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.5 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);

  // Pre-hydration and pre-trigger both render the real value — SEO, no-JS,
  // and screen readers always see the number; the count-up is progressive
  // enhancement layered on top (0 flashes only once the observer arms).
  return (
    <p ref={ref} className={className}>
      {shown ?? value}
    </p>
  );
}
