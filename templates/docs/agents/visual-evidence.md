# Visual Evidence

Every implementation PR must include a visual evidence section.

For UI-visible work, attach a screenshot or short video showing the completed behavior. For non-visual work, state that there is no visual surface and include the relevant verification notes.

## When Evidence Is Required

Visual evidence is required for:

- New screens.
- Changed layouts.
- Forms and flows.
- Empty, loading, error, and success states.
- Responsive behavior.
- Charts, dashboards, or generated content.
- Any user-visible copy change where placement matters.

## Acceptable Evidence

Use whichever is clearest:

- Screenshot of the final state.
- Short video of the workflow.
- Before and after screenshot for visual changes.
- Browser test screenshot for automated verification.

Evidence should show the actual product surface, not only a test runner.

## Non-Visual Changes

For backend, infrastructure, data, or internal-only changes, the PR still needs a visual evidence section.

Use:

```md
## Visual Evidence

No visual surface. Verified with:

- `command used`
- Relevant log, test, or manual verification note.
```

## Quality Bar

Evidence should make it easy for a reviewer to answer:

- What changed?
- Does the main path work?
- Are obvious edge states covered?
- Does the UI fit on relevant screen sizes?

Do not attach vague screenshots that hide the changed area.
