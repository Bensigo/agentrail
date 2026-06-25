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
                    # transcript entries wrap the message under 'message' key
                    msg = entry.get("message", entry)
                    role = msg.get("role", "")
                    content = msg.get("content", "")
                    if not role or not content:
                        continue
                    # flatten content blocks
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

    # last 60 messages, most recent first, within 6 000 char budget
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
        sys.exit(0)  # never block compaction

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
