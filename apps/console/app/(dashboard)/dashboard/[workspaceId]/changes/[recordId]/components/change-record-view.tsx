"use client";

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { CopyId } from "../../../../../../components/copy-id";
import { PageHeader } from "../../../../../../components/page-header";

export type ChangeRecord = {
  id: string;
  workspaceId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  headShas: string[];
  mergedSha: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
};

export type ChangeRecordEvent = {
  id: string;
  recordId: string;
  eventKey: string;
  stage: string;
  actor: string;
  payloadRef: Record<string, unknown>;
  at: string;
  createdAt: string;
};

export type AcceptanceContract = {
  id: string;
  recordId: string;
  version: number;
  status: "draft" | "confirmed";
  contract: Record<string, unknown>;
  createdBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
};

export type AcceptanceContextPack = {
  id: string;
  recordId: string;
  version: number;
  phase: string;
  contentHash: string;
  compilerVersion: string;
  manifest: Record<string, unknown>;
  custody: Record<string, unknown>;
  freshness: Record<string, unknown>;
  jsonArtifactRef: string | null;
  markdownArtifactRef: string | null;
  createdBy: string;
  createdAt: string;
};

export type AcceptanceEvidenceReview = {
  id: string;
  prRevisionId: string;
  headSha: string;
  repositoryFullName: string;
  prNumber: number;
  overallStatus: string;
  contractId: string;
  contractVersion: number;
  createdAt: string;
  supersededAt: string | null;
};

type ChangeRecordResponse = {
  record: ChangeRecord;
  events: ChangeRecordEvent[];
  contracts: AcceptanceContract[];
  contextPacks: AcceptanceContextPack[];
  reviews: AcceptanceEvidenceReview[];
};

export function changeRecordApiPath(workspaceId: string, recordId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/change-records/${encodeURIComponent(recordId)}`;
}

export function formatChangeRecordDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function githubUrl(repo: string, kind: "issues" | "pull", number: number): string {
  return `https://github.com/${repo}/${kind}/${number}`;
}

export function ChangeRecordAnchors({ record }: { record: ChangeRecord }) {
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Change anchors
        </h2>
      </div>
      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[var(--gray-09)]">Repository</dt>
          <dd className="mt-1 font-mono text-[var(--gray-12)]">{record.repo}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">State</dt>
          <dd className="mt-1 capitalize text-[var(--gray-12)]">{record.state}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">Issue</dt>
          <dd className="mt-1">
            {record.issueNumber == null ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              <a
                href={githubUrl(record.repo, "issues", record.issueNumber)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[var(--blue-11)] hover:underline"
              >
                #{record.issueNumber}
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">Pull request</dt>
          <dd className="mt-1">
            {record.prNumber == null ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              <a
                href={githubUrl(record.repo, "pull", record.prNumber)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[var(--blue-11)] hover:underline"
              >
                #{record.prNumber}
              </a>
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[var(--gray-09)]">Head commits</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {record.headShas.length === 0 ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              record.headShas.map((sha) => (
                <code key={sha} title={sha} className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-[var(--gray-11)]">
                  {sha.slice(0, 12)}
                </code>
              ))
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[var(--gray-09)]">Merged commit</dt>
          <dd className="mt-1">
            {record.mergedSha ? (
              <code title={record.mergedSha} className="font-mono text-[var(--gray-11)]">
                {record.mergedSha.slice(0, 12)}
              </code>
            ) : (
              <span className="text-[var(--gray-08)]">Not attached</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function LifecycleTimeline({ events }: { events: ChangeRecordEvent[] }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
        Lifecycle events ({events.length})
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-[var(--gray-09)]">No lifecycle evidence attached yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {events.map((event, index) => (
            <li
              key={event.id}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium capitalize text-[var(--gray-12)]">
                    {event.stage}
                  </span>
                  <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-xs text-[var(--gray-09)]">
                    {event.actor}
                  </span>
                </div>
                <time dateTime={event.at} title={new Date(event.at).toLocaleString()} className="font-mono text-xs text-[var(--gray-09)]">
                  {formatChangeRecordDate(event.at)}
                </time>
              </div>
              <p className="mt-2 font-mono text-xs text-[var(--gray-09)]">
                {index + 1}. {event.eventKey}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
                  Evidence reference
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 font-mono text-xs text-[var(--gray-11)]">
                  {JSON.stringify(event.payloadRef, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function isConfirmableContract(
  contract: AcceptanceContract,
  contracts: AcceptanceContract[]
): boolean {
  return contract.status === "draft" && !contracts.some((item) => item.status === "confirmed");
}

export function AcceptanceContractPanel({
  contracts,
  onConfirm,
  confirmingVersion,
  confirmationError,
}: {
  contracts: AcceptanceContract[];
  onConfirm: (version: number) => void;
  confirmingVersion: number | null;
  confirmationError: string | null;
}) {
  if (contracts.length === 0) {
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Acceptance Contract
        </h2>
        <p className="mt-2 text-sm text-[var(--gray-09)]">
          No Acceptance Contract has been recorded yet. Do not treat implementation or review as
          proof of an unrecorded request.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-05)] px-4 py-3">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
            Acceptance Contract
          </h2>
          <p className="mt-1 text-xs text-[var(--gray-09)]">
            The agreed request that Jace will use to judge the evidence.
          </p>
        </div>
        {contracts.some((contract) => contract.status === "confirmed") ? (
          <span className="rounded-sm bg-[var(--green-09)]/20 px-2 py-1 text-xs font-medium text-[var(--green-11)]">
            Confirmed
          </span>
        ) : (
          <span className="rounded-sm bg-[var(--yellow-09)]/20 px-2 py-1 text-xs font-medium text-[var(--yellow-11)]">
            Needs confirmation
          </span>
        )}
      </div>
      <ol className="flex flex-col gap-3 px-4 py-4">
        {contracts.map((contract) => {
          const confirmable = isConfirmableContract(contract, contracts);
          const pending = confirmingVersion === contract.version;
          return (
            <li key={contract.id} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-[var(--gray-11)]">v{contract.version}</span>
                  <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 text-xs capitalize text-[var(--gray-11)]">
                    {contract.status}
                  </span>
                </div>
                {confirmable ? (
                  <button
                    type="button"
                    onClick={() => onConfirm(contract.version)}
                    disabled={pending}
                    className="rounded bg-[var(--blue-09)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--blue-10)] disabled:cursor-wait disabled:opacity-60"
                  >
                    {pending ? "Confirming…" : "Confirm contract"}
                  </button>
                ) : contract.status === "confirmed" ? (
                  <span className="text-xs text-[var(--gray-09)]">
                    Confirmed {contract.confirmedAt ? formatChangeRecordDate(contract.confirmedAt) : ""}
                  </span>
                ) : null}
              </div>
              <details className="mt-3" open={contracts.length === 1}>
                <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
                  View agreed requirements
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 font-mono text-xs text-[var(--gray-11)]">
                  {JSON.stringify(contract.contract, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
      {confirmationError ? <p className="px-4 pb-4 text-sm text-[var(--red-11)]">{confirmationError}</p> : null}
    </section>
  );
}

export function AcceptanceContextPackPanel({ contextPacks }: { contextPacks: AcceptanceContextPack[] }) {
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Context Pack delivery
        </h2>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          Recorded context is observable. Its delivery is not proof that the agent implemented or verified the change.
        </p>
      </div>
      {contextPacks.length === 0 ? (
        <p className="px-4 py-4 text-sm text-[var(--gray-09)]">
          No Context Pack has been recorded for this Acceptance Record.
        </p>
      ) : (
        <ol className="flex flex-col gap-3 px-4 py-4">
          {contextPacks.map((pack) => (
            <li key={pack.id} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-[var(--gray-11)]">v{pack.version}</span>
                  <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 text-xs capitalize text-[var(--gray-11)]">
                    {pack.phase}
                  </span>
                </div>
                <time dateTime={pack.createdAt} className="font-mono text-xs text-[var(--gray-09)]">
                  {formatChangeRecordDate(pack.createdAt)}
                </time>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--gray-09)]">Content hash</dt>
                  <dd className="mt-1 break-all font-mono text-[var(--gray-11)]">{pack.contentHash}</dd>
                </div>
                <div>
                  <dt className="text-[var(--gray-09)]">Compiler</dt>
                  <dd className="mt-1 font-mono text-[var(--gray-11)]">{pack.compilerVersion}</dd>
                </div>
              </dl>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
                  View citations, custody, freshness, and artifact references
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 font-mono text-xs text-[var(--gray-11)]">
                  {JSON.stringify(
                    {
                      manifest: pack.manifest,
                      custody: pack.custody,
                      freshness: pack.freshness,
                      jsonArtifactRef: pack.jsonArtifactRef,
                      markdownArtifactRef: pack.markdownArtifactRef,
                    },
                    null,
                    2
                  )}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function FinalPrDecisionPanel({
  reviews,
  onDecide,
  decidingReviewId,
  decisionError,
  exceptionRationale,
  onExceptionRationaleChange,
}: {
  reviews: AcceptanceEvidenceReview[];
  onDecide: (review: AcceptanceEvidenceReview, decision: "approved" | "changes_requested" | "rejected" | "approved_with_exception", rationale?: string) => void;
  decidingReviewId: string | null;
  decisionError: string | null;
  exceptionRationale: string;
  onExceptionRationaleChange: (value: string) => void;
}) {
  const current = reviews.find((review) => review.supersededAt === null);
  if (!current) {
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Final PR decision</h2>
        <p className="mt-2 text-sm text-[var(--gray-09)]">
          No current exact-head evidence review is available. Jace cannot record a final decision against an unreviewed or superseded PR revision.
        </p>
      </section>
    );
  }
  const pending = decidingReviewId === current.id;
  const hasProvenReview = current.overallStatus === "proven";
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Final PR decision</h2>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          A human decides this exact reviewed head. Recording a decision never merges code or changes Jace&apos;s evidence verdict.
        </p>
      </div>
      <div className="space-y-3 px-4 py-4">
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-[var(--gray-09)]">Review verdict</dt><dd className="mt-1 font-mono text-[var(--gray-11)]">{current.overallStatus}</dd></div>
          <div><dt className="text-[var(--gray-09)]">Exact head</dt><dd className="mt-1 break-all font-mono text-[var(--gray-11)]">{current.headSha}</dd></div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {hasProvenReview ? (
            <button type="button" disabled={pending} onClick={() => onDecide(current, "approved")} className="rounded bg-[var(--green-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60">
              {pending ? "Recording…" : "Approve for merge"}
            </button>
          ) : null}
          <button type="button" disabled={pending} onClick={() => onDecide(current, "changes_requested")} className="rounded bg-[var(--blue-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60">
            Request changes
          </button>
          <button type="button" disabled={pending} onClick={() => onDecide(current, "rejected")} className="rounded border border-[var(--gray-06)] px-2.5 py-1.5 text-xs font-medium text-[var(--gray-12)] disabled:opacity-60">
            Reject PR
          </button>
        </div>
        {!hasProvenReview ? (
          <div className="rounded border border-[var(--yellow-06)] bg-[var(--yellow-03)] p-3">
            <label className="block text-xs font-medium text-[var(--gray-12)]" htmlFor={`exception-${current.id}`}>Explicit exception rationale</label>
            <textarea id={`exception-${current.id}`} value={exceptionRationale} onChange={(event) => onExceptionRationaleChange(event.target.value)} maxLength={4_000} rows={2} className="mt-2 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-01)] p-2 text-xs text-[var(--gray-12)]" placeholder="Why this non-proven or blocked review is being accepted" />
            <button type="button" disabled={pending || !exceptionRationale.trim()} onClick={() => onDecide(current, "approved_with_exception", exceptionRationale)} className="mt-2 rounded border border-[var(--yellow-08)] px-2.5 py-1.5 text-xs font-medium text-[var(--yellow-11)] disabled:opacity-60">
              Record approval with exception
            </button>
          </div>
        ) : null}
        {decisionError ? <p className="text-sm text-[var(--red-11)]">{decisionError}</p> : null}
      </div>
    </section>
  );
}

export function ChangeRecordView({ workspaceId, recordId }: { workspaceId: string; recordId: string }) {
  const [data, setData] = useState<ChangeRecordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingVersion, setConfirmingVersion] = useState<number | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [decidingReviewId, setDecidingReviewId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [exceptionRationale, setExceptionRationale] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as Partial<ChangeRecordResponse> & { error?: string };
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        if (
          !body.record ||
          !Array.isArray(body.events) ||
          !Array.isArray(body.contracts) ||
          !Array.isArray(body.contextPacks) ||
          !Array.isArray(body.reviews)
        ) {
          throw new Error("Change record response was incomplete");
        }
        setData(body as ChangeRecordResponse);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Failed to load change record");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [workspaceId, recordId]);

  async function confirmContract(version: number) {
    setConfirmingVersion(version);
    setConfirmationError(null);
    try {
      const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm_contract", version }),
      });
      const body = (await response.json().catch(() => ({}))) as { contract?: AcceptanceContract; error?: string };
      if (!response.ok || !body.contract) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setData((current) =>
        current
          ? {
              ...current,
              contracts: current.contracts.map((contract) =>
                contract.id === body.contract!.id ? body.contract! : contract
              ),
            }
          : current
      );
    } catch (caught) {
      setConfirmationError(
        caught instanceof Error ? caught.message : "Failed to confirm Acceptance Contract"
      );
    } finally {
      setConfirmingVersion(null);
    }
  }

  async function recordFinalDecision(
    review: AcceptanceEvidenceReview,
    decision: "approved" | "changes_requested" | "rejected" | "approved_with_exception",
    rationale?: string,
  ) {
    setDecidingReviewId(review.id);
    setDecisionError(null);
    try {
      const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "record_pr_decision", reviewId: review.id, decision, ...(rationale ? { rationale } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { event?: ChangeRecordEvent; error?: string };
      if (!response.ok || !body.event) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData((current) => current ? { ...current, events: [...current.events, body.event!] } : current);
    } catch (caught) {
      setDecisionError(caught instanceof Error ? caught.message : "Failed to record final PR decision");
    } finally {
      setDecidingReviewId(null);
    }
  }

  const backHref = `/dashboard/${workspaceId}/changes`;
  if (loading) {
    return (
      <div className="mx-auto max-w-[900px]">
        <a href={backHref} className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Changes
        </a>
        <p className="animate-pulse py-8 text-sm text-[var(--gray-09)]">Loading change record...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-[900px]">
        <a href={backHref} className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Changes
        </a>
        <p className="py-8 text-sm text-[var(--red-11)]">{error ?? "Change record not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <div>
        <a href={backHref} className="mb-3 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Changes
        </a>
        <PageHeader
          title="Acceptance Record"
          subtitle={`${data.record.repo} · ${data.record.state}`}
          actions={<CopyId id={data.record.id} label="Record" />}
        />
        <p className="text-xs text-[var(--gray-09)]">
          Created {formatChangeRecordDate(data.record.createdAt)} · Updated {formatChangeRecordDate(data.record.updatedAt)}
        </p>
      </div>
      <AcceptanceContractPanel
        contracts={data.contracts}
        onConfirm={confirmContract}
        confirmingVersion={confirmingVersion}
        confirmationError={confirmationError}
      />
      <AcceptanceContextPackPanel contextPacks={data.contextPacks} />
      <FinalPrDecisionPanel reviews={data.reviews} onDecide={recordFinalDecision} decidingReviewId={decidingReviewId} decisionError={decisionError} exceptionRationale={exceptionRationale} onExceptionRationaleChange={setExceptionRationale} />
      <ChangeRecordAnchors record={data.record} />
      <LifecycleTimeline events={data.events} />
    </div>
  );
}
