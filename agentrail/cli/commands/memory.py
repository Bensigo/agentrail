"""
``agentrail memory`` — native recall/capture (port of the legacy
``templates/scripts/memory`` helper; M5 / #432).
"""
from __future__ import annotations

import os
import sys
from typing import List

from agentrail.cli.commands.memory_core import memory_capture, memory_recall


def _usage() -> str:
    return "Usage:\n  agentrail memory <subcommand> [--target DIR] [args...]\n"


def run_memory(args: List[str]) -> int:
    if not args:
        print(_usage(), file=sys.stderr)
        return 1
    if args[0] in ("-h", "--help"):
        print(_usage())
        return 0

    kind = args[0]
    rest = args[1:]
    target = os.getcwd()
    passthrough: List[str] = []

    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--target":
            # value must exist and must not start with '--'
            if i + 1 >= len(rest) or rest[i + 1].startswith("--"):
                print("--target requires a directory", file=sys.stderr)
                return 2
            target = rest[i + 1]
            i += 2
        elif a in ("-h", "--help"):
            print(_usage())
            return 0
        else:
            # everything else — including unknown --flags — is passthrough
            passthrough.append(a)
            i += 1

    if kind == "recall":
        query = " ".join(passthrough)
        if not query:
            print("memory: recall requires a query", file=sys.stderr)
            return 1
        text, rc = memory_recall(query, target)
        if text:
            print(text)
        return rc

    if kind in ("capture", "new"):
        if not passthrough:
            print("memory: capture requires a kind", file=sys.stderr)
            return 1
        capture_kind = passthrough[0]
        title = " ".join(passthrough[1:])
        if not title:
            print("memory: capture requires a title", file=sys.stderr)
            return 1
        print(memory_capture(capture_kind, title))
        return 0

    print(_usage(), file=sys.stderr)
    return 2
