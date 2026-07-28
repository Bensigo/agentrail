/**
 * Layer 2 — injection / jailbreak screening, tiered by trust (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md, "Layer 2").
 *
 * This is a verbatim behavioural port of the 12 deny-list patterns in
 * `agentrail/guardrails/policies/input_contract.py::_INJECTION_PATTERNS` /
 * `screen_injection()`. That module screens a GitHub issue body on the way
 * INTO the AFK queue; this module screens a chat message on the way INTO an
 * Eve turn. Same patterns, same match order, same reasons, same
 * case-insensitivity — only the caller and the trust-tiered posture are new.
 *
 * Why the deny-list is narrow (ported straight from `input_contract.py`'s own
 * module docstring, because the same design pressure applies here): the list
 * targets directives *aimed at the agent* — override the gate, reassign its
 * role, exfiltrate secrets, run remote code, impersonate a privileged role —
 * NOT any mention of the words "agent", "instructions", "secret", or "print".
 * A single match is enough to flag; the negative controls in
 * `fixtures/injection-corpus.json` are what prove the list is not
 * over-broad, and matter more than the positive cases: this team's own chat
 * routinely discusses building and reviewing this exact deny-list ("add a
 * pattern for `ignore previous instructions`" must not itself become an
 * unreviewable false positive against the team building it).
 *
 * Why trust tiers exist (spec, "Layer 2"): the threat model is a stranger
 * DMing the shared bot, not a workspace member who can already direct Jace by
 * legitimate means and who may be talking ABOUT this very guardrail. So the
 * same match is a hard `block` for a `stranger` and only a recorded `warn`
 * (the turn still proceeds) for a `bound` sender. See `screenInjection`.
 *
 * Python → TypeScript regex translation notes (read carefully before editing
 * a pattern — these are the exact traps the port has to avoid):
 *   - Python's inline `(?i)` becomes the JS `i` flag; `(?im)` becomes `im`.
 *   - Python does NOT set `re.S` (DOTALL) on any of these patterns, so `.`
 *     must NOT match newlines here either — the ported patterns deliberately
 *     omit the JS `s` flag to preserve that.
 *   - None of the 12 patterns use the JS `g` (or `y`) flag. That is
 *     deliberate, not an oversight: `RegExp.prototype.exec` only tracks
 *     `lastIndex` state across calls when `g`/`y` is set, so leaving it off
 *     makes every `exec` call in this module inherently stateless — no
 *     `lastIndex` to reset, no risk of the classic "matches every other
 *     call" bug. `injection.test.ts` has a regression test that calls
 *     `detectInjection` twice on the same input and asserts identical
 *     results, precisely to guard this invariant.
 */
import type { Finding, GuardrailTrust } from "./types.js";

/**
 * The ported deny-list. Order matters: `detectInjection` returns the FIRST
 * matching pattern (mirrors `screen_injection`'s `for pattern, reason in
 * _INJECTION_PATTERNS: if pattern.search(body): return reason`), so patterns
 * that overlap in what they can match (e.g. pattern 3's role-reassignment
 * "you are now ... developer mode" versus pattern 4's bare "developer mode"
 * literal) are ordered the same as the Python tuple so the reported reason
 * for an overlapping case stays identical between the two implementations.
 *
 * Each `id` is stable and becomes `Finding.type` (stored in
 * `guardrail_events.match_types`). Ids are derived from the shared corpus's
 * case ids where a pattern corresponds 1:1 to one of the original 6 `reject`
 * cases; the other patterns (which the original 9-case corpus never isolated
 * on their own) get a descriptive id instead.
 *
 * Exported (not just used internally) so `injection.test.ts` can enumerate it
 * for the Python cross-check — the test drives both implementations off the
 * same corpus, not off this list directly, but having it public keeps the
 * two decision procedures inspectable side by side.
 */
export const INJECTION_PATTERNS: ReadonlyArray<{
  id: string;
  pattern: RegExp;
  reason: string;
}> = [
  {
    id: "ignore_previous_instructions",
    pattern: /\bignore\s+(all\s+|any\s+)?(the\s+)?previous\s+instructions?\b/i,
    reason: "prompt-injection: 'ignore previous instructions' override directive",
  },
  {
    id: "disregard_system_prompt",
    pattern:
      /\bdisregard\s+(your\s+|the\s+|all\s+)?(system\s+prompt|instructions?|objective\s+gate)\b/i,
    reason: "prompt-injection: 'disregard system prompt / gate' directive",
  },
  {
    id: "you_are_now_dev_mode",
    pattern: /\byou\s+are\s+now\b.*\b(developer\s+mode|unrestricted|no\s+guardrails|dan)\b/i,
    reason: "prompt-injection: role-reassignment / jailbreak ('you are now …')",
  },
  {
    // Bare literal deny of these words/phrases, independent of "you are now".
    // Deliberately over-inclusive (ported verbatim from Python): ANY mention
    // of "developer mode", "jailbreak", "no guardrails" or "without
    // guardrails" trips this, even a legitimate mention. That is the
    // Python source's own tradeoff, not something this port corrects.
    id: "developer_mode_bare",
    pattern: /\b(developer\s+mode|jailbreak|no\s+guardrails|without\s+(any\s+)?guardrails)\b/i,
    reason: "prompt-injection: jailbreak / disable-guardrails directive",
  },
  {
    id: "act_as_unrestricted",
    pattern: /\bact\s+as\s+(an?\s+)?(unrestricted|uncensored|jailbroken)\b/i,
    reason: "prompt-injection: 'act as an unrestricted agent' role directive",
  },
  {
    id: "print_secret_exfiltration",
    pattern:
      /\bprint\b.*\b(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|[A-Z0-9_]*SECRET[A-Z0-9_]*|[A-Z0-9_]*TOKEN[A-Z0-9_]*|[A-Z0-9_]*API_?KEY[A-Z0-9_]*)\b/i,
    reason:
      "prompt-injection: secret-exfiltration directive (print a credential / env secret)",
  },
  {
    id: "leak_credential_directive",
    pattern: /\b(exfiltrate|leak|dump|reveal)\b.*\b(secret|credential|token|api[_ ]?key|\.env)\b/i,
    reason: "prompt-injection: secret-exfiltration directive",
  },
  {
    id: "curl_pipe_bash",
    pattern: /\bcurl\b[^\n|]*\|\s*(bash|sh|zsh)\b/i,
    reason: "prompt-injection: remote-code-execution pattern (curl … | bash)",
  },
  {
    id: "wget_pipe_sh",
    pattern: /\bwget\b[^\n|]*\|\s*(bash|sh|zsh)\b/i,
    reason: "prompt-injection: remote-code-execution pattern (wget … | sh)",
  },
  {
    id: "impersonated_role_override",
    pattern: /^\s*(system|assistant|developer)\s*:\s*.*\b(override|auto[- ]?approve|approve|bypass)\b/im,
    reason: "prompt-injection: impersonated privileged role trying to override the approval gate",
  },
  {
    id: "override_approval_gate_directive",
    pattern:
      /\b(override|bypass|skip|disable)\b.*\b(human\s+)?(approval|review)\s+(gate|step|process)?\b.*\b(auto[- ]?approve|do\s+not\s+ask)\b/i,
    reason: "prompt-injection: directive to override the human approval / review gate",
  },
  {
    id: "merge_approve_without_review",
    pattern: /\b(merge|approve|auto[- ]?approve)\b.*\b(without|no|skip(ping)?)\s+review\b/i,
    reason: "prompt-injection: directive to merge/approve without review",
  },
];

/**
 * First matching pattern in `INJECTION_PATTERNS` order, or `null` when the
 * text is clean. Pure — no I/O, no mutation, no shared state — and safe to
 * call repeatedly on the same input (see the "regex statelessness" note in
 * this file's header comment: none of the patterns carry the `g`/`y` flag,
 * so `RegExp.prototype.exec` never accumulates `lastIndex` state here).
 *
 * `offsets` are `[start, end)` code-unit offsets of the FULL match (`match[0]`)
 * into `text` exactly as given — this function does no normalization of its
 * own; the orchestrator (`input-guardrails.ts`) is responsible for feeding it
 * already-normalized text when that matters.
 *
 * Deliberately returns at most one `Finding`: mirrors `screen_injection`,
 * which also stops at the first match. A single hit is already a hard
 * REJECT/BLOCK precedent (per `input_contract.py`), so there is no decision
 * that depends on enumerating every pattern that happens to match.
 */
export function detectInjection(text: string): Finding | null {
  for (const { id, pattern, reason } of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      return {
        category: "injection",
        type: id,
        reason,
        detector: "deterministic",
        offsets: [[start, end]],
      };
    }
  }
  return null;
}

/**
 * Trust-tiered decision over one message (spec, "Layer 2"). Delegates the
 * actual pattern match to `detectInjection` and only decides WHAT TO DO with
 * a match, based on who is speaking:
 *
 *   - `stranger` (unresolved `chat_identity`, the existing intro path) — a
 *     match is a hard `block`. Mirrors `input_contract.py`'s hard-REJECT
 *     precedent: an injection probe never becomes a runnable turn.
 *   - `bound` (identity resolved to a workspace, or any console sender) — a
 *     match is only a `warn`: the finding is recorded for the audit table,
 *     but the turn proceeds. This is the concrete false-positive fix from the
 *     spec — a workspace member discussing this very guardrail must not be
 *     blocked by it.
 *   - no match — `allow` regardless of trust tier.
 */
export function screenInjection(
  text: string,
  trust: GuardrailTrust
): { action: "block" | "warn" | "allow"; finding: Finding | null } {
  const finding = detectInjection(text);
  if (finding === null) {
    return { action: "allow", finding: null };
  }
  return { action: trust === "stranger" ? "block" : "warn", finding };
}
