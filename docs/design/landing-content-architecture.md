# Landing Content Architecture (context-first)

Decide the content before the UI. Each section's UI slice (#732-#738) implements against this. Pairs with `docs/design/redesign-direction.md` (the craft bar) and depends on the message + numbers from #741 (copy) and #742 (v2 benchmarks). Build a section's UI only once its row here is agreed.

## The spine (every section ladders to this)

**AgentRail is a control layer on top of any coding agent (Claude, Codex, Cursor) — not a competing agent. It makes agent work measurably cheaper and centrally accountable.** One message: *make any coding agent cheaper and accountable.*

## Section-by-section: what it says → which design fits

| # | Section | What it must say (content) | Design that fits (composition) | Status |
|---|---|---|---|---|
| Hero | Headline + proof + CTA | The spine in one line + one real proof stat + one CTA | Asymmetric: copy left, **real console** right | ✅ done (#733) |
| Capabilities | What the platform does | The engine (context packs, real citations) + the rest as an index | Featured editorial panel + dense capability index (no bento) | ✅ done (#734) |
| **How it works** | How a team adopts it in 3-4 concrete steps | init → run on compiled context → gate/AFK → see it in console. Each step names the command + the outcome | **Decision needed** — vertical numbered editorial steps (left-rail index) **vs** a horizontal "rail" flow. Recommend: vertical numbered steps with the real command per step, asymmetric (no identical step-cards row) | pending #735 |
| **CLI vs Console** | Free CLI (one dev) vs Console (the team layer) — the upsell | The CLI is free forever; the console is what you can only do when agent work is centralized (gates, cost, audit, members) | **Decision needed** — two-column compare **vs** a single "team layer" narrative with the CLI as the base. Recommend: narrative, not a feature-checklist table | pending #735 |
| **Proof** | The numbers are real and honestly scoped | The **v2** numbers from #742 (token reduction, recall, rank, latency) with their scope; "a layer on any agent" | Auditable: each number with its method/scope, traceable to results file — not vanity stat cards | pending #736, **blocked on #742** |
| **FAQ + CTA** | Remove the last objections; earn the click | The real Q&As (free CLI? data stored? team controls?) + one final CTA | Concise list; CTA restates the spine | pending #737 |
| Motion | — | Purposeful only (demonstrate, not decorate) | reduced-motion-safe entrance/scroll reveals | pending #738 |

## Sequence (why order matters)

1. **#742** republish v2 benchmark numbers → 2. **#741** decide the copy/message from those numbers → 3. then build **#735-#738** sections to fit the decided content. Hero/capabilities (#733/#734) were structural and already landed; their copy can be tuned in #741.

## Open decisions for sign-off (before building #735+)

- **How-it-works**: vertical numbered editorial steps (recommended) vs horizontal rail flow?
- **CLI-vs-Console**: team-layer narrative (recommended) vs side-by-side compare?
- **Proof**: hold #736 until #742 lands the v2 numbers (recommended), or build the layout now with placeholders?
