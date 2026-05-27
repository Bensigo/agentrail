# Frontend Web

Use this skill for user-visible web UI, frontend application behavior, styling, component structure, or browser interaction work.

## Activation Guidance

Activate when the task mentions frontend, React, Next.js, Vite, CSS, components, UI, accessibility, responsive layout, forms, loading states, or browser-visible behavior. Also activate when touched files include `.tsx`, `.jsx`, CSS, route/app directories, or component directories.

## Context To Inspect

- Existing component structure, routes, design-system primitives, styling conventions, icons, spacing, and typography.
- Relevant data loading path and the UI states for loading, empty, error, and success.
- Existing tests, Storybook or preview fixtures, browser automation, and screenshots for the affected surface.
- Responsive behavior at mobile and desktop widths before changing layout.

## Constraints

- Preserve the existing design system unless the issue explicitly asks to change it.
- Keep visible changes scoped to the requested workflow or screen.
- Use semantic controls, labels, keyboard operation, visible focus states, and readable contrast.
- Do not ship UI-visible work without checking responsive behavior and state coverage.

## Verification Requirements

- Run the relevant unit, type, lint, or build command for the frontend surface.
- Verify the rendered UI in a browser when behavior or layout is visible.
- Check mobile and desktop widths, plus loading, empty, error, and success states when those states exist or are changed.
- Capture screenshot, video, or browser-test output as visual evidence for PRs that change visible UI.

## Expected PR Evidence

- Files/screens inspected for existing design-system conventions.
- Verification commands and browser paths used.
- Visual evidence link or artifact for UI-visible changes.
- Notes for any state that could not be exercised and why.

## Provenance / Audit

- Local status: AgentRail-authored first-party skill.
- Upstream sources reviewed: Anthropic Claude Code frontend design skill at `https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md`, observed content SHA `600b6db41fac7e2081c7528ec6982960892c819d`.
- License status: upstream content not audited for reuse; no third-party text vendored.
- Local changes: narrowed to AgentRail verification-first workflow, responsive checks, state coverage, and PR evidence requirements.
- Audit notes: provenance candidate only; do not hot-install or copy upstream content without a separate license and content audit.
