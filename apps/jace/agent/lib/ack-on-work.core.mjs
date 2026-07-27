// Post a short acknowledgement when a turn starts doing real work.
//
// SUPERSEDES ack-on-silence.core.mjs, which armed a 4s timer from
// `turn.started`. That bar filtered nothing: an LLM round-trip essentially
// never lands under 4s, so the ack fired on EVERY turn — including turns whose
// entire output was a clarifying question, where "On it." is not just noise but
// false (nothing was underway; Jace was asking what the human meant). An
// identical string on every reply is what makes a bot read as a machine.
//
// The trigger is now the `actions.requested` stream event, which eve emits when
// the model requests tool calls, BEFORE they execute. Two properties make it the
// right edge:
//
//   - A text-only turn never emits it. Asking a question involves no tool call,
//     so it cannot ack. No threshold guessing required.
//   - Its payload names the work. A `tool-call` action carries `toolName`; a
//     `subagent-call` carries `subagentName`. See eve's
//     dist/src/runtime/actions/types.d.ts.
//
// That second property retires the old module's reason for a fixed string: it
// said it "deliberately says nothing about WHAT it is doing" because at 4s "the
// model has not necessarily decided anything, and inventing progress detail we
// cannot substantiate is the failure mode this is trying not to build". Correct
// for a blind timer. Moot once the trigger IS the decision — we are no longer
// inventing detail, we are reading it off the event.
//
// `actions.requested` is a first-class CHANNEL event (it appears in
// defineChannel's own handler allowlist in
// dist/src/public/definitions/defineChannel.js, and eve's stock discord /
// telegram / slack defaults already subscribe to it to re-trigger typing), so
// this needs no hook file — it wires up beside the existing handlers.
//
// Still a ONE-SHOT per turn, and still time-gated: a tool that returns fast
// enough that the real reply beats the window never acks. The window now counts
// from work STARTING rather than from the message arriving.
//
// Pure + injected timers so it is unit-testable without real time or a network.
// Keyed by conversation so two concurrent chats never cross acks.
//
// NOT stopped on `turn.failed` / `session.failed`: eve@0.19.0 does not publicly
// export `defaultEvents` (verified against dist/src/public/channels/discord/
// index.d.ts, which re-exports only `defaultDiscordAuth` from defaults.js), and
// its default failure handlers build their message from `#internal/logging.js`
// helpers that are equally unreachable — overriding them would clobber eve's
// error text and drop the error id. The residual race (a turn failing inside the
// window, so the ack lands just after eve's error message) is accepted, and is
// strictly rarer than before: a turn now has to fail while a tool call is in
// flight to hit it.

export const ACK_AFTER_MS = 4000; // counted from the first tool call, not the message

/**
 * Fallback copy for a tool with no entry in {@link WORK_PHRASES}.
 *
 * Deliberately vague, because it is the ONLY case where we do not know what the
 * work is. Everything else names it. If this string starts showing up a lot in
 * production, that is a signal to add the missing tool to the map, not to make
 * the fallback cleverer — a vague phrase that appears on every turn is exactly
 * the "On it." failure this module exists to undo.
 */
export const GENERIC_WORK_PHRASE = "Looking into it…";

/**
 * Tool / subagent name -> what to tell the human we are doing.
 *
 * Present tense, lowercase after the first word, trailing ellipsis: this is a
 * status line, not a sentence. Keep each one to something a person would
 * actually say out loud when glancing up from their screen.
 *
 * `smalltalk` is deliberately absent AND null-mapped below: it is the fast
 * conversational path, and announcing "thinking about it" before a one-line
 * reply is the same ceremony this module removes.
 */
export const WORK_PHRASES = Object.freeze({
  // --- reads ---
  codebase_query: "Reading the codebase…",
  fetch_repo_wiki: "Reading the repo wiki…",
  fetch_work_status: "Checking where that stands…",
  fetch_backlog: "Pulling up the backlog…",
  fetch_workspace_memory: "Checking what we've decided before…",
  standup: "Pulling the standup together…",
  // --- writes ---
  create_issue: "Writing that up as an issue…",
  update_issue: "Updating the issue…",
  create_goal: "Setting that up as a goal…",
  create_repo: "Setting up the repo…",
  create_workspace: "Setting up the workspace…",
  post_pr_review: "Posting the review…",
  send_connect_link: "Generating your connect link…",
  // --- backlog maintenance ---
  backlog_close: "Closing those out…",
  backlog_dedupe: "Checking those for duplicates…",
  backlog_label: "Labelling the backlog…",
  // --- subagents (matched on subagentName) ---
  researcher: "Researching that…",
  reviewer: "Reading the PR…",
  qa: "Running QA over it…",
  triage: "Triaging that…",
});

/**
 * Names that must never produce an ack, even though they are real actions.
 * Mapped explicitly rather than omitted so the intent survives a future edit
 * that "helpfully" adds them to WORK_PHRASES.
 */
const SILENT_WORK = new Set(["smalltalk"]);

/**
 * The `auth.attributes` key run-outcome.ts stamps onto a hand-off it starts
 * itself (a terminal run outcome, or the #1289 goal-loop's synthetic
 * message) to mark that turn as Jace-initiated — no human message behind
 * it. See {@link isProactiveTurn}'s doc comment for the full rationale.
 */
export const JACE_PROACTIVE_ATTRIBUTE = "jaceProactive";

/**
 * Whether a turn was started proactively by Jace itself
 * (agent/channels/run-outcome.ts's terminal-outcome / goal-loop hand-off via
 * `args.receive`) rather than by a real human message. ALL of Jace's hosted
 * inbound — the Discord Gateway listener, the console's dispatcher, a
 * workspace member's console chat message — is ALSO `receive()`-started, so
 * "started via receive()" cannot be the signal; the actual distinguishing
 * fact is that run-outcome.ts is the only starter with no human message
 * behind it, and it alone marks its hand-off with this attribute.
 *
 * A proactive turn can absolutely call tools (a terminal-outcome notification
 * may look up the run before describing it), so `actions.requested` alone does
 * not filter these out — the guard is still load-bearing. Without it, a
 * Jace-initiated "PR #1470 merged" notification would be preceded by an
 * unsolicited status line for a message the user never sent.
 *
 * Reads `auth` the SAME way eve's own session-auth shape is read everywhere
 * else in this codebase — `current` first (refreshed on every subsequent
 * turn), falling back to `initiator` (set once, at session start) — see
 * `resolveSessionAuthAttributes` in agent/lib/discord-followup.core.mjs for
 * the verified-against-the-compiled-runtime rationale for that precedence.
 * This is the ONE place the "is this turn proactive?" decision is made; each
 * channel's `actions.requested` calls it before `ack.arm` rather than
 * re-deriving the attribute lookup itself.
 *
 * @param {{ current?: { attributes?: Record<string, unknown> | null } | null, initiator?: { attributes?: Record<string, unknown> | null } | null } | null | undefined} auth
 * @returns {boolean}
 */
export function isProactiveTurn(auth) {
  const attributes = auth?.current?.attributes ?? auth?.initiator?.attributes;
  return attributes?.[JACE_PROACTIVE_ATTRIBUTE] === true;
}

/**
 * The name a runtime action request should be described by, or null for an
 * action kind that carries no useful name.
 *
 * Shapes are eve's, verified against dist/src/runtime/actions/types.d.ts:
 * `tool-call` -> { callId, input, kind, toolName }
 * `subagent-call` -> { callId, description, input, kind, name, nodeId, subagentName }
 * `remote-agent-call` -> { callId, description, input, kind, name, nodeId, remoteAgentName }
 * `load-skill` -> { callId, input, kind }   <- no name at all
 *
 * `load-skill` returns null on purpose, and not only because it is nameless:
 * loading a skill is control-plane bookkeeping that completes in milliseconds.
 * Announcing it would put a status line in front of turns that never went slow.
 *
 * @param {{ kind?: string, toolName?: string, subagentName?: string, remoteAgentName?: string } | null | undefined} action
 * @returns {string | null}
 */
export function actionName(action) {
  switch (action?.kind) {
    case "tool-call":
      return action.toolName ?? null;
    case "subagent-call":
      return action.subagentName ?? null;
    case "remote-agent-call":
      return action.remoteAgentName ?? null;
    default:
      return null; // load-skill, or an action kind added after this was written
  }
}

/**
 * What to post for one `actions.requested` payload, or null to stay silent.
 *
 * Silence wins over noise: if every action in the batch is nameless
 * (`load-skill`) or explicitly silent (smalltalk), this returns null and no
 * timer is armed at all. A batch mixing silent and real work describes the
 * first real one — the model asked for them together, so any of them is a true
 * answer to "what are you doing", and the first is the one it led with.
 *
 * @param {readonly unknown[] | null | undefined} actions
 * @returns {string | null}
 */
export function workPhraseFor(actions) {
  if (!Array.isArray(actions)) return null;
  let sawRealWork = false;
  for (const action of actions) {
    const name = actionName(action);
    if (name === null || SILENT_WORK.has(name)) continue;
    const phrase = WORK_PHRASES[name];
    if (phrase) return phrase;
    // A real, named action we have no copy for. Remember it, but keep looking:
    // a later action in the same batch may be one we can name properly.
    sawRealWork = true;
  }
  return sawRealWork ? GENERIC_WORK_PHRASE : null;
}

export function createAckOnWork(deps = {}) {
  const setTo = deps.setTimeout ?? setTimeout;
  const clearTo = deps.clearTimeout ?? clearTimeout;
  const afterMs = deps.afterMs ?? ACK_AFTER_MS;

  // convoKey -> { turnId, id: timeout id | null }
  // The entry OUTLIVES its own firing (with id nulled) so that a second
  // `actions.requested` in the same turn — the normal shape of multi-step tool
  // use — cannot arm a second ack. Cleared by stop() at the turn boundary.
  const pending = new Map();

  /**
   * Arm the ack for `turnId`, at most once per turn.
   *
   * @param {string} key conversation key
   * @param {string} turnId eve's turn id, from the event payload
   * @param {() => unknown} postAck
   */
  function arm(key, turnId, postAck) {
    const entry = pending.get(key);
    // Already armed or already fired for THIS turn — a repeat tool call, not a
    // new turn. Leave the original timer alone: re-arming here would push the
    // ack further out on every step, so a chatty multi-step turn (exactly the
    // slow kind that needs one) would never actually ack.
    if (entry && entry.turnId === turnId) return;
    // A different turn's entry survived without a stop() — treat it as stale.
    if (entry?.id !== undefined && entry?.id !== null) clearTo(entry.id);

    const id = setTo(() => {
      // Null the id BEFORE posting so a slow or throwing post can never leave a
      // live timer id behind, while KEEPING the entry so this turn stays
      // one-shot.
      const current = pending.get(key);
      if (current) current.id = null;
      safe(postAck);
    }, afterMs);
    pending.set(key, { turnId, id });
  }

  function stop(key) {
    const entry = pending.get(key);
    if (entry === undefined) return;
    if (entry.id !== null && entry.id !== undefined) clearTo(entry.id);
    pending.delete(key);
  }

  return {
    arm,
    stop,
    pendingCount: () => pending.size,
    /** Timers still scheduled (i.e. armed but not yet fired). Test seam. */
    armedCount: () => [...pending.values()].filter((e) => e.id !== null).length,
  };
}

function safe(fn) {
  // An acknowledgement must never throw into the turn: a failed ack is strictly
  // less bad than a failed reply. Covers both a synchronous throw and a
  // rejected promise from an async poster.
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.then(undefined, () => {});
    }
  } catch {
    /* swallow */
  }
}
