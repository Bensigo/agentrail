# Claude Code Instructions

## Context Management

Auto-compaction is tuned in `.claude/settings.json` (the `env` block) — **not `.env`**, which Claude Code does not read:

```json
"env": {
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "40",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"
}
```

This triggers auto-compaction at 40% of a 200k-token window (~80k tokens used), instead of the default 95%. It keeps responses in the quality sweet spot — Claude degrades noticeably past 50% context, so compact early.

These are read at Claude Code **startup**, so changes need a restart to take effect. If you notice the conversation getting long mid-session, run `/compact` manually.

## Working Memory

Session summaries are written automatically to `.memory/working/DD-MM-YYYY.md` each time the context compacts. Files are named `DD-MM-YYYY` (day-first), so **lexical sort does NOT equal time order** — `02-07-2026` sorts before `25-06-2026` but is newer. Always resolve "latest" by modification time, not filename.

**When to read it (start of a new session, or when you need prior context):**

1. Find the most recently compacted file by mtime:
   ```bash
   ls -t .memory/working/*.md | head -1
   ```
2. Read that file and look at the **last** block in it — blocks are appended in time order, each with a `_Compacted DD-MM-YYYY HH:MM · trigger: …_` header. The last block is the most recent compaction.
3. Only walk back to older blocks / older files if the latest block doesn't have what you need.

```
.memory/working/
  25-06-2026.md   ← most recent mtime = read this first, last block first
  24-06-2026.md   ← older
  ...
```

Each file contains one or more compaction summaries for that day, reranked by importance (highest-signal items first). Reading it costs ~400 tokens per compaction block — load only what's relevant.

**Do not load the entire `.memory/working/` folder blindly.** Resolve the latest file by mtime, read its newest block, and stop there unless you need more.

## Project Memory

The `.memory/` folder is gitignored — write freely there for session notes and scratch context.
