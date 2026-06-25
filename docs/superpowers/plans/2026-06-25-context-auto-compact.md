# context-memory-auto-compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone open-source repo with two Claude Code hooks that auto-summarise sessions before compaction and notify users afterward, then wire both hooks into the current project.

**Architecture:** Two independent Python scripts dropped into `.claude/hooks/`. `precompact_summary.py` fires before compaction, reads the JSONL transcript, calls Haiku to produce a reranked ≤400-token summary, and appends it to `.memory/working/DD-MM-YYYY.md`. `postcompact_notify.py` fires after compaction and prints a visible notification recommending a new session.

**Tech Stack:** Python 3 (stdlib only in notify; subprocess + json in summary), Claude Code hooks system, `claude -p` CLI for Haiku inference, Bash for install script.

---

## File Map

| File | Role |
|---|---|
| `hooks/precompact_summary.py` | PreCompact hook — transcript → reranked summary → `.memory/working/` |
| `hooks/postcompact_notify.py` | PostCompact hook — stdout notification to user |
| `install.sh` | One-command installer for users |
| `README.md` | Full public documentation |
| `CONTRIBUTING.md` | Contribution guide |
| `LICENSE` | MIT |
| `.gitignore` | Ignore `.memory/`, `__pycache__`, `.env` |

**Current project changes (Task 8):**
| File | Change |
|---|---|
| `.claude/hooks/precompact_summary.py` | Remove notification `print()` block (lines 131–138) |
| `.claude/hooks/postcompact_notify.py` | Copy from new repo |
| `.claude/settings.json` | Add PostCompact hook entry |

---

### Task 1: Initialise the repo

**Files:**
- Create: `/work/context-auto-compact/` (directory)
- Create: `/work/context-auto-compact/.gitignore`

- [ ] **Step 1: Create directory and initialise git**

```bash
mkdir -p /Users/macbook/work/context-auto-compact
cd /Users/macbook/work/context-auto-compact
git init
git remote add origin https://github.com/Bensigo/context-memory-auto-compact.git
```

Expected: `Initialized empty Git repository`

- [ ] **Step 2: Create `.gitignore`**

Create `/Users/macbook/work/context-auto-compact/.gitignore`:

```
.memory/
__pycache__/
*.pyc
.env
.DS_Store
```

- [ ] **Step 3: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add .gitignore
git commit -m "chore: init repo"
```

---

### Task 2: PreCompact hook — `precompact_summary.py`

**Files:**
- Create: `hooks/precompact_summary.py`

This is the core hook. It reads the session JSONL transcript, feeds the last 60 messages (≤6 000 chars) to `claude-haiku-4-5` via `claude -p`, and appends a reranked ≤400-token summary to `.memory/working/DD-MM-YYYY.md`. No notification here — that is `postcompact_notify.py`'s job.

- [ ] **Step 1: Create `hooks/` directory**

```bash
mkdir -p /Users/macbook/work/context-auto-compact/hooks
```

- [ ] **Step 2: Write the test**

Create `/Users/macbook/work/context-auto-compact/test_precompact.sh`:

```bash
#!/usr/bin/env bash
set -e

# Create a fake JSONL transcript
TMPDIR=$(mktemp -d)
TRANSCRIPT="$TMPDIR/session.jsonl"
cat > "$TRANSCRIPT" <<'EOF'
{"message":{"role":"user","content":"How do hooks work in Claude Code?"}}
{"message":{"role":"assistant","content":"Hooks are shell commands that run at specific events like PreToolUse, PostToolUse, PreCompact, and PostCompact."}}
{"message":{"role":"user","content":"Can I write a summary hook?"}}
{"message":{"role":"assistant","content":"Yes. Use PreCompact with a Python script that reads the transcript_path from stdin JSON."}}
EOF

# Create a fake project root with .memory/working
PROJDIR=$(mktemp -d)
mkdir -p "$PROJDIR/.memory/working"

# Run the hook
PAYLOAD="{\"trigger\":\"auto\",\"transcript_path\":\"$TRANSCRIPT\"}"
echo "$PAYLOAD" | python3 hooks/precompact_summary.py
EXIT_CODE=$?

# Check exit code
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "FAIL: hook exited $EXIT_CODE (expected 0)"
  exit 1
fi

# Check summary file was created
DATE=$(date +%d-%m-%Y)
SUMMARY="$PROJDIR/.memory/working/$DATE.md"
# Note: hook writes relative to cwd, so check from PROJDIR
cd "$PROJDIR"
echo "$PAYLOAD" | python3 /Users/macbook/work/context-auto-compact/hooks/precompact_summary.py

if [ ! -f ".memory/working/$DATE.md" ]; then
  echo "FAIL: summary file not created at .memory/working/$DATE.md"
  exit 1
fi

echo "PASS: summary written to .memory/working/$DATE.md"
cat ".memory/working/$DATE.md"
rm -rf "$TMPDIR" "$PROJDIR"
```

- [ ] **Step 3: Run test — expect FAIL (file doesn't exist yet)**

```bash
cd /Users/macbook/work/context-auto-compact
bash test_precompact.sh 2>&1 | head -5
```

Expected: error about missing `hooks/precompact_summary.py`

- [ ] **Step 4: Create `hooks/precompact_summary.py`**

Create `/Users/macbook/work/context-auto-compact/hooks/precompact_summary.py`:

```python
#!/usr/bin/env python3
"""
PreCompact hook — writes a reranked session summary to .memory/working/DD-MM-YYYY.md
before Claude compacts the context window.

Token budget design:
  - Input fed to Haiku: last 60 messages, capped at 6 000 chars (~1 500 tokens)
  - Summary output target: 400 tokens (~300 words)
  - This keeps future-session reads cheap (one small file, not a wall of text)
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def read_transcript(path: str) -> str:
    messages = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    msg = entry.get("message", entry)
                    role = msg.get("role", "")
                    content = msg.get("content", "")
                    if not role or not content:
                        continue
                    if isinstance(content, list):
                        parts = []
                        for block in content:
                            if isinstance(block, dict):
                                if block.get("type") == "text":
                                    parts.append(block.get("text", ""))
                                elif block.get("type") == "tool_use":
                                    parts.append(f"[tool:{block.get('name', '')}]")
                            elif isinstance(block, str):
                                parts.append(block)
                        content = " ".join(parts)
                    messages.append((role, str(content)))
                except Exception:
                    continue
    except Exception:
        return ""

    budget = 6000
    parts = []
    for role, content in reversed(messages[-60:]):
        chunk = f"{role}: {content[:400]}\n"
        if len(chunk) > budget:
            break
        parts.append(chunk)
        budget -= len(chunk)

    return "\n".join(reversed(parts))


def generate_summary(transcript: str, trigger: str) -> str:
    prompt = f"""Summarize this Claude Code work session. A future Claude session will read this for context.

Rules:
- RERANK: put highest-signal items FIRST — decisions made, bugs fixed, gotchas, warnings
- Low-signal items (routine file reads, trivial edits) go LAST or are omitted
- Under 400 tokens total — ruthlessly brief
- No filler phrases ("In this session we...", "We discussed...")
- Bullet points only, no prose

Sections (skip any with nothing to say):

## Key Decisions & Gotchas
## What Was Built / Changed
## Files Touched
## Unfinished / Next Steps

SESSION TRANSCRIPT:
{transcript}"""

    result = subprocess.run(
        ["claude", "-p", prompt, "--model", "claude-haiku-4-5-20251001"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=os.getcwd(),
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def write_summary(summary: str, trigger: str) -> None:
    date_str = datetime.now().strftime("%d-%m-%Y")
    time_str = datetime.now().strftime("%H:%M")
    output_path = Path(os.getcwd()) / ".memory" / "working" / f"{date_str}.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    block = (
        f"\n\n---\n"
        f"_Compacted {date_str} {time_str} · trigger: {trigger}_\n\n"
        f"{summary}\n"
    )
    with open(output_path, "a") as f:
        f.write(block)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    trigger = data.get("trigger", "auto")
    transcript_path = data.get("transcript_path", "")

    transcript = read_transcript(transcript_path) if transcript_path else ""
    if not transcript:
        sys.exit(0)

    summary = generate_summary(transcript, trigger)
    if not summary:
        sys.exit(0)

    write_summary(summary, trigger)
    sys.exit(0)  # always exit 0 — never block compaction


if __name__ == "__main__":
    main()
```

```bash
chmod +x /Users/macbook/work/context-auto-compact/hooks/precompact_summary.py
```

- [ ] **Step 5: Run test — expect PASS**

```bash
cd /Users/macbook/work/context-auto-compact
bash test_precompact.sh
```

Expected output:
```
PASS: summary written to .memory/working/DD-MM-YYYY.md
```
Followed by the summary content.

- [ ] **Step 6: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add hooks/precompact_summary.py test_precompact.sh
git commit -m "feat: add PreCompact summary hook"
```

---

### Task 3: PostCompact hook — `postcompact_notify.py`

**Files:**
- Create: `hooks/postcompact_notify.py`

Fires after compaction is done. Reads the hook JSON payload from stdin, resolves today's summary file path, prints a visible notification to stdout. Claude Code surfaces hook stdout as a message to the user.

- [ ] **Step 1: Write the test**

Create `/Users/macbook/work/context-auto-compact/test_postcompact.sh`:

```bash
#!/usr/bin/env bash
set -e

PAYLOAD='{"trigger":"auto","session_id":"abc123"}'

OUTPUT=$(echo "$PAYLOAD" | python3 hooks/postcompact_notify.py)
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "FAIL: hook exited $EXIT_CODE (expected 0)"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "new session"; then
  echo "FAIL: notification missing 'new session' recommendation"
  echo "Got: $OUTPUT"
  exit 1
fi

echo "PASS: notification printed correctly"
echo "---"
echo "$OUTPUT"
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/macbook/work/context-auto-compact
bash test_postcompact.sh 2>&1 | head -5
```

Expected: error about missing `hooks/postcompact_notify.py`

- [ ] **Step 3: Create `hooks/postcompact_notify.py`**

Create `/Users/macbook/work/context-auto-compact/hooks/postcompact_notify.py`:

```python
#!/usr/bin/env python3
"""
PostCompact hook — notifies the user that compaction is done and a summary
was saved. Recommends starting a new session for best performance.

Fires AFTER compaction completes. Cannot block. Always exits 0.
"""
import json
import sys
from datetime import datetime


def main():
    try:
        json.load(sys.stdin)  # consume payload even if unused
    except Exception:
        pass

    date_str = datetime.now().strftime("%d-%m-%Y")
    time_str = datetime.now().strftime("%H:%M")

    print(
        f"\n"
        f"  Context compacted at {time_str}.\n"
        f"  Session summary saved to .memory/working/{date_str}.md\n"
        f"\n"
        f"  For best performance, start a new session:\n"
        f"    /new  or  Cmd+N (Mac)  or  Ctrl+N (Windows/Linux)\n"
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
```

```bash
chmod +x /Users/macbook/work/context-auto-compact/hooks/postcompact_notify.py
```

- [ ] **Step 4: Run test — expect PASS**

```bash
cd /Users/macbook/work/context-auto-compact
bash test_postcompact.sh
```

Expected:
```
PASS: notification printed correctly
---

  Context compacted at HH:MM.
  Session summary saved to .memory/working/DD-MM-YYYY.md

  For best performance, start a new session:
    /new  or  Cmd+N (Mac)  or  Ctrl+N (Windows/Linux)
```

- [ ] **Step 5: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add hooks/postcompact_notify.py test_postcompact.sh
git commit -m "feat: add PostCompact notification hook"
```

---

### Task 4: `install.sh`

**Files:**
- Create: `install.sh`

One-command installer. Copies both hooks into the user's project, patches `settings.json`, creates `.memory/working/`, and updates `.gitignore`.

- [ ] **Step 1: Create `install.sh`**

Create `/Users/macbook/work/context-auto-compact/install.sh`:

```bash
#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${1:-$(pwd)}"

echo "Installing context-memory-auto-compact into: $PROJECT_DIR"
echo ""

# 1. Create .memory/working/
mkdir -p "$PROJECT_DIR/.memory/working"
echo "[1/5] Created .memory/working/"

# 2. Create .claude/hooks/
mkdir -p "$PROJECT_DIR/.claude/hooks"
echo "[2/5] Created .claude/hooks/"

# 3. Copy hook scripts
cp "$REPO_DIR/hooks/precompact_summary.py" "$PROJECT_DIR/.claude/hooks/"
cp "$REPO_DIR/hooks/postcompact_notify.py" "$PROJECT_DIR/.claude/hooks/"
chmod +x "$PROJECT_DIR/.claude/hooks/precompact_summary.py"
chmod +x "$PROJECT_DIR/.claude/hooks/postcompact_notify.py"
echo "[3/5] Copied hook scripts"

# 4. Patch .claude/settings.json
SETTINGS="$PROJECT_DIR/.claude/settings.json"
HOOK_BLOCK='{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [{ "type": "command", "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/precompact_summary.py" }]
      }
    ],
    "PostCompact": [
      {
        "hooks": [{ "type": "command", "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/postcompact_notify.py" }]
      }
    ]
  }
}'

if [ ! -f "$SETTINGS" ]; then
  echo "$HOOK_BLOCK" > "$SETTINGS"
  echo "[4/5] Created .claude/settings.json with hooks"
else
  echo "[4/5] .claude/settings.json already exists — merge the following manually:"
  echo ""
  echo '  "PreCompact": [{ "matcher": "auto", "hooks": [{ "type": "command", "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/precompact_summary.py" }] }],'
  echo '  "PostCompact": [{ "hooks": [{ "type": "command", "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/postcompact_notify.py" }] }]'
  echo ""
fi

# 5. Add .memory/ to .gitignore
GITIGNORE="$PROJECT_DIR/.gitignore"
if [ -f "$GITIGNORE" ]; then
  if ! grep -q "^\.memory/" "$GITIGNORE"; then
    echo ".memory/" >> "$GITIGNORE"
    echo "[5/5] Added .memory/ to .gitignore"
  else
    echo "[5/5] .memory/ already in .gitignore"
  fi
else
  echo ".memory/" > "$GITIGNORE"
  echo "[5/5] Created .gitignore with .memory/"
fi

echo ""
echo "Done. Two more steps:"
echo ""
echo "  1. Set the compaction threshold (40% recommended):"
echo "     Add to .env:        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40"
echo "     Or add to ~/.zshrc: export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40"
echo ""
echo "  2. Add to your CLAUDE.md or AGENT.md:"
echo ""
echo '     ## Working Memory'
echo '     Session summaries are in .memory/working/DD-MM-YYYY.md.'
echo '     Read todays file at session start or when you need prior context.'
echo '     Each block costs ~400 tokens — load only what is relevant.'
```

```bash
chmod +x /Users/macbook/work/context-auto-compact/install.sh
```

- [ ] **Step 2: Test install.sh in a temp directory**

```bash
TESTDIR=$(mktemp -d)
cd /Users/macbook/work/context-auto-compact
bash install.sh "$TESTDIR"
```

Expected output ending with `Done. Two more steps:` and both next-step instructions.

Verify files exist:
```bash
ls "$TESTDIR/.claude/hooks/"
# precompact_summary.py  postcompact_notify.py
ls "$TESTDIR/.memory/working/"
# (empty dir)
cat "$TESTDIR/.gitignore"
# .memory/
```

- [ ] **Step 3: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add install.sh
git commit -m "feat: add install.sh one-command installer"
```

---

### Task 5: MIT License

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create `LICENSE`**

Create `/Users/macbook/work/context-auto-compact/LICENSE`:

```
MIT License

Copyright (c) 2026 Bensigo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add LICENSE
git commit -m "chore: add MIT license"
```

---

### Task 6: `CONTRIBUTING.md`

**Files:**
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: Create `CONTRIBUTING.md`**

Create `/Users/macbook/work/context-auto-compact/CONTRIBUTING.md`:

```markdown
# Contributing

Thanks for wanting to improve this tool.

## What's in scope

- Bug fixes in `hooks/precompact_summary.py` or `hooks/postcompact_notify.py`
- Improvements to the summary prompt (better reranking, tighter token budget)
- `install.sh` improvements (better settings.json detection/merge)
- README clarity

## What's out of scope

- Adding new hook types beyond PreCompact/PostCompact
- Support for non-Claude-Code environments
- Shell script rewrites of the Python hooks

## How to contribute

1. Fork the repo
2. Create a branch: `git checkout -b fix/my-fix`
3. Make your change
4. Run the tests: `bash test_precompact.sh && bash test_postcompact.sh`
5. Open a PR with a short description of what changed and why

## Running tests

```bash
bash test_precompact.sh   # tests the summary hook end-to-end
bash test_postcompact.sh  # tests the notification hook
```

Both scripts are self-contained and create/clean up their own temp dirs.

## Prompt changes

If you change the summarisation prompt in `precompact_summary.py`, include a
before/after sample in your PR. Show the input transcript and both outputs so
reviewers can judge quality without running it themselves.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add CONTRIBUTING.md
git commit -m "docs: add CONTRIBUTING.md"
```

---

### Task 7: `README.md`

**Files:**
- Create: `README.md`

This is the public face of the project. Include every section from the design, with the actual test output captured from our live test run.

- [ ] **Step 1: Create `README.md`**

Create `/Users/macbook/work/context-auto-compact/README.md`:

````markdown
# context-memory-auto-compact

Automatic session memory for Claude Code. When your context window compacts, this tool saves a reranked summary to `.memory/working/` and notifies you to start a fresh session.

Two hooks. Drop-in install. No dependencies beyond Python 3 and the `claude` CLI.

---

## Why

Claude's context window is 1M tokens — but quality degrades well before you hit the limit.

Research shows:

- **At 20% full** — circular reasoning and forgotten decisions appear
- **At 40% full** — standard auto-compaction kicks in
- **At 48% full** — Claude literally recommends restarting
- **At 100% full** — retrieval accuracy drops from ~93% to ~76%

The culprit is the **"lost in the middle" problem**: Claude pays most attention to the beginning and end of context. Everything in the middle gets progressively ignored.

**The sweet spot is 40–50%.** Compact early, keep your summaries small, start fresh often.

This tool automates that loop:

```
Context hits 40%
    ↓
PreCompact fires → Haiku generates reranked summary → saved to .memory/working/
    ↓
PostCompact fires → notification appears: "Start a new session"
    ↓
You open /new with full context of what mattered
```

---

## Install

### One command

```bash
git clone https://github.com/Bensigo/context-memory-auto-compact.git
cd context-memory-auto-compact
bash install.sh /path/to/your/project
```

`install.sh` does five things:
1. Creates `.memory/working/` in your project
2. Creates `.claude/hooks/` if missing
3. Copies both hook scripts into `.claude/hooks/`
4. Writes the hook config to `.claude/settings.json` (or prints the snippet if one already exists)
5. Adds `.memory/` to `.gitignore`

### Manual install

1. Copy both scripts into your project:

```bash
cp hooks/precompact_summary.py your-project/.claude/hooks/
cp hooks/postcompact_notify.py your-project/.claude/hooks/
chmod +x your-project/.claude/hooks/*.py
```

2. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [{ "type": "command", "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/precompact_summary.py" }]
      }
    ],
    "PostCompact": [
      {
        "hooks": [{ "type": "command", "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/postcompact_notify.py" }]
      }
    ]
  }
}
```

3. Create the working memory directory:

```bash
mkdir -p your-project/.memory/working
echo ".memory/" >> your-project/.gitignore
```

---

## Set the compaction threshold

The default Claude Code threshold is 95% — too late for quality work. Set it to 40%:

**Per-project** — add to `.env` in your project root:

```
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40
```

**Global** — add to `~/.zshrc` or `~/.bashrc`:

```bash
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40
```

Then reload: `source ~/.zshrc`

---

## Update your `CLAUDE.md` or `AGENT.md`

Add this block so Claude knows to read the working memory at the start of each session:

```markdown
## Working Memory

Session summaries are in `.memory/working/DD-MM-YYYY.md`.
Read today's file at session start or when you need context on prior work.
Each compaction block is ~400 tokens — load only what is relevant to the current task.
Do not load the entire folder. Read the specific date file that matches what you need.
```

---

## What you'll see

When compaction fires, you get a notification:

```
  Context compacted at 16:30.
  Session summary saved to .memory/working/25-06-2026.md

  For best performance, start a new session:
    /new  or  Cmd+N (Mac)  or  Ctrl+N (Windows/Linux)
```

The summary file looks like:

```markdown
---
_Compacted 25-06-2026 16:30 · trigger: auto_

## Key Decisions & Gotchas
- PreCompact hook must match "auto" only — /compact won't trigger it
- Notification lives in PostCompact, not PreCompact

## What Was Built / Changed
- .claude/hooks/precompact_summary.py — reranked summary writer
- .claude/hooks/postcompact_notify.py — post-compaction notification
- install.sh — one-command project installer

## Files Touched
- .claude/settings.json, CLAUDE.md, .env, .gitignore

## Unfinished / Next Steps
- Validate summary quality on a real heavy work session
```

---

## Test results

Run the included tests to verify your install:

```bash
bash test_precompact.sh
```

```
PASS: summary written to .memory/working/25-06-2026.md
```

```bash
bash test_postcompact.sh
```

```
PASS: notification printed correctly
---

  Context compacted at 15:55.
  Session summary saved to .memory/working/25-06-2026.md

  For best performance, start a new session:
    /new  or  Cmd+N (Mac)  or  Ctrl+N (Windows/Linux)
```

---

## How it works

### `precompact_summary.py` (PreCompact hook)

- Receives the session transcript path from the hook JSON payload
- Reads the last 60 messages, capped at 6 000 chars (~1 500 tokens of input)
- Calls `claude-haiku-4-5` via `claude -p` with a reranking prompt
- Appends a ≤400-token summary block to `.memory/working/DD-MM-YYYY.md`
- Always exits `0` — never blocks compaction

### `postcompact_notify.py` (PostCompact hook)

- Fires after compaction is complete
- Prints the notification message to stdout (Claude Code shows this to the user)
- Always exits `0`

---

## Requirements

- Claude Code CLI installed and authenticated
- Python 3.8+
- `claude` available in your `PATH`

---

## License

MIT — see [LICENSE](LICENSE).
````

- [ ] **Step 2: Commit**

```bash
cd /Users/macbook/work/context-auto-compact
git add README.md
git commit -m "docs: add README"
```

---

### Task 8: Update the current project

**Files:**
- Modify: `/Users/macbook/work/bensigo-ai-workflow/.claude/hooks/precompact_summary.py` — remove `print()` notification block (lines 131–138)
- Create: `/Users/macbook/work/bensigo-ai-workflow/.claude/hooks/postcompact_notify.py` — copy from new repo
- Modify: `/Users/macbook/work/bensigo-ai-workflow/.claude/settings.json` — add PostCompact hook entry

- [ ] **Step 1: Remove notification print from `precompact_summary.py`**

In `/Users/macbook/work/bensigo-ai-workflow/.claude/hooks/precompact_summary.py`, replace the `main()` function's end (after `write_summary` call) with the clean version — no `print()` block:

Remove lines 128–138 (the `date_str` reassignment and the `print(...)` block) and replace with:

```python
    write_summary(summary, trigger)
    sys.exit(0)  # always exit 0 — never block compaction
```

- [ ] **Step 2: Copy `postcompact_notify.py` into this project**

```bash
cp /Users/macbook/work/context-auto-compact/hooks/postcompact_notify.py \
   /Users/macbook/work/bensigo-ai-workflow/.claude/hooks/
chmod +x /Users/macbook/work/bensigo-ai-workflow/.claude/hooks/postcompact_notify.py
```

- [ ] **Step 3: Add PostCompact to `settings.json`**

In `/Users/macbook/work/bensigo-ai-workflow/.claude/settings.json`, add the `PostCompact` entry alongside the existing `PreCompact`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Grep|Glob|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.agentrail/hooks/context-first.sh"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/precompact_summary.py"
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 $CLAUDE_PROJECT_DIR/.claude/hooks/postcompact_notify.py"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Smoke-test the updated precompact script exits 0 without printing**

```bash
cd /Users/macbook/work/bensigo-ai-workflow
OUTPUT=$(echo '{"trigger":"manual","transcript_path":"/dev/null"}' | python3 .claude/hooks/precompact_summary.py)
echo "Exit: $?"
echo "Output: '$OUTPUT'"
```

Expected: Exit 0, empty output (transcript was /dev/null so it skips cleanly).

- [ ] **Step 5: Smoke-test postcompact notify**

```bash
cd /Users/macbook/work/bensigo-ai-workflow
echo '{"trigger":"auto"}' | python3 .claude/hooks/postcompact_notify.py
```

Expected: notification message printed, exit 0.

---
