"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Reveals children with a rise+fade the first time they scroll into view.
 *
 * Reduced motion gets a static render (no translate, no transition): the
 * reveal is decoration, not comprehension, so the gentle equivalent is
 * simply "already there" (Apple HIG: drop movement, keep meaning). The
 * easing is the strong ease-out the rest of the page uses — built-in CSS
 * curves are too weak to read as intentional.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReducedMotion(true);
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={
        reducedMotion
          ? undefined
          : {
              opacity: shown ? 1 : 0,
              transform: shown ? "none" : "translateY(20px)",
              transition: `opacity 0.55s cubic-bezier(0.23,1,0.32,1) ${delay}ms, transform 0.55s cubic-bezier(0.23,1,0.32,1) ${delay}ms`,
              // Hint only while motion is imminent; release once settled.
              willChange: shown ? "auto" : "opacity, transform",
            }
      }
    >
      {children}
    </div>
  );
}
