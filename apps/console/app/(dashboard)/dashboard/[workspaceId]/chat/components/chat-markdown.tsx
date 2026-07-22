"use client";

import { useState } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, CircleDot, Copy, FileCode, GitPullRequest, Target } from "lucide-react";
import { linkifyGoalReferences, parseGithubLink, type GithubLinkInfo } from "./chat-helpers";

/**
 * Renders Jace's reply text as real markdown (#1288 chat rework) — headings,
 * lists, code blocks with copy, inline code, and links — instead of the
 * previous `whitespace-pre-wrap` plain-text block.
 *
 * Security: `react-markdown` is secure by default (per its own README) —
 * without `rehype-raw` it never renders raw HTML found in the source text,
 * so no separate sanitizer is added here. `remark-gfm` only adds parsing for
 * tables/strikethrough/autolinks/task lists; it doesn't touch the HTML
 * escaping behavior.
 *
 * Rich structured parts, client-side (design decision — see the PR body):
 * rather than a server-emitted `parts`/`blocks` JSON column, this is a
 * client-side-only pass — `linkifyGoalReferences` rewrites the
 * `(goal:<slug>)` stamp convention (`schema/goals.ts`) into a `goal://<slug>`
 * markdown link BEFORE handoff to `ReactMarkdown`, so both goal references
 * and GitHub PR/issue/file links flow through the SAME `a` component
 * override below — one link-rendering path, not two renderers.
 */
export function ChatMarkdown({ text, workspaceId }: { text: string; workspaceId: string }) {
  const components: Components = {
    // CodeBlock (returned by the `code` component below for a block-shaped
    // match) supplies its own `<pre>` chrome — unwrap the default one here so
    // a fenced code block never nests two <pre>s.
    pre: ({ children }) => <>{children}</>,
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className ?? "");
      const raw = String(children).replace(/\n$/, "");
      // A fenced block always has a wrapping `pre` (react-markdown/remark);
      // inline code never does. `className` only carries a `language-*` tag
      // when the fence names one (```js), so a fenced-but-unlabeled block is
      // caught by the newline check instead — see this file's own header
      // comment on why `pre` is unwrapped rather than relied on for this.
      const isBlock = Boolean(match) || raw.includes("\n");
      if (isBlock) {
        return <CodeBlock language={match?.[1]} code={raw} />;
      }
      return (
        <code className="rounded bg-[var(--gray-04)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--gray-12)]">
          {children}
        </code>
      );
    },
    a({ href, children }) {
      if (!href) return <>{children}</>;
      if (href.startsWith("goal://")) {
        return <GoalChip workspaceId={workspaceId} slug={href.slice("goal://".length)} />;
      }
      const info = parseGithubLink(href);
      if (info) return <GithubLinkChip href={href} info={info} />;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--blue-11)] underline underline-offset-2 hover:text-[var(--blue-09)]"
        >
          {children}
        </a>
      );
    },
    p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-3">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-[var(--gray-08)]">{children}</ul>,
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-[var(--gray-08)]">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    h1: ({ children }) => (
      <h1 className="mt-4 mb-2 text-base font-bold text-[var(--gray-12)] first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-4 mb-2 text-sm font-bold text-[var(--gray-12)] first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--gray-12)] first:mt-0">
        {children}
      </h3>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-[var(--gray-06)] pl-3 text-[var(--gray-10)]">
        {children}
      </blockquote>
    ),
    strong: ({ children }) => <strong className="font-semibold text-[var(--gray-12)]">{children}</strong>,
    hr: () => <hr className="my-3 border-[var(--gray-05)]" />,
  };

  return (
    <div className="text-sm text-[var(--gray-12)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {linkifyGoalReferences(text)}
      </ReactMarkdown>
    </div>
  );
}

/** A fenced code block: language label, copy button, monospace body. */
function CodeBlock({ language, code }: { language: string | undefined; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied/unavailable — the code is still visible and
      // selectable, so failing silently here costs nothing worth surfacing
      // (mirrors this thread's existing "a poll failure is silent" posture).
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)]">
      <div className="flex items-center justify-between border-b border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--gray-09)]">
          {language || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--gray-09)] transition-colors hover:text-[var(--gray-12)]"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-xs leading-relaxed text-[var(--gray-12)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const CHIP_CLASSNAME =
  "inline-flex items-center gap-1 rounded-md border border-[var(--gray-06)] bg-[var(--gray-03)] px-1.5 py-0.5 align-middle text-[0.85em] font-medium text-[var(--gray-11)] no-underline transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)]";

/** GitHub PR / issue / file-blob link, rendered as an icon + name chip instead of a raw URL (`ui-prefer-names-over-ids`). */
function GithubLinkChip({ href, info }: { href: string; info: GithubLinkInfo }) {
  if (info.kind === "file") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={CHIP_CLASSNAME} title={info.path}>
        <FileCode size={12} />
        {info.filename}
      </a>
    );
  }
  const Icon = info.kind === "pull" ? GitPullRequest : CircleDot;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={CHIP_CLASSNAME}>
      <Icon size={12} />
      {info.owner}/{info.repo}#{info.number}
    </a>
  );
}

/** A `(goal:<slug>)` reference, rendered as a chip linking to the workspace Goals page (no per-goal route exists yet, so this links to the list, not a single goal). */
function GoalChip({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  return (
    <Link href={`/dashboard/${workspaceId}/goals`} className={CHIP_CLASSNAME}>
      <Target size={12} />
      Goal: {slug}
    </Link>
  );
}
