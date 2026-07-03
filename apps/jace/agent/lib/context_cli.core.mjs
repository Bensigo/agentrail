// Pure, dependency-free helpers for Jace's READ-ONLY codebase Q&A skill.
//
// The Q&A skill answers questions about the AgentRail codebase by invoking the
// existing `agentrail context` CLI (query / def / callers) and citing its
// output. It is READ-ONLY: `context query`/`def`/`callers` only retrieve; they
// never mutate the repo or the database.
//
// ── AC4: no shell-string subprocess invocation ──────────────────────────────
// The subprocess MUST be invoked execFile-style, with the binary and an ARGS
// ARRAY, never a single concatenated shell command and never shell:true. User
// input is passed as one argv ELEMENT (never interpolated into a command
// string), so a question containing shell metacharacters (`;`, `$(…)`, backticks)
// is inert. This module builds only the args array and orchestrates via an
// injected execFile-style function; it never imports child_process itself and
// has no code path that concatenates a command string.
//
// This file lives under agent/lib/, which Eve treats as a recognized lib
// directory: helper .mjs modules here are NOT loaded as tools.

/** The `agentrail context` subcommands the Q&A skill is allowed to call. */
export const ALLOWED_SUBCOMMANDS = Object.freeze(["query", "def", "callers"]);

/**
 * Build the ARGS ARRAY for `agentrail context <sub> <term> --json`.
 *
 * CRITICAL (AC4): the term is a single array element. It is NEVER interpolated
 * into a string, so shell metacharacters in `term` are passed verbatim to the
 * CLI as one argument and cannot start a subprocess or a new command.
 *
 * @param {"query"|"def"|"callers"} sub
 * @param {string} term the user's question/symbol — passed as ONE argv element
 * @returns {string[]} argv WITHOUT the binary, e.g. ["context","query","<term>","--json"]
 */
export function buildContextArgv(sub, term) {
  if (!ALLOWED_SUBCOMMANDS.includes(sub)) {
    throw new Error(
      `buildContextArgv: unsupported subcommand "${sub}". Allowed: ${ALLOWED_SUBCOMMANDS.join(", ")}.`,
    );
  }
  const value = String(term ?? "").trim();
  if (!value) {
    throw new Error(
      `buildContextArgv: a non-empty term is required for \`context ${sub}\`.`,
    );
  }
  // Always request JSON so the answer can cite structured tool output.
  return ["context", sub, value, "--json"];
}

/**
 * Normalize the CLI's JSON output into a flat citation list. `context query`
 * returns an object with a `results` array; `def`/`callers` return an array of
 * hits directly. Each citation carries the path and (when present) the line
 * range and matched symbol — enough for the answer to point at exact source.
 *
 * @param {"query"|"def"|"callers"} sub
 * @param {unknown} parsed the JSON.parse'd CLI stdout
 * @returns {Array<{ path: string, lineStart?: number, lineEnd?: number, symbol?: string, snippet?: string }>}
 */
export function extractCitations(sub, parsed) {
  /** @type {any} */
  const p = parsed;
  const hits = Array.isArray(p) ? p : Array.isArray(p?.results) ? p.results : [];
  return hits
    .map((/** @type {any} */ h) => {
      if (!h || typeof h !== "object") return null;
      const path = h.path ?? h.file ?? null;
      if (!path) return null;
      /** @type {{ path: string, lineStart?: number, lineEnd?: number, symbol?: string, snippet?: string }} */
      const cite = { path: String(path) };
      if (typeof h.lineStart === "number") cite.lineStart = h.lineStart;
      if (typeof h.lineEnd === "number") cite.lineEnd = h.lineEnd;
      if (h.symbol) cite.symbol = String(h.symbol);
      const content = h.content ?? h.snippet;
      if (content) cite.snippet = String(content).slice(0, 400);
      return cite;
    })
    .filter(Boolean);
}

/**
 * Invoke `agentrail context <sub> <term> --json` via an injected execFile-style
 * function and return the citations. The injected `execFileFn` MUST be an
 * execFile-style `(bin, argv, opts) => Promise<{ stdout, stderr }>` — an args
 * array, never a shell string (AC4). In production the caller passes
 * `promisify(execFile)`; there is no `exec`/shell path anywhere.
 *
 * The returned object carries the parsed citations AND the raw stdout, so the
 * skill answers ONLY from tool output — never from the model's own memory (AC3).
 *
 * @param {object} input
 * @param {(bin: string, argv: string[], opts: object) => Promise<{ stdout: string, stderr?: string }>} input.execFileFn
 * @param {"query"|"def"|"callers"} input.sub
 * @param {string} input.term
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {string} [input.bin] defaults to env.JACE_AGENTRAIL_BIN or "agentrail"
 * @returns {Promise<{ argv: string[], citations: Array<object>, raw: string }>}
 */
export async function runContextLookup(input = /** @type {any} */ ({})) {
  const { execFileFn, sub, term, env, bin } = input;
  if (typeof execFileFn !== "function") {
    throw new Error(
      "runContextLookup: execFileFn (an execFile-style function) is required.",
    );
  }
  const resolvedEnv = env ?? {};
  const resolvedBin = bin || resolvedEnv.JACE_AGENTRAIL_BIN || "agentrail";
  const argv = buildContextArgv(sub, term);

  /** @type {{ stdout?: string, stderr?: string }} */
  let result;
  try {
    // execFile-style: (bin, ARGS ARRAY, opts). Never a shell string; no shell.
    result = await execFileFn(resolvedBin, argv, { env: resolvedEnv });
  } catch (/** @type {any} */ err) {
    const stderr = err && err.stderr ? `\n${err.stderr}` : "";
    throw new Error(
      `runContextLookup: \`${resolvedBin} context ${sub}\` failed: ${err && err.message ? err.message : String(err)}${stderr}`,
    );
  }

  const raw = String(result?.stdout ?? "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `runContextLookup: \`context ${sub}\` did not return JSON. Raw stdout was:\n${raw}`,
    );
  }
  return { argv, citations: extractCitations(sub, parsed), raw };
}
