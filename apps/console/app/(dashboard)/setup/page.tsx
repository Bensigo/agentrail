"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { OnboardingWizard } from "./components/onboarding-wizard";

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

interface FieldError {
  field: string;
  message: string;
}

/**
 * `/setup` — the first-run flow (#1233, spec §5). Workspace creation (below)
 * stays the entry point; once a workspace exists (freshly created, or via
 * `?workspace=<id>` deep link — the Home progress banner links back here for
 * an existing workspace with incomplete steps) the four derived-state
 * onboarding steps take over.
 */
function SetupPageContent() {
  const searchParams = useSearchParams();
  const deepLinkedWorkspaceId = searchParams.get("workspace");

  const [workspaceId, setWorkspaceId] = useState<string | null>(
    deepLinkedWorkspaceId
  );

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; general?: string }>({});

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) setSlug(toSlug(value));
  }

  function handleSlugChange(value: string) {
    setSlug(value);
    setSlugEdited(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setSubmitting(true);

    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });

      const data = (await res.json()) as
        | { id: string; name: string; slug: string }
        | { error: { code: string; field?: string; message: string } | string };

      if (!res.ok) {
        if (
          typeof data === "object" &&
          "error" in data &&
          typeof data.error === "object" &&
          data.error !== null &&
          "field" in data.error
        ) {
          const err = data.error as FieldError;
          if (err.field === "name") setErrors({ name: err.message });
          else if (err.field === "slug") setErrors({ slug: err.message });
          else setErrors({ general: err.message });
        } else {
          setErrors({ general: "Something went wrong. Please try again." });
        }
        return;
      }

      const workspace = data as { id: string; name: string; slug: string };
      setWorkspaceId(workspace.id);
    } catch {
      setErrors({ general: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  if (workspaceId) {
    return (
      <div className="flex min-h-screen justify-center bg-[var(--gray-00)] px-4 py-12">
        <div className="w-full max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
            Set up your workspace
          </h1>
          <p className="mt-2 text-sm text-[var(--gray-09)]">
            Connect the things Jace needs to start shipping. Every step here
            can be finished later from Connectors, Members, or this page.
          </p>
          <div className="mt-8">
            <OnboardingWizard workspaceId={workspaceId} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
      <div className="w-full max-w-md">
        <div className="mb-1 text-xs text-[var(--gray-09)]">Get started</div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
          Create a workspace
        </h1>
        <p className="mt-2 text-sm text-[var(--gray-09)]">
          Create your first workspace to get started.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-5">
          <div>
            <label
              htmlFor="name"
              className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
            >
              Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="My workspace"
              maxLength={80}
              autoFocus
              className={[
                "mt-1.5 block w-full rounded border bg-[var(--gray-02)] px-3 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--brand-accent)] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]",
                "transition-colors duration-150",
                errors.name
                  ? "border-[var(--red-09)]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
            />
            {errors.name && <p className="mt-1 text-xs text-[var(--red-11)]">{errors.name}</p>}
          </div>

          <div>
            <label
              htmlFor="slug"
              className="block text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
            >
              Slug
            </label>
            <input
              id="slug"
              type="text"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="my-workspace"
              className={[
                "mt-1.5 block w-full rounded border bg-[var(--gray-02)] px-3 py-2 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--brand-accent)] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]",
                "transition-colors duration-150",
                errors.slug
                  ? "border-[var(--red-09)]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
            />
            <p className="mt-1 text-xs text-[var(--gray-09)]">
              Lowercase letters, digits, and hyphens only. 2–32 characters.
            </p>
            {errors.slug && <p className="mt-1 text-xs text-[var(--red-11)]">{errors.slug}</p>}
          </div>

          {errors.general && <p className="text-xs text-[var(--red-11)]">{errors.general}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded bg-[var(--brand-accent)] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--brand-accent)] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupPageContent />
    </Suspense>
  );
}
