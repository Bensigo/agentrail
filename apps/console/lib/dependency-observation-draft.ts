export const DEPENDENCY_OBSERVATION_DRAFT_BODY_BYTES = 4 * 1024;
export const DEPENDENCY_OBSERVATION_DRAFT_BODY_TIMEOUT_MS = 8_000;

export type DependencyObservationDraftLocator = {
  workspaceId: string;
  watchId: string;
  candidateFingerprint: string;
};

export type DependencyObservationDraftJsonResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason:
        | "invalid_content_type"
        | "invalid_length"
        | "body_unavailable"
        | "timeout"
        | "invalid_json";
    };

const LOCATOR_KEYS = new Set([
  "workspaceId",
  "watchId",
  "candidateFingerprint",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The runner may locate one already-recorded observation, but it cannot
 * author the repository, baseline, candidate, paths, manager profile, or any
 * evidence. Those values are re-derived inside the database transaction.
 */
export function parseDependencyObservationDraftLocator(
  value: unknown
): DependencyObservationDraftLocator | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== LOCATOR_KEYS.size || keys.some((key) => !LOCATOR_KEYS.has(key))) {
    return null;
  }
  if (
    !nonBlankString(body.workspaceId)
    || !nonBlankString(body.watchId)
    || !nonBlankString(body.candidateFingerprint)
  ) return null;

  const workspaceId = body.workspaceId.trim();
  const watchId = body.watchId.trim();
  const candidateFingerprint = body.candidateFingerprint.trim();
  if (!UUID.test(workspaceId) || !UUID.test(watchId) || !SHA256.test(candidateFingerprint)) {
    return null;
  }
  return { workspaceId, watchId, candidateFingerprint };
}

/** Read one small fatal-UTF-8 JSON locator with a deadline through the body. */
export async function readDependencyObservationDraftJson(
  request: Request
): Promise<DependencyObservationDraftJsonResult> {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    void request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_content_type" };
  }

  const declared = request.headers.get("content-length");
  if (
    declared !== null
    && (!/^\d+$/u.test(declared) || Number(declared) > DEPENDENCY_OBSERVATION_DRAFT_BODY_BYTES)
  ) {
    void request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_length" };
  }
  if (!request.body) return { ok: false, reason: "body_unavailable" };

  const reader = request.body.getReader();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
      reject(new Error("Dependency observation draft body timed out"));
    }, DEPENDENCY_OBSERVATION_DRAFT_BODY_TIMEOUT_MS);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > DEPENDENCY_OBSERVATION_DRAFT_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "invalid_length" };
      }
      chunks.push(next.value);
    }
    if (timedOut) return { ok: false, reason: "timeout" };
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        ok: true,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      };
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "body_unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
