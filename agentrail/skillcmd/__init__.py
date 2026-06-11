"""Skill-backed agent-session primitive.

The reusable building block behind first-class skill commands (``grill-me``,
and later ``issue create`` / ``prd create`` / ``milestone create``). It loads a
shipped ``SKILL.md`` verbatim, frames it with house context, and invokes the
configured agent either interactively (default) or headless.

See ``docs/superpowers/specs/2026-06-11-skill-backed-cli-commands-design.md``.
"""
