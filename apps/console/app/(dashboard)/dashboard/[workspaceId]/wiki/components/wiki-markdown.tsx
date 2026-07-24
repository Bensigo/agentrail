"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

/**
 * Renders a wiki page's `body_md` — VERBATIM from the `wiki_pages` row,
 * "what you see is what the LLM sees" (Repo Wiki spec §4.5). No console-side
 * editing, no rewriting: this component only chooses how to DISPLAY the
 * exact text the row holds, the same distinction `chat-markdown.tsx` draws
 * for Jace's replies.
 *
 * Security: `react-markdown` is secure by default (per its own README) —
 * without `rehype-raw` it never renders raw HTML found in the source text,
 * so no separate sanitizer is needed. This matters here specifically because
 * wiki content is model-generated from repo content and is framed as
 * untrusted on the read side (spec §4.7 "Injection surface") — same posture
 * as `chat-markdown.tsx`'s identical security note. Links render as plain
 * inert `<a>` tags (no chip/URL-rewriting logic): a wiki page's actual
 * citation deep-links are a separate, server-built list rendered by
 * `wiki-page-view.tsx` from the `citations` column, not parsed out of prose.
 */
export function WikiMarkdown({ text }: { text: string }) {
  const components: Components = {
    // CodeBlock supplies its own <pre> chrome — unwrap the default one so a
    // fenced code block never nests two <pre>s (matches chat-markdown.tsx).
    pre: ({ children }) => <>{children}</>,
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className ?? "");
      const raw = String(children).replace(/\n$/, "");
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
      <h1 className="mt-5 mb-2 text-base font-bold text-[var(--gray-12)] first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-5 mb-2 text-sm font-bold text-[var(--gray-12)] first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-4 mb-1.5 text-sm font-semibold text-[var(--gray-12)] first:mt-0">
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
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1 text-left font-medium text-[var(--gray-10)]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-[var(--gray-05)] px-2 py-1 text-[var(--gray-11)]">{children}</td>
    ),
  };

  return (
    <div className="text-sm text-[var(--gray-12)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A fenced code block: language label, copy button, monospace body — same shape as chat-markdown.tsx's. */
function CodeBlock({ language, code }: { language: string | undefined; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied/unavailable — the code is still visible and
      // selectable, so failing silently here costs nothing worth surfacing.
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-01)]">
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
