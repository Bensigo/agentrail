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

type ChangeRecordResponse = {
  record: ChangeRecord;
  events: ChangeRecordEvent[];
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

export function ChangeRecordView({ workspaceId, recordId }: { workspaceId: string; recordId: string }) {
  const [data, setData] = useState<ChangeRecordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        if (!body.record || !Array.isArray(body.events)) {
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

  const backHref = `/dashboard/${workspaceId}/work`;
  if (loading) {
    return (
      <div className="mx-auto max-w-[900px]">
        <a href={backHref} className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Work
        </a>
        <p className="animate-pulse py-8 text-sm text-[var(--gray-09)]">Loading change record...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-[900px]">
        <a href={backHref} className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Work
        </a>
        <p className="py-8 text-sm text-[var(--red-11)]">{error ?? "Change record not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <div>
        <a href={backHref} className="mb-3 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Work
        </a>
        <PageHeader
          title="Change Record"
          subtitle={`${data.record.repo} · ${data.record.state}`}
          actions={<CopyId id={data.record.id} label="Record" />}
        />
        <p className="text-xs text-[var(--gray-09)]">
          Created {formatChangeRecordDate(data.record.createdAt)} · Updated {formatChangeRecordDate(data.record.updatedAt)}
        </p>
      </div>
      <ChangeRecordAnchors record={data.record} />
      <LifecycleTimeline events={data.events} />
    </div>
  );
}
