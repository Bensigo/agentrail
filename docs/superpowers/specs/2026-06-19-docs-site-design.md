# Docs site design — AgentRail `/docs`

_Date: 2026-06-19 · Status: approved design, pending implementation plan_

## Goal

Add a documentation section to the marketing site that teaches a developer how
to **set up and use the AgentRail CLI**. Today the only docs pointer is a
footer "Documentation" link that goes out to the GitHub README; there is no
docs site and no `/docs` route (it 404s). This builds that site.

## Decisions (locked with the user)

1. **Primary flow = repo-native self-serve.** Lead with `install → init →
   grill-me → run issue N`, fully local, bring-your-own LLM keys, dashboard
   optional. The **hosted runner** model (`login` → queue in console →
   `runner`) is documented as a secondary section, not the headline path.
2. **Stack = Fumadocs mounted inside the console app at `/docs`.** One Vercel
   deploy, one domain (`agentrail.dev/docs`), shares the marketing brand. Not a
   separate `apps/docs` app and not a hand-rolled MDX route.
3. **Scope = comprehensive** (see content tree below).
4. **Wire into the site.** Add a **Docs** item to the landing nav and repoint
   the footer "Documentation" link from the GitHub README to `/docs`.

## Architecture

### Routing & isolation

- New route group `apps/console/app/(docs)/` with a catch-all
  `docs/[[...slug]]/page.tsx`, served at `/docs`.
- `(docs)/layout.tsx` wraps Fumadocs' `RootProvider` + `DocsLayout` so the docs
  theme, sidebar, search, and TOC are **scoped to the `/docs` subtree**. The
  marketing `(marketing)/layout.tsx` and the dashboard layout are untouched.

### Tooling & content pipeline

- Add to `apps/console`: `fumadocs-ui`, `fumadocs-core`, `fumadocs-mdx`,
  `@types/mdx`.
- `source.config.ts` at the console root via `defineDocs`/`defineConfig`;
  content as `.mdx` under `apps/console/content/docs/`, with `meta.json` files
  controlling sidebar order/grouping.
- `createMDX()` from `fumadocs-mdx/next` wraps the console's existing
  `next.config.ts`.
- `lib/source.ts` exposes the source loader the catch-all page consumes.
- The generated `.source/` directory is **gitignored** and built by a
  `predev`/`prebuild` step (run `fumadocs-mdx`) so both `pnpm dev` and CI
  builds produce it.

### CSS isolation (the real risk)

The console uses Tailwind v4 with custom `--gray-*` / lemon brand vars and a
shared `globals.css`. Fumadocs ships a Tailwind v4, layer-based preset
(`fumadocs-ui/css/*.css`). Import the Fumadocs preset **only in the docs
layout's stylesheet**, then **verify in-browser** that it does not bleed into
the marketing or dashboard pages (and vice versa). Theme the docs to the brand:
accent = lemon `#ffe629`, Inter body, Berkeley Mono for code.

## Content tree (comprehensive)

Content is **derived from the real CLI** — the authoritative `_usage()` command
surface in `agentrail/cli/main.py` and the command modules under
`agentrail/cli/commands/` — not invented.

- **Getting Started**
  - Introduction — what AgentRail is (the control plane that runs *your* coding
    agents — Claude, Codex, Cursor — not a coding agent itself), who it's for.
  - Installation — `npm i -g @useagentrail/cli`, requirements (Node 18+,
    Python 3.9+, `gh` optional), BYO LLM keys.
  - Quickstart — `init` → `grill-me` → `run issue N`, with expected output.
- **Core Concepts**
  - Context engine & packs (BM25 + code graph, bounded line-range packs)
  - Bounded execution (plan → execute → verify, auto-retry on verify failure)
  - Review loops & gates (second-model review, gates between phases)
  - AFK mode (unattended queue/worktree loop)
  - Memory (lessons/decisions/failure patterns recalled before acting)
  - Skills (curated workflow skills)
- **CLI Reference** — one page per command group, every command in the usage
  surface: `init`/`install`, `run`, `afk`, `context`, `memory`, `skills`,
  `issue`/`milestone`/`prd`, `status`/`doctor`/`upgrade`/`cleanup`,
  `cost`/`timeline`, `grill-me`, `prompt`, `console`/`login`/`logout`/`whoami`/
  `runner`/`link`, `heartbeat`, `labels`, `resume`.
- **Configuration** — `.agentrail` config, choosing an agent
  (`--agent claude|codex|cursor`), env vars, BYO keys.
- **Dashboard & hosted runner** (secondary) — `login` (device flow),
  `runner`, `console`, what the team layer adds.

## Site wiring

- Landing nav (`apps/console/app/(marketing)/page.tsx`): add a **Docs** link
  (`/docs`) alongside How it works / Benchmark / Platform.
- Footer `FOOTER_COLUMNS` Resources: repoint **Documentation** from
  `github.com/Bensigo/agentrail#readme` to `/docs`.

## Out of scope

- The company **blog** (separate follow-up; Fumadocs/MDX blog, tracked elsewhere).
- Docs **versioning**, custom search backend (use Fumadocs' default), and i18n.
- Reconciling `npm-README.md` drift (it says `agentrail grill`; the CLI exposes
  `grill-me`). Noted here; handled separately so docs reflect the real CLI.

## Known accuracy notes

- The CLI's authoritative command list is `_usage()` in
  `agentrail/cli/main.py`; document that surface, not the README's older list.
- Some README examples (`agentrail grill`, dashboard via `AGENTRAIL_API_KEY`)
  diverge from the current CLI — docs follow the CLI, and the README drift is
  flagged for a separate cleanup.
