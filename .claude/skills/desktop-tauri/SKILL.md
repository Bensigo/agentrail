---
name: desktop-tauri
description: Tauri desktop apps including src-tauri, Rust commands, webview integration, permissions, capabilities, and packaging. Use when the task mentions Tauri, desktop, webview, Rust commands, capabilities, app windows, tray/menu, packaging, or files under src-tauri.
---

# Desktop Tauri

Use this skill for Tauri desktop applications, including `src-tauri`, Rust commands, frontend/webview integration, permissions, capabilities, packaging, or platform-specific desktop behavior.

## Activation Guidance

Activate when the task mentions Tauri, desktop, webview, Rust commands, capabilities, permissions, app windows, tray/menu behavior, packaging, or files under `src-tauri`. Pair it with `frontend-web` for UI-visible webview work and `docs-current` when Tauri API behavior, version differences, or permission models may be stale.

## Context To Inspect

- Tauri major version from `src-tauri/Cargo.toml`, `Cargo.lock`, package dependencies, and any `@tauri-apps/*` frontend packages.
- `src-tauri/tauri.conf.json` or `tauri.conf.json`, including build commands, dev URLs, bundle settings, windows, plugins, and security config.
- Rust command definitions, frontend invoke calls, payload shapes, errors, and serialization boundaries.
- Capability and permission files under `src-tauri/capabilities`, plugin permissions, and platform-specific config.
- Frontend build scripts and Rust checks available in `package.json`, `Cargo.toml`, and project docs.

## Constraints

- Do not assume Tauri v1 and v2 APIs are interchangeable; verify the installed version before changing APIs.
- Keep frontend and Rust command contracts explicit and tested where practical.
- Do not widen capabilities or permissions unless the issue requires it and the PR explains the risk.
- Keep frontend build commands and Rust commands aligned with the Tauri config.
- Avoid claiming packaging behavior without running the closest available local check or documenting why it cannot run.

## Verification Requirements

- Run the relevant frontend build, type, lint, or test command for webview changes.
- Run `cargo check` in `src-tauri` when Rust, commands, plugins, capabilities, or Tauri config are touched and Cargo is available.
- Run the closest Tauri build, dev, or validation command when packaging, windows, permissions, or config behavior is changed.
- Capture visual evidence for UI-visible desktop/webview changes when the environment supports it.

## Expected PR Evidence

- Tauri version inspected and source path used.
- Config, command boundary, and capability/permission files inspected.
- Frontend and Rust verification commands run, including skipped-command reasons.
- Visual evidence for UI-visible work, or a clear note that the change is not UI-visible.

## Provenance / Audit

- Local status: AgentRail-authored first-party skill.
- Upstream sources reviewed: Mindrally skills repository at `https://github.com/Mindrally/skills`, candidate path `tauri-development/SKILL.md` observed.
- License status: repository reported Apache-2.0; candidate used for audit awareness only.
- Local changes: added mandatory Tauri version, config, frontend/Rust command boundary, capability/permission, frontend build, and `cargo check` checks.
- Audit notes: no third-party skill text vendored; verify current Tauri docs before relying on API/version behavior.
