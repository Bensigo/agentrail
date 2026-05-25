---
name: visual-evidence-for-prs
description: Capture and report PR-ready visual evidence for Ralph runs, manual PRs, frontend work, and desktop-visible changes. Use before opening or updating implementation PRs, especially when work affects UI, screenshots, browser flows, desktop apps, or user-visible behavior.
---

# Visual Evidence For PRs

Use this skill when a PR needs evidence a reviewer can inspect without rerunning the work.

## When To Use

Use this for:

- Ralph implementation runs before the PR body is written.
- Manual PRs before opening, marking ready for review, or replying to review.
- Frontend changes, including layout, copy placement, forms, flows, responsive states, empty states, loading states, error states, and generated visual output.
- Desktop-visible work, including Electron apps, native windows, menu flows, file previews, local screenshots, and OS-level dialogs.
- Changes where the visual surface did not change but the PR template still requires a visual evidence section.

Do not use screenshots as a substitute for tests. Evidence supports review; it does not prove the implementation is correct by itself.

## Evidence Types

Pick the smallest evidence set that proves the changed surface:

- **Final-state screenshot**: use for static UI, copy placement, layout changes, and desktop screens.
- **Before/after screenshots**: use when the difference is visual and reviewers need contrast.
- **Short video or GIF**: use for workflows, animations, drag/drop, menus, hover-dependent states, and multi-step desktop behavior.
- **Responsive screenshots**: use for mobile/tablet/desktop breakpoints or any layout that changes by viewport.
- **State screenshots**: use for empty, loading, error, disabled, success, permission, and validation states.
- **Browser automation screenshot**: use when Playwright, browser-use, or another browser check can reliably reach the changed state.
- **Desktop evidence**: use system screenshots or screen recordings for local apps, native windows, file pickers, notifications, or browser chrome behavior that a DOM screenshot misses.
- **Non-visual fallback**: use only when there is no user-visible surface.

## Capture Process

1. Identify the changed visual surfaces from the issue, diff, and acceptance criteria.
2. Start the app or workflow from a clean state. Record the command, URL, branch, PR number, or desktop app entry point used.
3. Exercise the main path first. Capture evidence showing the final changed state, not only the tool or test runner.
4. Capture the required edge states if the work touched them: mobile layout, empty state, loading state, error state, validation failure, permission boundary, or desktop dialog.
5. Check the evidence before attaching it. Reject evidence that is cropped away from the change, blurry, stale, shows the wrong branch, or hides the relevant UI.
6. Store or attach artifacts using the repo or PR's normal convention. If no convention exists, attach directly to the PR and name artifacts by surface and state, such as `checkout-mobile-error.png`.
7. Keep the verification command separate from the visual artifact. A screenshot should be paired with the command or manual flow that produced it.

For Ralph, include this in the implementation loop before the PR is finalized. For manual PRs, capture evidence after local verification passes and before asking for review.

## PR Output Expectations

Every implementation PR needs a `Visual Evidence` section.

For visual changes:

```md
## Visual Evidence

- Main path: <attached screenshot/video showing the changed surface>
- Edge state: <attached screenshot/video, if relevant>
- Capture context: `<command or URL used>`, viewport/device, and any seed/login/test data needed to reproduce.
```

For desktop-visible changes:

```md
## Visual Evidence

- Desktop flow: <attached screenshot/video of the native window or OS-visible behavior>
- Capture context: app entry point, OS if relevant, and manual steps used.
```

For non-visual changes:

```md
## Visual Evidence

No visual surface. Verified with:

- `<command>`: <result>
- <manual verification note, if applicable>
```

If evidence is missing, say why and what blocked capture. Do not imply a visual check happened when it did not.

## Quality Bar

Evidence is PR-ready when a reviewer can answer:

- What changed?
- Which acceptance criterion does this support?
- Does the main path work on the relevant surface?
- Are touched edge states visible?
- Can the reviewer reproduce the capture path?

Bad evidence includes screenshots of only the terminal, stale local builds, cropped images that hide the changed area, unrelated pages, and "works locally" notes with no artifact.
