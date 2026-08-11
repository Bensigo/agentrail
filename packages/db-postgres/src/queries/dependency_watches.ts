import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { repositories } from "../schema/repositories.js";
import {
  dependencyWatchObservations,
  dependencyWatches,
} from "../schema/dependency_watches.js";
import type {
  DependencyWatchErrorCode,
  DependencyWatchStatus,
  DependencyWatchTrigger,
  GoDependencySourceInventoryReceipt,
} from "../schema/dependency_watches.js";

export class DependencyWatchAuthorizationError extends Error {
  readonly code = "authorization" as const;

  constructor() {
    super("Repository is not connected to this workspace");
    this.name = "DependencyWatchAuthorizationError";
  }
}

export class DependencyWatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyWatchValidationError";
  }
}

export type DependencyWatchConfig = {
  workspaceId: string;
  repositoryId: string;
  manifestPath?: string;
  lockfilePath?: string;
  selectedDependencies?: string[];
  cadenceSeconds?: number | null;
};

export type RecordDependencyObservationInput = {
  workspaceId: string;
  watchId: string;
  repositoryId: string;
  trigger: DependencyWatchTrigger;
  baselineSha?: string | null;
  selectedFileHashes: Record<string, string>;
  observationKey: string;
  candidateFingerprint?: string | null;
  sourceInventoryReceipt?: GoDependencySourceInventoryReceipt | null;
  sourceInventoryReceiptSha256?: string | null;
  status: DependencyWatchStatus;
  candidates?: unknown[];
  errorCode?: DependencyWatchErrorCode | null;
  errorMessage?: string | null;
  observedAt?: Date;
  nextCheckAt?: Date | null;
};

const SOURCE_SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SOURCE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SOURCE_CONTROL = /[\u0000-\u001f\u007f]/u;
const SOURCE_MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const SOURCE_MAX_PATH_BYTES = 4 * 1024;
const SOURCE_MAX_TOTAL_PATH_BYTES = 8 * 1024 * 1024;
const SOURCE_MAX_ENTRIES = 20_000;
const SOURCE_ASCII_PATH = /^[\x20-\x7e]+$/u;

function sourceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index]);
}

function sourceCanonicalJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    const items = value.map(sourceCanonicalJson);
    return items.every((item): item is string => item !== null)
      ? `[${items.join(",")}]`
      : null;
  }
  if (!sourceRecord(value)) return null;
  const items: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const nested = sourceCanonicalJson(value[key]);
    if (nested === null) return null;
    items.push(`${JSON.stringify(key)}:${nested}`);
  }
  return `{${items.join(",")}}`;
}

function sourceCanonicalSha256(value: unknown): string | null {
  const canonical = sourceCanonicalJson(value);
  return canonical === null
    ? null
    : createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sourceUtf8ByteLength(value: string): number | null {
  const encoded = Buffer.from(value, "utf8");
  return encoded.toString("utf8") === value ? encoded.length : null;
}

function sourceSafePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const byteLength = sourceUtf8ByteLength(value);
  return byteLength !== null && byteLength <= SOURCE_MAX_PATH_BYTES
    && SOURCE_ASCII_PATH.test(value)
    && !value.startsWith("/") && !value.endsWith("/")
    && !value.includes("\\") && !SOURCE_CONTROL.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateGoDependencySourceInventoryReceipt(
  value: unknown,
  declaredSha256: string,
): GoDependencySourceInventoryReceipt | null {
  if (!SOURCE_SHA256.test(declaredSha256) || !sourceRecord(value)) return null;
  const canonical = sourceCanonicalJson(value);
  if (canonical === null || Buffer.byteLength(canonical, "utf8") > SOURCE_MAX_RECEIPT_BYTES
    || !sourceExactKeys(value, [
      "kind", "schemaVersion", "identity", "authority", "inventory",
      "requiredFiles", "policy", "identitySha256",
    ])) return null;
  if (value.kind !== "github_exact_tree_dependency_source_inventory"
    || value.schemaVersion !== 1 || value.identitySha256 !== declaredSha256) return null;

  const identity = value.identity;
  if (!sourceRecord(identity) || !sourceExactKeys(identity, ["ecosystem", "manager", "profile"])
    || identity.ecosystem !== "go" || identity.manager !== "go-modules"
    || identity.profile !== "go_github_exact_tree_source_inventory_v1") return null;

  const authority = value.authority;
  if (!sourceRecord(authority) || !sourceExactKeys(authority, [
    "provider", "method", "apiOrigin", "repository", "requestedRef",
    "commitSha", "rootTreeSha",
  ]) || authority.provider !== "github"
    || authority.method !== "github_app_installation_api"
    || authority.apiOrigin !== "https://api.github.com"
    || typeof authority.repository !== "string" || !SOURCE_REPOSITORY.test(authority.repository)
    || typeof authority.requestedRef !== "string" || authority.requestedRef.length < 1
    || sourceUtf8ByteLength(authority.requestedRef) === null
    || sourceUtf8ByteLength(authority.requestedRef)! > 1024
    || SOURCE_CONTROL.test(authority.requestedRef)
    || typeof authority.commitSha !== "string" || !SOURCE_GIT_SHA.test(authority.commitSha)
    || typeof authority.rootTreeSha !== "string" || !SOURCE_GIT_SHA.test(authority.rootTreeSha)
    || authority.commitSha.length !== authority.rootTreeSha.length) return null;

  const inventory = value.inventory;
  if (!sourceRecord(inventory) || !sourceExactKeys(inventory, [
    "recursive", "truncated", "entryCount", "entries", "entriesSha256",
  ]) || inventory.recursive !== true || inventory.truncated !== false
    || !Number.isSafeInteger(inventory.entryCount) || (inventory.entryCount as number) < 2
    || (inventory.entryCount as number) >= SOURCE_MAX_ENTRIES
    || !Array.isArray(inventory.entries)
    || inventory.entries.length !== inventory.entryCount
    || typeof inventory.entriesSha256 !== "string"
    || !SOURCE_SHA256.test(inventory.entriesSha256)
    || sourceCanonicalSha256(inventory.entries) !== inventory.entriesSha256) return null;

  const seen = new Set<string>();
  const folded = new Set<string>();
  let previousPath: string | null = null;
  let totalPathBytes = 0;
  const entriesByPath = new Map<string, Record<string, unknown>>();
  for (const entry of inventory.entries) {
    if (!sourceRecord(entry) || !sourceExactKeys(entry, ["path", "mode", "type", "objectSha"])
      || !sourceSafePath(entry.path)
      || (entry.type !== "blob" && entry.type !== "tree")
      || (entry.type === "blob" && entry.mode !== "100644" && entry.mode !== "100755")
      || (entry.type === "tree" && entry.mode !== "040000")
      || typeof entry.objectSha !== "string" || !SOURCE_GIT_SHA.test(entry.objectSha)
      || entry.objectSha.length !== authority.commitSha.length) return null;
    const path = entry.path;
    totalPathBytes += Buffer.byteLength(path, "utf8");
    if (totalPathBytes > SOURCE_MAX_TOTAL_PATH_BYTES) return null;
    const casefolded = path.toLowerCase();
    const parts = casefolded.split("/");
    const basename = parts[parts.length - 1]!;
    if (basename === "go.work" || basename === "go.work.sum"
      || ((basename === "go.mod" || basename === "go.sum")
        && path !== "go.mod" && path !== "go.sum")
      || parts.includes("vendor")
      || [".netrc", ".gitconfig", ".goenv", "go.env"].includes(basename)
      || casefolded === ".config/go/env"
      || casefolded.endsWith("/.config/go/env")) return null;
    if (seen.has(path) || folded.has(casefolded)
      || (previousPath !== null
        && Buffer.compare(Buffer.from(previousPath, "utf8"), Buffer.from(path, "utf8")) >= 0)) return null;
    seen.add(path);
    folded.add(casefolded);
    previousPath = path;
    entriesByPath.set(path, entry);
  }

  const requiredFiles = value.requiredFiles;
  if (!Array.isArray(requiredFiles) || requiredFiles.length !== 2) return null;
  const requiredPaths = ["go.mod", "go.sum"] as const;
  for (let index = 0; index < requiredPaths.length; index += 1) {
    const path = requiredPaths[index]!;
    const file = requiredFiles[index];
    const entry = entriesByPath.get(path);
    const maxBytes = path === "go.mod" ? 256 * 1024 : 8 * 1024 * 1024;
    if (!sourceRecord(file) || !sourceExactKeys(file, [
      "path", "mode", "blobSha", "byteCount", "contentSha256",
    ]) || file.path !== path || file.mode !== "100644"
      || typeof file.blobSha !== "string" || !SOURCE_GIT_SHA.test(file.blobSha)
      || file.blobSha.length !== authority.commitSha.length
      || !Number.isSafeInteger(file.byteCount) || (file.byteCount as number) < 0
      || (file.byteCount as number) > maxBytes
      || typeof file.contentSha256 !== "string" || !SOURCE_SHA256.test(file.contentSha256)
      || entry?.type !== "blob" || entry.mode !== "100644"
      || entry.objectSha !== file.blobSha) return null;
  }

  const policy = value.policy;
  if (!sourceRecord(policy) || !sourceExactKeys(policy, ["name", "result"])
    || policy.name !== "go_root_source_inventory_v1" || policy.result !== "admitted") return null;
  const { identitySha256: _identitySha256, ...withoutIdentity } = value;
  if (sourceCanonicalSha256(withoutIdentity) !== declaredSha256) return null;
  return value as GoDependencySourceInventoryReceipt;
}

function sourceCanonicalWatchPath(value: string): string | null {
  if (!value || !SOURCE_ASCII_PATH.test(value) || SOURCE_CONTROL.test(value)
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return null;
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === ".") continue;
    if (!part || part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function validateSourceReceiptObservationBindings(
  input: RecordDependencyObservationInput,
  watch: { manifestPath: string; lockfilePath: string },
  repositoryName: string,
  receipt: GoDependencySourceInventoryReceipt,
): void {
  const exactAuto = watch.manifestPath === "auto" && watch.lockfilePath === "auto";
  const exactGoRoot = sourceCanonicalWatchPath(watch.manifestPath) === "go.mod"
    && sourceCanonicalWatchPath(watch.lockfilePath) === "go.sum";
  if (!exactAuto && !exactGoRoot) {
    throw new DependencyWatchValidationError("source inventory receipt requires a Go-root watch");
  }
  if (repositoryName.toLowerCase() !== receipt.authority.repository.toLowerCase()) {
    throw new DependencyWatchValidationError("source inventory receipt repository does not match connected custody");
  }
  if (input.baselineSha !== receipt.authority.commitSha) {
    throw new DependencyWatchValidationError("source inventory receipt commit does not match the observation baseline");
  }
  const selectedKeys = Object.keys(input.selectedFileHashes).sort();
  const requiredHashes = Object.fromEntries(
    receipt.requiredFiles.map((file) => [file.path, file.contentSha256]),
  );
  if (selectedKeys.length !== 2 || selectedKeys[0] !== "go.mod" || selectedKeys[1] !== "go.sum"
    || input.selectedFileHashes["go.mod"] !== requiredHashes["go.mod"]
    || input.selectedFileHashes["go.sum"] !== requiredHashes["go.sum"]) {
    throw new DependencyWatchValidationError("source inventory receipt hashes do not match the selected Go root files");
  }
  const candidates = input.candidates ?? [];
  if (input.status === "candidates") {
    if (candidates.length === 0 || candidates.some((candidate) => !sourceRecord(candidate)
      || candidate.ecosystem !== "go" || candidate.package_manager !== "go-modules"
      || candidate.manifest_path !== "go.mod" || candidate.lockfile_path !== "go.sum"
      || candidate.baseline_sha !== receipt.authority.commitSha)) {
      throw new DependencyWatchValidationError("source inventory receipt candidates do not match Go source custody");
    }
  } else if (candidates.length !== 0) {
    throw new DependencyWatchValidationError("non-candidate source inventory observations cannot carry candidates");
  }
}

const AUTO_SELECTED_PATHS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "packages.lock.json",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "Package.swift",
  "Package.resolved",
]);

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function resolvedPushPaths(watch: {
  manifestPath: string;
  lockfilePath: string;
  selectedFileHashes: Record<string, string>;
}): Set<string> {
  const explicit = [watch.manifestPath, watch.lockfilePath]
    .map(normalizePath)
    .filter((path) => path !== "auto");
  if (explicit.length === 2) {
    return new Set(explicit);
  }
  const selected = Object.keys(watch.selectedFileHashes ?? {})
    .map(normalizePath)
    .filter((path) => path.length > 0);
  if (selected.length > 0) {
    return new Set(selected);
  }
  return AUTO_SELECTED_PATHS;
}

function validateConfig(input: DependencyWatchConfig): void {
  if (!input.workspaceId || !input.repositoryId) {
    throw new DependencyWatchValidationError("workspaceId and repositoryId are required");
  }
  if (input.manifestPath !== undefined && !input.manifestPath.trim()) {
    throw new DependencyWatchValidationError("manifestPath must not be empty");
  }
  if (input.lockfilePath !== undefined && !input.lockfilePath.trim()) {
    throw new DependencyWatchValidationError("lockfilePath must not be empty");
  }
  if (
    input.cadenceSeconds !== undefined &&
    input.cadenceSeconds !== null &&
    (!Number.isInteger(input.cadenceSeconds) || input.cadenceSeconds <= 0)
  ) {
    throw new DependencyWatchValidationError("cadenceSeconds must be a positive integer or null");
  }
  if (input.selectedDependencies?.some((name) => !name.trim())) {
    throw new DependencyWatchValidationError("selectedDependencies must contain non-empty names");
  }
}

/** Configure one watch only after proving the repository belongs to the tenant. */
export async function createDependencyWatch(input: DependencyWatchConfig) {
  validateConfig(input);
  const [repository] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.id, input.repositoryId), eq(repositories.workspaceId, input.workspaceId)))
    .limit(1);
  if (!repository) throw new DependencyWatchAuthorizationError();

  const now = new Date();
  const nextCheckAt = input.cadenceSeconds
    ? new Date(now.getTime() + input.cadenceSeconds * 1000)
    : null;
  const [row] = await db
    .insert(dependencyWatches)
    .values({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      manifestPath: input.manifestPath ?? "auto",
      lockfilePath: input.lockfilePath ?? "auto",
      selectedDependencies: [...new Set(input.selectedDependencies ?? [])].sort(),
      cadenceSeconds: input.cadenceSeconds ?? null,
      nextCheckAt,
    })
    .onConflictDoUpdate({
      target: [
        dependencyWatches.workspaceId,
        dependencyWatches.repositoryId,
        dependencyWatches.manifestPath,
        dependencyWatches.lockfilePath,
      ],
      set: {
        selectedDependencies: [...new Set(input.selectedDependencies ?? [])].sort(),
        cadenceSeconds: input.cadenceSeconds ?? null,
        nextCheckAt,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

export async function listDependencyWatches(workspaceId: string) {
  return db
    .select()
    .from(dependencyWatches)
    .where(eq(dependencyWatches.workspaceId, workspaceId));
}

export async function listDependencyWatchesForRepository(
  workspaceId: string,
  repositoryId: string
) {
  return db
    .select()
    .from(dependencyWatches)
    .where(
      and(
        eq(dependencyWatches.workspaceId, workspaceId),
        eq(dependencyWatches.repositoryId, repositoryId)
      )
    );
}

export async function getDependencyWatch(workspaceId: string, watchId: string) {
  const [row] = await db
    .select()
    .from(dependencyWatches)
    .where(and(eq(dependencyWatches.workspaceId, workspaceId), eq(dependencyWatches.id, watchId)))
    .limit(1);
  return row ?? null;
}

/** Explicit/manual and scheduled trigger seam. This only records intent. */
export async function triggerDependencyWatch(
  workspaceId: string,
  watchId: string,
  trigger: DependencyWatchTrigger,
  now = new Date()
) {
  if (!["manual", "scheduled", "push"].includes(trigger)) {
    throw new DependencyWatchValidationError("trigger must be manual, scheduled, or push");
  }
  const watch = await getDependencyWatch(workspaceId, watchId);
  if (!watch) throw new DependencyWatchAuthorizationError();
  const [row] = await db
    .update(dependencyWatches)
    .set({ lastTrigger: trigger, lastTriggeredAt: now, status: "checking", updatedAt: now })
    .where(and(eq(dependencyWatches.workspaceId, workspaceId), eq(dependencyWatches.id, watchId)))
    .returning();
  return row!;
}

/** Trigger only watches whose selected manifest or lockfile changed. */
export async function triggerDependencyWatchesForPush(
  workspaceId: string,
  repositoryId: string,
  changedPaths: string[],
  now = new Date()
) {
  const watches = await listDependencyWatchesForRepository(workspaceId, repositoryId);
  const changed = new Set(changedPaths.map(normalizePath));
  const triggered: typeof watches = [];
  for (const watch of watches) {
    const pushPaths = resolvedPushPaths(watch as {
      manifestPath: string;
      lockfilePath: string;
      selectedFileHashes: Record<string, string>;
    });
    let matched = false;
    for (const path of pushPaths) {
      if (changed.has(path)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const [row] = await db
      .update(dependencyWatches)
      .set({
        lastTrigger: "push",
        lastTriggeredAt: now,
        status: "checking",
        updatedAt: now,
      })
      .where(
        and(
          eq(dependencyWatches.workspaceId, workspaceId),
          eq(dependencyWatches.id, watch.id)
        )
      )
      .returning();
    if (row) triggered.push(row);
  }
  return triggered;
}

/** Heartbeat reads only watches in its authorized workspace that are due. */
export async function listDueDependencyWatches(workspaceId: string, now = new Date()) {
  return db
    .select()
    .from(dependencyWatches)
    .where(
      and(
        eq(dependencyWatches.workspaceId, workspaceId),
        isNotNull(dependencyWatches.cadenceSeconds),
        isNotNull(dependencyWatches.nextCheckAt),
        lte(dependencyWatches.nextCheckAt, now)
      )
    );
}

/**
 * Claim due watches atomically. A second heartbeat cannot claim the same row
 * after the first transaction changes its status to `checking`; the returned
 * rows are observation work only and never become queue entries.
 */
export async function claimDueDependencyWatches(
  workspaceId: string,
  now = new Date(),
  limit = 25
) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return db.execute(
    // drizzle's typed update builder cannot express SKIP LOCKED portably;
    // this CTE keeps the lock-and-update atomic at the database boundary.
    sql`WITH due AS (
      SELECT id
      FROM dependency_watches
      WHERE workspace_id = ${workspaceId}
        AND cadence_seconds IS NOT NULL
        AND next_check_at IS NOT NULL
        AND next_check_at <= ${now}
        AND status <> 'checking'
      ORDER BY next_check_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE dependency_watches AS watch
    SET status = 'checking',
        last_trigger = 'scheduled',
        last_triggered_at = ${now},
        next_check_at = CASE
          WHEN cadence_seconds IS NULL THEN NULL
          ELSE ${now} + (cadence_seconds * interval '1 second')
        END,
        updated_at = ${now}
    FROM due
    WHERE watch.id = due.id
    RETURNING watch.*`
  );
}

/** Persist one observation and atomically make retries idempotent. */
export async function recordDependencyWatchObservation(
  input: RecordDependencyObservationInput
) {
  const watch = await getDependencyWatch(input.workspaceId, input.watchId);
  if (!watch || watch.repositoryId !== input.repositoryId) {
    throw new DependencyWatchAuthorizationError();
  }
  const sourceInventoryReceipt = input.sourceInventoryReceipt ?? null;
  const sourceInventoryReceiptSha256 = input.sourceInventoryReceiptSha256 ?? null;
  if ((sourceInventoryReceipt === null) !== (sourceInventoryReceiptSha256 === null)) {
    throw new DependencyWatchValidationError(
      "source inventory receipt and identity must be both absent or both present"
    );
  }
  const validatedSourceInventoryReceipt = sourceInventoryReceipt === null
    ? null
    : validateGoDependencySourceInventoryReceipt(
      sourceInventoryReceipt,
      sourceInventoryReceiptSha256!,
    );
  if (sourceInventoryReceipt !== null && validatedSourceInventoryReceipt === null) {
    throw new DependencyWatchValidationError(
      "source inventory receipt is not canonical or recomputable"
    );
  }
  if (sourceInventoryReceiptSha256 !== null
    && !input.observationKey.endsWith(`:source:${sourceInventoryReceiptSha256}`)) {
    throw new DependencyWatchValidationError(
      "source inventory receipt identity is not bound to the observation key"
    );
  }
  if (validatedSourceInventoryReceipt !== null) {
    const [repository] = await db
      .select({ name: repositories.name })
      .from(repositories)
      .where(and(
        eq(repositories.id, input.repositoryId),
        eq(repositories.workspaceId, input.workspaceId),
      ))
      .limit(1);
    if (!repository || typeof repository.name !== "string") {
      throw new DependencyWatchAuthorizationError();
    }
    validateSourceReceiptObservationBindings(
      input,
      watch,
      repository.name,
      validatedSourceInventoryReceipt,
    );
  }
  const observedAt = input.observedAt ?? new Date();
  const [observation] = await db
    .insert(dependencyWatchObservations)
    .values({
      workspaceId: input.workspaceId,
      watchId: input.watchId,
      repositoryId: input.repositoryId,
      trigger: input.trigger,
      baselineSha: input.baselineSha ?? null,
      selectedFileHashes: input.selectedFileHashes,
      observationKey: input.observationKey,
      candidateFingerprint: input.candidateFingerprint ?? null,
      sourceInventoryReceipt: validatedSourceInventoryReceipt,
      sourceInventoryReceiptSha256,
      status: input.status,
      candidates: input.candidates ?? [],
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      observedAt,
    })
    .onConflictDoNothing({
      target: [
        dependencyWatchObservations.workspaceId,
        dependencyWatchObservations.repositoryId,
        dependencyWatchObservations.observationKey,
      ],
    })
    .returning();

  const [updatedWatch] = await db
    .update(dependencyWatches)
    .set({
      lastCheckedSha: input.baselineSha ?? null,
      selectedFileHashes: input.selectedFileHashes,
      candidateFingerprint: input.status === "candidates" ? input.candidateFingerprint ?? null : null,
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      lastCheckedAt: observedAt,
      nextCheckAt: input.nextCheckAt ?? null,
      updatedAt: observedAt,
    })
    .where(and(eq(dependencyWatches.workspaceId, input.workspaceId), eq(dependencyWatches.id, input.watchId)))
    .returning();
  return { recorded: !!observation, observation: observation ?? null, watch: updatedWatch! };
}
