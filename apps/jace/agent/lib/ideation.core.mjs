// Pure, dependency-free helpers for Jace's ideation front office (the grill-me
// / to-prd / to-issues skills). Everything here is side-effect-free: no network,
// no model call, and crucially NO child_process — issue publication is done by
// the single gated `create_issue` tool, never here. These helpers only shape
// text and compute the ORDER of gated calls, so they are unit-testable without
// booting Eve or a model.
//
// This file lives under agent/lib/, which Eve treats as a recognized lib
// directory: helper .mjs modules here are NOT loaded as tools.

/**
 * Structure a grill-me requirement interview into the read-only requirements
 * summary the skill emits. Drafting only — this creates nothing.
 *
 * `problem` and at least one `successSignals` entry are required: a summary with
 * no observable success signal is exactly what the grill exists to prevent (the
 * factory's output quality is bounded by testable acceptance criteria, and those
 * inherit from these signals).
 *
 * @param {object} input
 * @param {string} input.problem - what is broken, for whom
 * @param {string} [input.users] - actors and what they're trying to do
 * @param {string} [input.constraints] - decisions/invariants that bound the work
 * @param {string} [input.scope] - the smallest end-to-end vertical slice
 * @param {string[]} input.successSignals - non-empty; observable, testable signals
 * @param {string[]} [input.openQuestions] - unresolved questions / explicit assumptions
 * @returns {string} the structured requirements-summary markdown
 */
export function buildRequirementsSummary({
  problem,
  users,
  constraints,
  scope,
  successSignals,
  openQuestions,
} = {}) {
  if (!problem || !String(problem).trim()) {
    throw new Error(
      "buildRequirementsSummary: `problem` is required — a requirements summary must name what is broken and for whom.",
    );
  }
  if (!Array.isArray(successSignals) || successSignals.length === 0) {
    throw new Error(
      "buildRequirementsSummary: `successSignals` must be a non-empty array — " +
        "a summary with no observable success signal cannot become testable acceptance criteria.",
    );
  }

  const bullet = (items) =>
    (Array.isArray(items) ? items : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map((s) => `- ${s}`)
      .join("\n");

  const signals = bullet(successSignals);
  const questions = bullet(openQuestions);

  const sections = [
    "## Problem",
    String(problem).trim(),
    "",
    "## Users",
    String(users ?? "").trim(),
    "",
    "## Constraints",
    String(constraints ?? "").trim(),
    "",
    "## Scope",
    String(scope ?? "").trim(),
    "",
    "## Success signals",
    signals,
    "",
    "## Open questions",
    questions,
  ];

  return sections.join("\n");
}

/**
 * A single house-format issue draft — the exact field shape the gated
 * `create_issue` tool accepts (see agent/tools/create_issue.ts inputSchema).
 * `acceptanceCriteria` is a non-empty list; the tool renders it as numbered
 * `- [ ] ACn:` checkboxes.
 *
 * @typedef {object} IssueDraft
 * @property {"epic"|"slice"} kind - epic = the PRD parent issue; slice = a work item
 * @property {string} title
 * @property {string} parent
 * @property {string} requiredContext
 * @property {string} whatToBuild
 * @property {string[]} acceptanceCriteria
 * @property {string} verification
 */

/**
 * Break a PRD into an ORDERED list of house-format issue drafts to publish, one
 * gated `create_issue` call each (each individually human-approved). This
 * computes ONLY the plan and the field shapes — it does NOT publish anything.
 * The to-issues skill walks this list and makes one approved tool call per draft.
 *
 * Order (matches the to-issues skill):
 *   1. the PRD itself as the parent EPIC issue (index 0), then
 *   2. each slice as its own issue, with `parent` set to the epic's title so the
 *      factory and humans can trace slices back to the epic.
 *
 * The epic's acceptance criteria are the PRD's measurement signals rendered as
 * observable checkboxes; every slice must carry at least one acceptance
 * criterion (a house-format invariant, enforced by the create_issue core and the
 * factory's validateAcceptanceCriteria gate). A slice with none is a hard error
 * here so it is caught while drafting, not at the gate.
 *
 * @param {object} prd
 * @param {string} prd.title - the PRD title (becomes the epic issue title)
 * @param {string} [prd.problem]
 * @param {string} [prd.requiredContext] - decisions/invariants bounding the whole PRD
 * @param {string[]} prd.measurement - non-empty; the epic's acceptance criteria
 * @param {Array<{
 *   title: string,
 *   requiredContext?: string,
 *   whatToBuild?: string,
 *   acceptanceCriteria: string[],
 *   verification?: string,
 *   blockedBy?: string,
 * }>} prd.slices - non-empty list of vertical slices
 * @param {string} [prd.parentEpic] - an OUTER epic/milestone the PRD epic belongs to
 * @returns {IssueDraft[]} ordered drafts: [epic, ...slices]
 */
export function prdToIssueDrafts({
  title,
  problem,
  requiredContext,
  measurement,
  slices,
  parentEpic,
} = {}) {
  if (!title || !String(title).trim()) {
    throw new Error("prdToIssueDrafts: PRD `title` is required.");
  }
  if (!Array.isArray(measurement) || measurement.length === 0) {
    throw new Error(
      "prdToIssueDrafts: PRD `measurement` must be a non-empty array — the epic issue needs at least one observable acceptance criterion.",
    );
  }
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error(
      "prdToIssueDrafts: PRD `slices` must be a non-empty array — a PRD with no slices produces no work.",
    );
  }

  const epicTitle = String(title).trim();

  const epic = {
    kind: "epic",
    title: epicTitle,
    parent: String(parentEpic ?? "").trim(),
    requiredContext: String(requiredContext ?? "").trim(),
    whatToBuild:
      (problem ? `${String(problem).trim()}\n\n` : "") +
      "This epic tracks the PRD; its slices are published as separate issues, " +
      "each pointing back to this issue as its Parent.",
    acceptanceCriteria: measurement
      .map((m) => String(m).trim())
      .filter(Boolean),
    verification:
      "Every child slice issue is created and closed; each slice's own verification evidence is met.",
  };
  if (epic.acceptanceCriteria.length === 0) {
    throw new Error(
      "prdToIssueDrafts: PRD `measurement` had no non-empty entries; the epic needs at least one acceptance criterion.",
    );
  }

  const sliceDrafts = slices.map((slice, i) => {
    if (!slice || !slice.title || !String(slice.title).trim()) {
      throw new Error(
        `prdToIssueDrafts: slice #${i + 1} is missing a title.`,
      );
    }
    const acs = (Array.isArray(slice.acceptanceCriteria)
      ? slice.acceptanceCriteria
      : []
    )
      .map((c) => String(c).trim())
      .filter(Boolean);
    if (acs.length === 0) {
      throw new Error(
        `prdToIssueDrafts: slice "${slice.title}" has no acceptance criteria; ` +
          "every house-format issue needs at least one checkboxed criterion or the factory's validateAcceptanceCriteria gate rejects it.",
      );
    }
    /** @type {IssueDraft} */
    const draft = {
      kind: "slice",
      title: String(slice.title).trim(),
      parent: epicTitle,
      requiredContext: String(slice.requiredContext ?? "").trim(),
      whatToBuild: String(slice.whatToBuild ?? "").trim(),
      acceptanceCriteria: acs,
      verification: String(slice.verification ?? "").trim(),
    };
    const blockedBy = String(slice.blockedBy ?? "").trim();
    if (blockedBy) draft.blockedBy = blockedBy;
    return draft;
  });

  return [epic, ...sliceDrafts];
}
