"""Deterministic query-expansion (recall) layer for the Context Compiler (#1043).

The hybrid retriever (``query_context``) tokenizes the task query into a set of
lexical tokens that seed BM25 doc-frequency, pre-scoring, and the candidate
filter.  ``tokenize`` lowercases *before* splitting and keeps snake_case whole,
so an identifier query like ``query_context`` stays a single token and a
camelCase query like ``queryContext`` collapses to ``querycontext`` — the
sub-identifier boundaries a code search wants to recall on are already lost by
the time the retriever sees ``query_tokens``.

This module widens the retrieval token set by recovering those boundaries.  It
splits identifier-like runs found in the RAW query on ``_ - . /`` and
camelCase/PascalCase boundaries, and UNIONs the resulting subtokens into the
query token set so a chunk that spells the boundary out (``def query`` in a file
about ``context``) is recalled even though the raw query only said
``query_context``.

Every added term is a real substring of an identifier the user typed, so this
widens recall without pulling in unrelated vocabulary.  Two precision guards
keep it from collapsing precision:

  * a subtoken is only added when it is NOT already a base token (originals are
    never duplicated and never removed), and
  * a subtoken shorter than ``min_added_len`` is dropped — 1-2 char fragments
    (``io``, ``db``) are too generic to be a useful recall signal and would only
    dilute scoring.

The layer is fully deterministic (same input → identical output — no randomness,
no network, no clock) and toggleable via ``query_expansion_enabled``.  It
defaults **OFF** for rollout safety: the pre-expansion baseline is what runs
until the flag is explicitly turned on.

This module is intentionally self-contained (it imports nothing from
``retrieval.py``) so the retriever can import it without a cycle.
"""
from __future__ import annotations

import os
import re
from typing import List, Tuple

# Identifier-like runs in the RAW query: an ASCII letter followed by any run of
# identifier / member / path / kebab characters.  Kept deliberately close to the
# characters that make up code identifiers, dotted members, kebab-case names and
# path fragments so we recover boundaries from exactly the spans a code search
# cares about (and ignore pure punctuation / numbers).
_IDENTIFIER_RUN = re.compile(r"[A-Za-z][A-Za-z0-9_.\-/]*")

# camelCase / PascalCase / acronym split applied to each ``_ - . /``-delimited
# part.  The leading alternative keeps an acronym run together up to the last
# capital that starts the next word (``HTTPServer`` -> ``HTTP`` + ``Server``);
# the remaining alternatives capture normal Capitalized / lowercase / digit
# words and trailing all-caps acronyms.
_CAMEL_SPLIT = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z0-9]*|[a-z0-9]+|[A-Z]+")

# Non-camel delimiters we split identifier runs on before the camel split.
_DELIMITERS = re.compile(r"[_\-./]+")

# Truthy values for the (default-OFF) expansion flag.  Mirrors the shape of
# ``rerank_enabled`` in rerank.py but inverts the default: this flag is OFF
# unless explicitly enabled.
_TRUTHY = {"1", "true", "on", "yes"}


def query_expansion_enabled() -> bool:
    """Whether the deterministic query-expansion (recall) layer runs.

    Defaults to **OFF** (rollout safety): returns ``False`` when
    ``AGENTRAIL_CONTEXT_QUERY_EXPANSION`` is unset, and ``True`` only for the
    truthy values ``{"1", "true", "on", "yes"}`` (case/space-insensitive).  Any
    other value (``0``/``false``/``off``/``no`` or anything unrecognized) is
    treated as OFF.
    """
    raw = os.environ.get("AGENTRAIL_CONTEXT_QUERY_EXPANSION")
    if raw is None:
        return False
    return raw.strip().lower() in _TRUTHY


def _subtokens(query: str) -> List[str]:
    """Deterministically split the RAW query into lowercased identifier subtokens.

    For each identifier-like run, split on ``_ - . /`` boundaries, then split
    each fragment on camelCase/PascalCase boundaries, lowercasing every piece.
    Order follows the query left-to-right (and within a run, boundary order),
    so the output is stable for a given input.
    """
    out: List[str] = []
    for run in _IDENTIFIER_RUN.findall(query):
        for part in _DELIMITERS.split(run):
            if not part:
                continue
            for piece in _CAMEL_SPLIT.findall(part):
                out.append(piece.lower())
    return out


def expand_query_tokens(
    query: str,
    base_tokens: List[str],
    *,
    min_added_len: int = 3,
) -> Tuple[List[str], List[str]]:
    """Widen ``base_tokens`` with identifier subtokens recovered from ``query``.

    Splits identifier-like runs in the RAW ``query`` (see module docstring) and
    adds any subtoken that is a genuinely new recall signal, subject to two
    precision guards:

      * the subtoken is NOT already present in ``base_tokens`` (originals are
        never duplicated), and
      * ``len(subtoken) >= min_added_len`` (drop 1-2 char fragments).

    Originals are always preserved, in their original order and never dropped.

    Returns ``(expanded_tokens, added_terms)`` where:
      * ``expanded_tokens`` = the originals (original order) followed by the
        newly added subtokens (deduped, first-seen order), and
      * ``added_terms`` = the sorted, deduped list of newly added subtokens.

    Fully deterministic: same input → identical output.
    """
    base_set = set(base_tokens)
    added: List[str] = []
    added_set = set()
    for sub in _subtokens(query):
        if len(sub) < min_added_len:
            continue
        if sub in base_set or sub in added_set:
            continue
        added_set.add(sub)
        added.append(sub)
    expanded_tokens = list(base_tokens) + added
    added_terms = sorted(added_set)
    return expanded_tokens, added_terms
