"use client";

import { useState } from "react";

export function CreateIssueButton({
  workspaceId,
  gateId,
  findingIndex,
}: {
  workspaceId: string;
  gateId: string;
  findingIndex: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<{ url?: string | null; msg?: string }>({});

  async function create(target?: "github" | "linear") {
    setState("loading");
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/review-gates/${gateId}/issue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ findingIndex, target }),
        }
      );
      const json = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !json.ok) {
        setState("error");
        setResult({ msg: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState("done");
      setResult({ url: json.url, msg: "Issue created" });
    } catch {
      setState("error");
      setResult({ msg: "Network error" });
    }
  }

  if (state === "done") {
    return (
      <a href={result.url ?? "#"} className="text-xs text-[var(--green-11)] hover:underline">
        {result.msg} →
      </a>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={() => create()}
        disabled={state === "loading"}
        className="text-xs text-[var(--blue-11)] hover:underline disabled:opacity-50"
      >
        {state === "loading" ? "Creating…" : "Create issue"}
      </button>
      {state === "error" && (
        <span className="text-xs text-[var(--red-11)]" title={result.msg}>
          {result.msg}
        </span>
      )}
    </span>
  );
}
