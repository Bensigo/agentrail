"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RepositoryConnection({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const canonical = url
        .trim()
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(canonical);
      if (!match)
        throw new Error(
          "Enter a GitHub repository URL, such as https://github.com/owner/project.",
        );
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: match[1],
          url: canonical,
          default_branch: branch,
        }),
      });
      const body = await res.json();
      if (!res.ok)
        throw new Error(
          body.error ||
            Object.values(body.errors || {}).join(" ") ||
            "Could not add repository",
        );
      setMessage(
        `Added ${match[1]}. Your agent can now select it through workflow_repositories.`,
      );
      setUrl("");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not add repository",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      onSubmit={connect}
      className="flex max-w-3xl flex-col gap-3 rounded-lg border border-[var(--gray-05)] p-4"
    >
      <h2 className="font-semibold">Add your repository</h2>
      <p className="text-sm text-[var(--gray-11)]">
        Register the GitHub origin of your local checkout. Workflow tracking
        needs no GitHub login; remote GitHub actions require an optional App
        connection.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Repository URL
        <input
          required
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/project"
          className="rounded border border-[var(--gray-06)] bg-[var(--gray-02)] p-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Default branch
        <input
          required
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="rounded border border-[var(--gray-06)] bg-[var(--gray-02)] p-2"
        />
      </label>
      <button
        disabled={pending}
        className="self-start rounded border border-[var(--gray-06)] px-3 py-2 text-sm disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add repository"}
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </form>
  );
}
