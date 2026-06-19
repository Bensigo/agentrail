# AgentRail dogfood track record

_Real autonomous runs of AgentRail on its own backlog (`Bensigo/agentrail`),
captured from the AFK orchestration telemetry (`.agentrail/afk/events.jsonl`).
This is a real track record of full runs — issue → implementation → review →
PR — not a synthetic or retrieval benchmark._

- **Shipped to reviewed PRs: 33**
- **Didn't land: 20** (53 attempted; the rest hit a gate or review and stopped to a human)
- **Sample clean run:** issue **#221** "Add API keys view" → opened PR **#308**
  on the **first attempt**, **1 review round**, no errors.

## Honest scope

These are dogfood runs on one repo (AgentRail's own), driven by the `claude`
and `codex` agents under the AFK loop. Real end-to-end runs, but a single
project — directional evidence that the loop ships real work unattended, not a
universal guarantee. Token/dollar cost per run streams to the console
(ClickHouse cost-events) and is not included in this file.
