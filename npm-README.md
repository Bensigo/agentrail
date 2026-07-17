# AgentRail

Control plane for AI coding agents. Gives agents durable context, bounded issue execution, review loops, and verification gates — so agent work is easier to inspect, resume, and trust.

Works with Claude Code, Codex, Cursor, Hermes, or any custom command. You bring your own LLM keys.

## Install

```bash
npm install -g @useagentrail/cli
```

## Quick Start

Sign up at [heyjace.com](https://heyjace.com), connect your
GitHub repos on the Connectors page (trigger label: `ready-for-agent`), then:

Log in to your workspace (required):

```bash
agentrail login
```

Start the local runner:

```bash
agentrail runner
```

The runner claims queued issues from the dashboard, executes them on your
machine, opens PRs, and reports back. Label any GitHub issue `ready-for-agent`
and a reviewed PR comes back automatically.

## What It Does

- **Context engine** — builds scoped context packs from your repo so agents see what matters
- **Bounded execution** — plan → execute → verify phases with automatic retry on verification failure
- **Review loops** — PR review with finding triage (P0 → new issues, non-P0 → comments)
- **AFK mode** — unattended batch execution across issues using git worktrees
- **Project memory** — lessons, decisions, and failure patterns agents recall before acting
- **Skills** — curated workflow skills that guide agents through complex tasks

## Commands

| Command | Description |
|---------|-------------|
| `agentrail login` | Sign in to your AgentRail workspace (required) |
| `agentrail runner` | Start the local worker that claims and runs queued issues |
| `agentrail whoami` | Show the logged-in workspace |
| `agentrail init` | Install workflow files into a project |
| `agentrail run issue N` | Execute a bounded plan/execute/verify loop |
| `agentrail afk` | Unattended queue loop for labeled issues |
| `agentrail doctor` | Check installation health |
| `agentrail status` | Print workflow state |
| `agentrail context query "task"` | Query the context engine |
| `agentrail memory recall "topic"` | Recall project memory |
| `agentrail console` | Open the dashboard console |
| `agentrail upgrade` | Upgrade managed files without overwriting edits |

## Dashboard

The [console at heyjace.com](https://heyjace.com) is the central workspace
for connecting repos, managing the issue queue, reviewing run outcomes, and
tracking cost across your team:

- Agent operations console across repos and teams
- Run event streaming and cross-repo analytics
- Context pack audit trails
- Team collaboration and workspace sharing

## Requirements

- Node.js 18+
- Python 3.9+ (for the context engine)
- `gh` CLI (optional, for GitHub integration)

## License

Proprietary
