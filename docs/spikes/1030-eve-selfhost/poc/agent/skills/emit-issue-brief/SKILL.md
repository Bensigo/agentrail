---
description: Structure a rough feature idea into AgentRail's house issue format before proposing a create_issue call.
---

When the human gives you a rough idea for work, do not jump straight to
`create_issue`. First shape it into the house format so the factory gets a
well-scoped contract:

- **Parent** — the epic or parent issue this belongs under (e.g. `#1024`).
- **Required context** — the CONTEXT.md/TASTE.md terms and files that matter.
- **What to build** — one vertical, independently-grabbable slice. Small.
- **AC1..ACn** — falsifiable acceptance criteria, each checkable by a test.
- **Verification** — the exact command(s) that prove the ACs.

Prefer the smallest slice that is demoable on its own. If the idea is really
several slices, say so and propose only the first. Then, and only then, call
`create_issue` with the assembled body — which will pause for human approval.
