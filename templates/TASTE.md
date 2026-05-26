# TASTE.md

Project taste is the product quality bar agents should apply after reading `CONTEXT.md`.

Keep this file specific to the product. Remove anything that does not help an agent make better trade-offs.

## Product Quality

- Optimize for the user's real workflow, not for showing that a feature exists.
- Prefer fewer, clearer states over broad configuration surfaces.
- Make empty, loading, error, and success states explicit when they affect the workflow.
- Avoid generic placeholder copy. Use the project's domain language.

## Interaction Standards

- Common actions should be obvious without instructional text.
- Destructive or hard-to-reverse actions need confirmation or a clear undo path.
- Controls should use familiar patterns: buttons for commands, toggles for binary settings, tabs for views, menus for option sets, and inputs for user-provided values.
- Do not hide core workflow steps behind decorative layouts.

## UI Standards

- Match the density and tone of the product category.
- Keep visual hierarchy proportional to the surface. Dashboards and internal tools should favor scanability over oversized hero treatment.
- Text must fit its container on mobile and desktop.
- UI-visible PRs need screenshots or video evidence of the actual changed surface.

## Copy Tone

- Be direct and concrete.
- Name the object, action, and result when the user needs to decide.
- Do not use hype language, vague reassurance, or filler.

## Anti-Patterns

- Shipping UI with only the happy path represented.
- Adding decorative elements that make the workflow harder to scan.
- Creating broad settings before the product has proven repeated use.
- Treating test output as visual evidence for UI changes.
