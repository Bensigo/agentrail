<!--
Fill in each section. The structure mirrors the AgentRail house issue format so a
PR can be checked against its parent issue's acceptance criteria.
-->

## Parent

<!-- Closes #<issue>. Link the issue this PR implements. -->

Closes #

## What changed

<!--
Concise summary of the change and the user-visible outcome. Use the project's
domain language (AgentRail Server, Local Indexer, Context Compiler, Issue Queue,
Heartbeat). No hype.
-->

## Acceptance criteria

<!-- Copy the parent issue's ACs and check the ones this PR satisfies. -->

- [ ] AC1:
- [ ] AC2:

## Verification evidence

<!--
Paste the proof. Required:
- Test/lint command tails (see CONTRIBUTING.md): `python -m pytest -q`,
  `shellcheck install.sh agentrail/scripts/test-install.sh`, `bash agentrail/scripts/test-install.sh`.
- For UI-visible surfaces: a screenshot or short video of the actual changed
  surface. Test output is not visual evidence.
-->

## Checklist

- [ ] CI is green (python + shell jobs).
- [ ] Docs/glossary updated if behavior or terms changed (`CONTEXT.md` / `TASTE.md`).
- [ ] Any new badge or dashboard surface is falsifiable (can come back red/negative).
- [ ] No secrets, keys, or private source committed.
