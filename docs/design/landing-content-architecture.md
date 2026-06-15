# Landing Content Architecture (context-first)

Decide the content before the UI. Each section's UI slice (#732-#738) implements against this. Pairs with `docs/design/redesign-direction.md` (the craft bar) and depends on the message + numbers from #741 (copy) and #742 (v2 benchmarks). Build a section's UI only once its row here is agreed.

## The spine (every section ladders to this) — UPDATED 2026-06-15

**Primary moat = cost reduction.** AgentRail lets teams run **top-tier models** on their coding agents **without the bill** — measurably cutting AI-coding spend while keeping work high-quality. One message: ***cut your AI-coding cost — keep top-tier quality.***

- **Lead with cost.** The headline, proof, and CTA are about money saved (run the best models, pay far less).
- **Workflow is the supporting act, not the headline.** Compiled context, review gates, AFK, audit are *how* quality stays high while cost drops — they support the cost story, they don't lead it.
- **Paid product (not free).** The CLI is **no longer free** — if AgentRail cuts thousands off the bill, it's a paid tool. Remove every "free CLI / free forever / free while in preview" claim across the page (hero, FAQ, footer). Positioning is value-based.
- **(Open) pricing specifics** — the actual model/tiers/price points are the owner's call (not invented here). A real pricing section likely belongs on the page now that it's paid.

## Section-by-section: what it says → which design fits

| # | Section | What it must say (content) | Design that fits (composition) | Status |
|---|---|---|---|---|
| Hero | Cost headline + proof + CTA | **Lead with cost**: run top-tier models, cut the bill — one real $ proof stat + one CTA. (Copy retune in #741; structure done.) | Asymmetric: copy left, **real console** right | ✅ structure done (#733); copy → #741 |
| Capabilities | How it keeps quality high while cutting cost | The engine (context packs → fewer tokens) framed as the cost lever; gates/AFK/audit as quality support | Featured editorial panel + dense capability index (no bento) | ✅ structure done (#734); copy → #741 |
| **How it works** | How cost drops without losing quality | init → run on compiled context (the cost lever) → gate/AFK (quality) → see savings in console. Each step: command + the cost/quality outcome | Vertical numbered editorial steps, command + outcome per step, asymmetric (no identical step-card row) | pending #735 |
| **Pricing / tiers** | It's a paid tool; the price is a fraction of what it saves | Value-based pricing; **no "free"**. Frame against $ saved. Actual tiers/prices = owner decision (TBD) | Clear tiers or a value-anchored single offer | **NEW — needs owner pricing input** |
| **Proof** | The cost win is real and honestly scoped | The **v2** numbers from #742 ($ saved, token reduction, recall, rank, latency) with scope; works on any agent | Auditable: each number with method/scope, traceable to results file — not vanity cards | pending #736, **blocked on #742** |
| **FAQ + CTA** | Remove objections; earn the click | Real Q&As (how it saves, data stored, team controls, **how pricing works** — no "free") + one final CTA | Concise list; CTA restates the cost spine | pending #737 |
| Motion | — | Purposeful only (demonstrate, not decorate) | reduced-motion-safe entrance/scroll reveals | pending #738 |

## Sequence (why order matters)

1. **#742** republish v2 benchmark numbers → 2. **#741** decide the copy/message from those numbers → 3. then build **#735-#738** sections to fit the decided content. Hero/capabilities (#733/#734) were structural and already landed; their copy can be tuned in #741.

## Open decisions for sign-off (before building #735+)

- **Pricing (owner)**: what is the paid model — per-seat, usage, % of savings, flat tiers? And the price points? Needed before the Pricing section + before #741 can write honest pricing copy. (Won't be invented.)
- **"Free" removal scope**: confirm removing all free framing (hero, FAQ "CLI is free forever" / "free while in preview", footer). Yes per the pivot.
- **Proof**: hold #736 until #742 lands the v2 numbers (recommended).
- The how-it-works/CLI composition is decided (vertical steps; CLI folded into the cost+quality narrative, not a free-vs-paid compare).
