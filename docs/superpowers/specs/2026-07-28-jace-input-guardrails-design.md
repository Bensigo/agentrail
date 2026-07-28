# Jace input guardrails — moderation, injection screening, PII cleansing

**Date:** 2026-07-28 · **Status:** approved (owner) · **Migration slot:** `0057`

## Problem

The owner's words: *"we guide add input guiderails for Jace (top priority)."*

Jace has **no input guardrails at all**. Every message a stranger DMs the shared
Telegram/Discord/Slack bot, and every message a member types into console chat,
reaches the model verbatim. An audit of all four inbound paths found:

| Guardrail | Status today |
| --- | --- |
| Moderation | Absent. No moderation call exists anywhere in the repo. |
| Jailbreak / prompt injection | Absent on Jace. `agentrail/guardrails/policies/input_contract.py` screens 12 injection patterns, but it gates **GitHub issues entering the AFK queue** — never a chat message. |
| PII detection / cleansing | Absent. `apps/console/lib/secret-scan.ts` scans *committed code* for API keys; it has no notion of a card number, IBAN, or SSN, and never sees chat input. |

What exists and is easy to mistake for coverage: Jace's
`agent/lib/sanitize-untrusted.core.mjs` (`hardenUntrusted`). It is
**outbound-only** — applied when Jace *renders* to GitHub or a channel — and its
own header states it "cannot neutralize … natural-language instruction
injection." It is not an input guardrail and was never intended as one.

## The chokepoint

Every channel converges on one place. Telegram, Discord, Slack and console all
enqueue into `channel_inbox`, and `dispatchQueuedChannelMessages()` in
`apps/console/lib/channel-dispatch.ts` drains it. Both branches end at the same
call:

- `processRow` (telegram / discord / slack) → `runEveTurn({ message: payload.text })`
- `processConsoleRow` (console) → `runEveTurn({ message: payload.text })`

Nothing bypasses this. Screening here covers all four channels with one seam,
and runs **before the Eve turn starts**, so a blocked message costs zero model
tokens.

Screening at dispatch rather than at each webhook is deliberate: one seam
instead of four, and the `channel_inbox` row is already durable when screening
runs, so the audit trail is complete even if the process dies mid-screen.

## Design

Three layers, cheapest first. Layers 1–2 are pure and always run; layer 3 is the
only one that touches the network.

```
apps/console/lib/guardrails/
  input-guardrails.ts       ← orchestrator. pure, no I/O
  pii.ts                    ← Luhn-validated cards, IBAN, SSN, ABA, sort code
  injection.ts              ← 12 patterns ported from input_contract.py
  moderation.ts             ← the ONE network call; injectable fetch
  feature-flags.ts          ← kill-switch only
  fixtures/injection-corpus.json
  *.test.ts                 ← colocated, vitest (console convention)
```

### Entry point

```ts
// pure, synchronous — layers 1 and 2
screenInboundMessage(
  text: string,
  opts: { trust: "bound" | "stranger" }
): {
  verdict: "allow" | "redact" | "block";
  text: string;          // cleansed when verdict === "redact"
  findings: Finding[];
}

// layer 3, separate so the pure core needs no network stub in tests
moderateInbound(
  text: string,
  deps?: { fetch?: typeof fetch; apiKey?: string }
): Promise<{ verdict: "allow" | "block" | "error"; category?: string }>
```

### Layer 1 — PII detection and cleansing

**Posture: redact and continue.** A card number becomes `[redacted:card]`, the
turn proceeds with the cleansed text, and the user gets a one-line in-channel
note. Blocking would throw away the user's actual request over a detail they can
simply restate.

Detectors: payment cards (Luhn-validated, not bare 16-digit runs), IBAN
(mod-97 checksum), US SSN, ABA routing number (checksum), UK sort code.
Checksums are mandatory where the format defines one — they are what separates a
card number from an order number.

Input is normalized through the existing `stripInvisibles` logic before matching,
so zero-width characters cannot split a card number past the regex. This reuses
`hardenUntrusted`'s proven character classes on the **inbound** direction, where
they have never been applied.

### Layer 2 — Injection / jailbreak screening, tiered by trust

The 12 patterns from `input_contract.py::screen_injection` port to TypeScript
verbatim. Posture depends on who is speaking, read from the identity spine that
`channel-dispatch.ts` already resolves:

| Sender | Posture |
| --- | --- |
| **stranger** — `chat_identity` with no resolved workspace (the existing intro path) | **BLOCK.** Matches `input_contract.py`'s hard-REJECT precedent. |
| **bound** — identity resolved to a workspace; all console senders | **WARN.** Finding recorded, text unicode-hardened, turn proceeds. |

The tier exists because of a concrete false positive: this team talks to Jace
*about building injection guardrails*. "Add a pattern for `ignore previous
instructions`" must not be blocked. The threat model is a stranger DMing a shared
bot — not the workspace owner, who can already direct Jace by legitimate means.

### Layer 3 — Moderation

**Model:** `meta-llama/llama-guard-4-12b` via OpenRouter — a purpose-built
classifier with the MLCommons hazard taxonomy in its weights. Send the message
as a single user turn; it returns `safe`, or `unsafe\nS<N>`.

Chosen as the **cheapest option** once total cost is counted, not just the
prompt rate:

| Model | Per message | Why |
| --- | --- | --- |
| `meta-llama/llama-guard-4-12b` | **$0.0000459** | taxonomy in weights, ~3-token verdict |
| `openai/gpt-oss-safeguard-20b` (low effort) | $0.000063 | +400-token policy in every prompt |
| `openai/gpt-oss-safeguard-20b` (default) | $0.00012 | …plus reasoning trace at 4× completion rate |

`gpt-oss-safeguard`'s cheaper $0.075/M prompt rate is more than offset by its
$0.30/M completion rate, the policy that must be sent on every call, and its
reasoning trace. Llama Guard is also not a Claude model, satisfying the standing
candidate-diversity rule.

Request is pinned: `max_tokens: 16`, `temperature: 0`, 2s timeout, no retry.
**Posture: block, with a neutral refusal.**

`OPENROUTER_API_KEY` must be added to the **console** Railway service. It lives
on the runner/fleet service today; console's only OpenRouter touch is the
unauthenticated catalog fetch in `lib/alignment/gateway-catalog.ts`. This is the
one manual deploy step. Absent the key, layer 3 disables itself and logs once —
layers 1–2 are unaffected, so the PR is useful before the variable is set.

## Failure posture

**Fail-open on moderation; fail-closed on nothing.** A timeout, non-200, or
unparseable body → allow the turn, write an audit row with
`detector: "model", verdict: "error"`, log once. An OpenRouter outage must not
become a Jace outage, and the deterministic layers have already run — the
message is not unscreened.

Nothing throws into the drain loop, honouring `processRow`'s existing
"never kill the loop" invariant.

A blocked row is **completed, not failed**. `failChannelMessage` requeues, which
would replay the identical block at the user N times.

Block notices go out through the seams that already exist:
`sendSystemChannelMessage` for telegram/discord/slack, `appendJaceMessage` for
console.

## Audit table — `guardrail_events` (migration `0057`)

Slots `0055`/`0056` are reserved by the briefs arc; the journal ends at `0054`.

Columns: `id`, `workspace_id` (nullable), `chat_identity_id` (nullable),
`channel`, `conversation_key`, `category` (`pii` | `injection` | `moderation`),
`verdict` (`allow` | `redact` | `block` | `error`), `detector`
(`deterministic` | `model`), `match_types` (jsonb), `content_sha256`,
`created_at`.

**No raw message text is ever stored** — only a SHA-256 of the normalized text
plus match *types* and offsets. Persisting the PII you just redacted would
defeat the guardrail. The nullable workspace/identity pair mirrors
`channel_inbox`'s own anchor convention, so an intro-path block is still
attributable.

## Rollout

Deliberate deviation from the house default-OFF flag convention, approved by the
owner: that convention governs **features**, and this is a safety floor.

- Layers 1–2: **default ON**, no flag. No credential, no network, no cost, no
  latency — there is nothing to roll out safely.
- Layer 3: ON when `OPENROUTER_API_KEY` is present on console.
- Escape hatch: `JACE_INPUT_GUARDRAILS_DISABLED`, a kill-switch, not an
  enable-flag.

## Testing

vitest, colocated, matching console convention.

1. **PII — negative controls carry more weight than positives.** A false
   positive silently corrupts a legitimate message. Negatives: git SHAs, order
   and invoice numbers, version strings, port numbers, 16-digit non-Luhn ids,
   phone numbers, issue refs. Positives: Luhn-valid Visa/MC/Amex, IBAN, SSN, ABA,
   sort code — each also asserted with zero-width characters interleaved.
2. **Injection** — the shared corpus. `agentrail/guardrails/fixtures/injection_corpus.json`
   has 9 issue-shaped cases (6 reject / 3 admit); the new fixture reuses its exact
   schema, seeds from it, and adds chat-shaped cases. A cross-check test asserts
   the TS deny-list agrees with the Python one on every shared case, so the two
   cannot drift. Every case is asserted at **both** trust tiers.
3. **Moderation** — injectable `fetch`. Cases: safe, unsafe + category, malformed
   body, timeout, missing key.
4. **Integration**, at both `channel-dispatch.ts` call sites: a block completes
   the row (never fails it) and sends the notice; a redact passes the **cleansed**
   text through to `runEveTurn`; a moderation error still runs the turn.

## Out of scope

- Output moderation on Jace's replies. `hardenUntrusted` covers the render seams.
- Per-workspace policy tuning or an admin UI for thresholds.
- Approval-callback rows (`kind: "approval_response"`), which carry no free text.
- iMessage, which has no inbound HTTP surface (LoopMessage is outbound-only).
