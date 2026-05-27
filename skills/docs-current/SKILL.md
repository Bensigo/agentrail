# Docs Current

Use this skill when a task depends on current external documentation, third-party APIs, SDK behavior, package versions, platform rules, licensing, or source provenance.

## Activation Guidance

Activate when the user asks for current or latest behavior, when APIs may have changed, when dependency versions matter, when licensing/provenance is relevant, or when Tauri, platform SDK, deploy provider, framework, or package behavior is version-sensitive.

## Context To Inspect

- Installed dependency versions, lockfiles, package metadata, framework config, and source files that call the external API.
- Official documentation, release notes, source repository, package registry, or Context7 documentation result for the relevant version.
- Existing project docs, ADRs, comments, and tests that assert old behavior.
- License, source URL, branch/tag/version, observed date, and whether facts are verified or inferred.

## Constraints

- Do not rely on memory for version-sensitive API behavior when official docs or Context7 are available.
- Prefer official docs, release notes, source repositories, and package metadata over community examples.
- Record the docs source and version/date used when it informs implementation or PR evidence.
- Check license and audit status before copying or vendoring external content.
- Separate verified facts from inferences.

## Verification Requirements

- Use Context7 or official documentation when API behavior may be stale.
- Record the source URL or Context7 library/version, plus observed date or package version used.
- Re-run relevant tests, builds, or checks after applying docs guidance.
- If docs cannot be accessed, state the limitation and verify against installed package/source behavior where possible.

## Expected PR Evidence

- Documentation source, version/tag/package version, and observed date.
- What behavior was verified and what remains an inference.
- Verification commands run after applying docs guidance.
- License/provenance note when external examples or skill candidates influenced the change.

## Provenance / Audit

- Local status: AgentRail-authored first-party skill.
- Upstream sources reviewed: Upstash Context7 repository at `https://github.com/upstash/context7`, README SHA `afe64f44a7d2e79370b5c79623b328b34382ae49`; GitHub awesome-copilot at `https://github.com/github/awesome-copilot`.
- License status: Context7 and awesome-copilot repositories reported MIT during source review; no third-party text vendored.
- Local changes: converted docs currency into a verification gate requiring Context7 or official documentation and recording source/version evidence.
- Audit notes: use Context7 or official docs as lookup sources only; AgentRail does not configure automatic third-party installs from these repositories.
