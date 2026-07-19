import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig.json sets `jsx: "preserve"` (Next.js hands JSX to its own SWC
  // compiler at build time) — Vite 8's default Oxc transform respects that
  // and leaves raw JSX syntax in place, which then fails Vite's plain-JS
  // import analysis. Force the automatic runtime here so `.tsx` files (e.g.
  // server-component pages with no hooks of their own) can be imported
  // directly in tests and their returned element tree walked — this repo
  // has no DOM/render harness, so this is what makes even hook-free
  // component tests possible at all.
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    environment: "node",
  },
});
