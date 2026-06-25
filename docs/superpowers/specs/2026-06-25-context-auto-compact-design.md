# Design: context-memory-auto-compact (open-source)

**Date:** 2026-06-25  
**Status:** Approved

## What

A standalone open-source repo that gives any Claude Code user automatic session summarisation and compaction notifications. Two hooks, drop-in install.

## Repo

- **Location:** `/work/context-auto-compact`
- **Remote:** `https://github.com/Bensigo/context-memory-auto-compact.git`
- **License:** MIT

## Files

```
context-auto-compact/
├── hooks/
│   ├── precompact_summary.py   # PreCompact: reranked summary → .memory/working/DD-MM-YYYY.md
│   └── postcompact_notify.py   # PostCompact: notify user, recommend new session
├── install.sh                  # one-command setup
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── .gitignore
```

## Hook Behaviour

### PreCompact (`precompact_summary.py`)
- Trigger: `auto` only
- Reads JSONL transcript from `transcript_path` in hook payload
- Feeds last 60 messages (≤6 000 chars) to `claude-haiku-4-5` via `claude -p`
- Prompt instructs: rerank highest-signal first, ≤400 tokens output, bullet points only
- Appends timestamped block to `.memory/working/DD-MM-YYYY.md`
- Always exits 0 — never blocks compaction

### PostCompact (`postcompact_notify.py`)
- Trigger: all (no matcher needed)
- Prints to stdout: summary file path + "start a new session" recommendation
- Always exits 0

## install.sh behaviour
1. Creates `.memory/working/` in cwd
2. Creates `.claude/hooks/` if missing
3. Copies both hook scripts into `.claude/hooks/`
4. Patches `.claude/settings.json` with PreCompact + PostCompact entries
5. Adds `.memory/` to `.gitignore`
6. Prints next steps: set env var + CLAUDE.md snippet

## README sections
1. What it does
2. Research: smart zone 40–50%, lost-in-the-middle, degradation curve
3. Install: `install.sh` + manual fallback
4. Set threshold: `.env` and `~/.zshrc`
5. CLAUDE.md / AGENT.md snippet
6. Create `.memory/working/`
7. Test output (actual passing run)
8. What the notification looks like

## Post-build action
After repo is created: add PostCompact hook to `/work/bensigo-ai-workflow/.claude/settings.json` and move the print() notification out of `precompact_summary.py` (it now lives in `postcompact_notify.py`).
