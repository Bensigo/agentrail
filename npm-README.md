# AgentRail

Repo-native harness for AI coding agents. Gives agents durable context, bounded issue execution, review loops, and verification gates — so agent work is easier to inspect, resume, and trust.

Works with Claude Code, Codex, Cursor, Hermes, or any custom command. You bring your own LLM keys.

## Install

```bash
npm install -g @useagentrail/cli
```

## Quick Start

Initialize AgentRail in your project:

```bash
cd your-project
agentrail init
```

Start with a grilling session to define your project context:

```bash
agentrail grill
```

Then create issues and run:

```bash
agentrail run issue 42 --agent claude
```

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
| `agentrail init` | Install workflow files into a project |
| `agentrail grill` | Challenge and refine a product idea |
| `agentrail run issue N` | Execute a bounded plan/execute/verify loop |
| `agentrail run batch 1 2 3` | Run multiple issues in parallel worktrees |
| `agentrail afk` | Unattended queue loop for labeled issues |
| `agentrail doctor` | Check installation health |
| `agentrail status` | Print workflow state |
| `agentrail context query "task"` | Query the context engine |
| `agentrail memory recall "topic"` | Recall project memory |
| `agentrail console` | Dashboard status and setup |
| `agentrail upgrade` | Upgrade managed files without overwriting edits |

## Dashboard (Optional)

The CLI works fully without an API key. Set `AGENTRAIL_API_KEY` to unlock the dashboard:

- Agent operations console across repos and teams
- Run event streaming and cross-repo analytics
- Context pack audit trails
- Team collaboration and workspace sharing

```bash
export AGENTRAIL_API_KEY=your-key
agentrail console
```

## Requirements

- Node.js 18+
- Python 3.9+ (for the context engine)
- `gh` CLI (optional, for GitHub integration)

## License

Proprietary
