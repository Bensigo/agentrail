# Cannot reproduce

## Shape

The reported symptom will not reproduce on demand — it works fine when
tried again with what looks like the same steps. The temptation is to
treat this as evidence the report was wrong, or that the bug is a
one-off not worth chasing. Neither follows from "didn't reproduce once."

## Mission composition

Round 1 is not an evidence round at all — it is going back to the witness
interview for more precision: exact account or tenant, client/browser
version, region, feature-flag bucket, time of day, the specific data
involved. A mission dispatched on an under-specified symptom wastes a
round on a sweep broad enough to find nothing and narrow enough to prove
nothing. Once the conditions are sharper, round 2 dispatches a mission
scoped to that EXACT cohort — "does this account, this route, this
version show anything in this window" — never a generic system-wide
sweep.

## Verbs emphasized

`search_events`, scoped as narrowly as the witness interview allows — the
specific account, route, client version, or region the human actually
named, not a wide net. `changes` secondary, checked against that same
narrow scope rather than the whole system.

## The classic trap

Declaring it a heisenbug too early. A symptom that will not reproduce on
the first attempt is not evidence that it does not exist — it is evidence
that the reproduction conditions are not narrow enough yet. Writing it off
here is how a real, cohort-specific bug quietly disappears from the ledger
before anyone ever finds the condition that actually triggers it.

## Discriminating tests

- Probe the EXACT cohort the witness named — not a generic retry, but the
  same account, route, client version, and time-of-day pattern — before
  drawing any conclusion about whether this reproduces.
- Diff the environment between the original report and a clean attempt:
  client version, feature-flag bucket, request region, the shape of the
  data involved. Which of these differs is often the entire discriminator
  between "reproduces" and "doesn't."

## Honest undetermined

If the depth budget runs out before the exact cohort is pinned down,
`undetermined` is the correct and honest close — with a missing-evidence
list naming SPECIFICALLY what would settle it next time: a report with
the account id and client version attached, a session replay for one
occurrence, whatever is concretely missing. Never a guessed cause dressed
up with unearned confidence, and never a quiet write-off just because it
didn't reproduce on the first try.
