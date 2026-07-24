"use client";

import type { WikiPageDTO } from "../wiki-format";

interface WikiNavTreeProps {
  overview: WikiPageDTO | null;
  units: WikiPageDTO[];
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
}

/**
 * Left nav tree: overview on top, unit pages beneath (spec §4.5). Driven
 * entirely by `kind`/`slug` off the rows the page already has — no markdown
 * parsing, no separate index fetch.
 */
export function WikiNavTree({ overview, units, selectedSlug, onSelectSlug }: WikiNavTreeProps) {
  return (
    <nav className="flex flex-col gap-3 text-sm" aria-label="Wiki pages">
      {overview && (
        <NavRow page={overview} selected={selectedSlug === overview.slug} onSelect={onSelectSlug} />
      )}
      {units.length > 0 && (
        <div>
          <p className="px-2 pb-1 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Units
          </p>
          <div className="flex flex-col gap-0.5">
            {units.map((page) => (
              <NavRow
                key={page.slug}
                page={page}
                selected={selectedSlug === page.slug}
                onSelect={onSelectSlug}
              />
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

function NavRow({
  page,
  selected,
  onSelect,
}: {
  page: WikiPageDTO;
  selected: boolean;
  onSelect: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(page.slug)}
      aria-current={selected ? "page" : undefined}
      className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors duration-150 ${
        selected
          ? "bg-[var(--gray-03)] font-medium text-[var(--gray-12)]"
          : "text-[var(--gray-11)] hover:bg-[var(--gray-02)] hover:text-[var(--gray-12)]"
      }`}
    >
      {/* UI names over IDs: the page title, never the slug. */}
      <span className="min-w-0 flex-1 truncate">{page.title}</span>
      {page.stale && (
        <span
          aria-label="Stale"
          title="Stale"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--yellow-09)]"
        />
      )}
    </button>
  );
}
