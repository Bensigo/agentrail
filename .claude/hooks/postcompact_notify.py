#!/usr/bin/env python3
"""
PostCompact hook — notifies the user that compaction is done and a summary
was saved. Recommends starting a new session for best performance.

Fires AFTER compaction completes. Per the Claude Code hooks docs, PostCompact
is a "no decision control" event: it has NO JSON output processing (so
`systemMessage`/`additionalContext` are ignored) and plain stdout only reaches
the debug log. The ONLY documented way to surface text to the user is to write
to stderr and exit 2. Compaction has already finished, so the non-zero exit
cannot block anything — it just renders the message.
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

    message = (
        f"Context compacted at {time_str}. "
        f"Session summary saved to .memory/working/{date_str}.md. "
        f"For best performance, start a new session (/new, Cmd+N, or Ctrl+N)."
    )

    print(message, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
