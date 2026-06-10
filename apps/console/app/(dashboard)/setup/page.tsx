"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; general?: string }>({});

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(toSlug(value));
    }
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

      const data = await res.json() as
        | { id: string; name: string; slug: string }
        | { error: { code: string; field?: string; message: string } | string };

      if (!res.ok) {
        if (typeof data === "object" && "error" in data && typeof data.error === "object" && data.error !== null && "field" in data.error) {
          const err = data.error as FieldError;
          if (err.field === "name") {
            setErrors({ name: err.message });
          } else if (err.field === "slug") {
            setErrors({ slug: err.message });
          } else {
            setErrors({ general: err.message });
          }
        } else {
          setErrors({ general: "Something went wrong. Please try again." });
        }
        return;
      }

      const workspace = data as { id: string; name: string; slug: string };
      router.push(`/dashboard/${workspace.id}`);
    } catch {
      setErrors({ general: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--gray-00)] px-4">
      <div className="w-full max-w-md">
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
                "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]",
                "transition-colors duration-150",
                errors.name
                  ? "border-[#e5484d]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-[#ff9592]">{errors.name}</p>
            )}
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
                "focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]",
                "transition-colors duration-150",
                errors.slug
                  ? "border-[#e5484d]"
                  : "border-[var(--gray-05)] hover:border-[var(--gray-08)]",
              ].join(" ")}
            />
            <p className="mt-1 text-xs text-[var(--gray-09)]">
              Lowercase letters, digits, and hyphens only. 2–32 characters.
            </p>
            {errors.slug && (
              <p className="mt-1 text-xs text-[#ff9592]">{errors.slug}</p>
            )}
          </div>

          {errors.general && (
            <p className="text-xs text-[#ff9592]">{errors.general}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded bg-[#ffe629] px-4 py-2 text-sm font-medium text-black transition-colors duration-150 hover:bg-[#ffdc00] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
