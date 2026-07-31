# Regression after deploy

## Shape

A symptom starts shortly after a release, and the working theory walking in
the door is "something we shipped broke this." First-seen sits close to a
known deploy time; the witness interview usually already suspects this
before the first round starts.

## Mission composition

Round 1 is always a change-sweep mission — "what changed in the window
before onset" — biasing toward the `change` investigator's `fetch_changes`
sweep, not a broad anomaly hunt. Once candidates come back ranked, round 2
narrows: a hypothesis-test mission on the leading candidate, correlating
its landing time against symptom onset with `search_events`, scoped tight
to the failing surface — not a second wide sweep.

## Verbs emphasized

`changes` first and heaviest — deploys, merged PRs, config edits,
migrations landing in the window. `search_events` second, to correlate a
candidate's landing with the moment the symptom actually started, not just
"landed sometime before."

## Stabilize tie-in

This is the shape where the stabilize check earns its keep: a
deploy-correlated onset means surfacing the rollback candidate
immediately, before round 2 has even run — a bad deploy is cheap to
reverse, and reversing it buys time to investigate the rest safely.

## The classic trap

Recency bias. The most recent deploy is the easiest hypothesis to reach
for — it's right there, freshly landed — but "most recent" and "actually
caused it" are different claims. A config flag flipped an hour earlier, a
slow-burning migration, or an upstream dependency's own change can produce
an identical symptom and have nothing to do with the latest deploy. The
hypothesis ledger discipline exists exactly for this: hold at least two
live hypotheses, or record explicitly why only one was ever plausible —
never let the newest change become the only one considered just because
it's the most convenient.

## Discriminating tests

- Does the symptom's onset line up with the suspect deploy's own
  timestamp, or does it line up with a traffic or cohort shift that has no
  deploy anywhere near it? A twenty-minute gap between deploy and onset is
  a much weaker link than a ninety-second one — and a shift with no deploy
  nearby at all argues against every deploy-shaped hypothesis in the
  round.
- Did the error signature change SHAPE at onset — a new error type or
  stack trace — or only RATE, the same errors just more of them? A shape
  change points at the deploy's own logic; a pure rate increase with an
  unchanged signature points elsewhere — capacity, traffic, an upstream
  dependency — even with a deploy sitting right next to it on the
  timeline.
