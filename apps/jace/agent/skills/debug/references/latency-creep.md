# Latency creep

## Shape

Latency has been drifting worse gradually — hours or days, not a sharp
step at a single moment — with no obvious single trigger the witness
interview surfaced. This is a different shape from a deploy regression,
and the mission composition should not default to a change sweep first.

## Mission composition

Round 1 leads with an anomaly-shaped mission — "where and when does
latency deviate from baseline" — biasing toward the `anomaly` investigator
over `change`. Expect this to surface a `no_provider` gap on the `signals`
verb: RED/USE-style latency percentiles have no v1 provider at all, so
this is an honest, expected outcome, not a failed round. Voice the
resulting capability nudge once, then keep working with what
`search_events` and `changes` can actually answer: request-duration
fields logged inline, timeout errors, queue-depth lines, and —
secondarily — any slow-burning change (a growing dataset, a cache
eviction pattern, a gradually degrading dependency) that could plausibly
track the same drift.

## Verbs emphasized

`search_events` first — log-line evidence of latency is the only lever
available without a `signals` provider. `changes` second, checked against
the SAME drifting window for anything that trends rather than steps.

## The classic trap

Averaging hides p99. A blended, whole-system latency number can look
flat, or only mildly elevated, while the tail — one route, one tenant, one
region — has degraded severely. Reading one aggregate number and
concluding "mostly fine" is how a real, isolated problem gets missed for
days; the same trap applies even without a percentile-aware provider, the
moment "most requests look okay" gets accepted instead of cutting the
data.

## Discriminating tests

- Cut the same window by cohort — route, tenant, region, plan tier —
  instead of reading one blended number. A creep that is actually isolated
  to one heavy tenant or one slow route reads as a small global drift
  until it is cut this way; cutting it is usually enough to settle whether
  this is systemic or narrow.
- Which surface moved first? Of everything showing elevated latency, order
  it by when the drift actually started. The earliest mover is the
  strongest candidate for cause; everything that started drifting later is
  more likely downstream of it — a queue backing up behind one slow
  dependency looks, from a distance, like everything degrading at once.
