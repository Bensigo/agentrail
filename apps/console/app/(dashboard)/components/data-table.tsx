"use client";

import { useState, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { SkeletonTableRows } from "../../components/loading-skeleton";

// Extend tanstack column meta to support monospace flag.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    mono?: boolean;
  }
}

interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  filterBar?: React.ReactNode;
  /** Required when renderSubRow is provided — used to key expanded rows. */
  rowKey?: (row: T) => string;
  /** When provided, rows become clickable and expand to show this content. */
  renderSubRow?: (row: T) => React.ReactNode;
  /**
   * When provided, rows become clickable and call this instead of expanding
   * (e.g. navigate to a detail page). Takes priority over `renderSubRow` if
   * both are somehow passed.
   */
  onRowClick?: (row: T) => void;
  onRetry?: () => void;
  skeletonRows?: number;
}

function SortIcon({ dir }: { dir: "asc" | "desc" | false }) {
  if (!dir) return <span className="ml-0.5 text-[var(--gray-07)]">↕</span>;
  return (
    <span className="ml-0.5 text-[var(--accent-text)]">{dir === "asc" ? "↑" : "↓"}</span>
  );
}

export function DataTable<T>({
  columns,
  data,
  loading = false,
  error = null,
  emptyMessage = "No records found.",
  filterBar,
  rowKey,
  renderSubRow,
  onRowClick,
  onRetry,
  skeletonRows = 8,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const toggleExpand = useCallback(
    (row: T) => {
      if (!rowKey) return;
      const key = rowKey(row);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [rowKey]
  );

  const hasExpand = Boolean(renderSubRow) && !onRowClick;
  const clickable = Boolean(onRowClick) || hasExpand;
  const colSpan = columns.length + (hasExpand ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      {filterBar}
      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {table.getFlatHeaders().map((header) => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] select-none ${
                    header.column.getCanSort()
                      ? "cursor-pointer hover:text-[var(--gray-12)]"
                      : ""
                  }`}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                  {header.column.getCanSort() && (
                    <SortIcon dir={header.column.getIsSorted()} />
                  )}
                </th>
              ))}
              {hasExpand && <th className="w-6 px-2" aria-hidden />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={colSpan} rows={skeletonRows} />
            ) : error ? (
              <tr>
                <td colSpan={colSpan} className="px-3 py-8 text-center">
                  <div className="flex flex-col items-center gap-2">
                    {/* font-mono: matches the sitewide fetch-error treatment
                        (digest-panel, health-rates-panel, ErrorState). */}
                    <span className="font-mono text-sm text-[var(--red-11)]">{error}</span>
                    {onRetry && (
                      <button
                        onClick={onRetry}
                        className="text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] underline transition-colors"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={colSpan}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.flatMap((row) => {
                const key = rowKey ? rowKey(row.original) : row.id;
                const isExpanded = rowKey
                  ? expandedKeys.has(rowKey(row.original))
                  : false;

                return [
                  <tr
                    key={row.id}
                    onClick={
                      onRowClick
                        ? () => onRowClick(row.original)
                        : hasExpand
                          ? () => toggleExpand(row.original)
                          : undefined
                    }
                    className={`border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors${clickable ? " cursor-pointer" : ""}`}
                    style={{ height: "34px" }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const mono = cell.column.columnDef.meta?.mono;
                      return (
                        <td
                          key={cell.id}
                          className={`px-3 py-1.5${mono ? " font-mono text-[13px]" : ""}`}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </td>
                      );
                    })}
                    {hasExpand && (
                      <td className="w-6 px-2 text-xs text-[var(--gray-08)] text-right">
                        {isExpanded ? "▲" : "▼"}
                      </td>
                    )}
                  </tr>,
                  ...(renderSubRow && isExpanded
                    ? [
                        <tr key={`${key}-sub`} className="bg-[var(--gray-01)]">
                          <td colSpan={colSpan} className="px-4 pb-4 pt-1">
                            {renderSubRow(row.original)}
                          </td>
                        </tr>,
                      ]
                    : []),
                ];
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
