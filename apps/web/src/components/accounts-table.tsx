'use client';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Eye } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { ScoreCell } from '@/components/blocks/score';
import { relTime, STREAM_LABEL, type AccountRow } from '@/lib/crm';
import { cn } from '@/lib/utils';

const ROW_HEIGHT = 44;

/**
 * Accounts DataTable (docs/ui.md §3.2, §4): TanStack Table + Virtual, sticky header, pinned
 * company column, selection, keyboard cursor and a footer count. Selection and cursor are
 * controlled by the page so keys and the bulk bar can act on them.
 */
export function AccountsTable({
  rows,
  columns: visibleCols,
  selected,
  onToggle,
  onToggleAll,
  cursor,
  onCursor,
  onPreview,
  onOpen,
  height = 'calc(100vh - 15rem)',
}: {
  rows: AccountRow[];
  columns: string[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (all: boolean) => void;
  cursor: number;
  onCursor: (i: number) => void;
  onPreview: (id: string) => void;
  onOpen: (id: string) => void;
  height?: string;
}) {
  const now = Date.now();
  const columns = useMemo<ColumnDef<AccountRow>[]>(
    () => [
      {
        id: 'select',
        size: 36,
        header: () => (
          <input
            type="checkbox"
            aria-label="Select all"
            checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
            onChange={(e) => onToggleAll(e.target.checked)}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.name}`}
            checked={selected.has(row.original.id)}
            onChange={() => onToggle(row.original.id)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
      {
        id: 'company',
        size: 240,
        header: 'Company',
        cell: ({ row }) => (
          <span className="group flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="min-w-0 truncate text-left font-medium hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                onPreview(row.original.id);
              }}
            >
              {row.original.name}
            </button>
            <span className="text-muted-foreground truncate text-xs">{row.original.domain}</span>
            <Eye
              className="text-muted-foreground invisible size-3.5 shrink-0 group-hover:visible"
              aria-hidden
            />
          </span>
        ),
      },
      {
        id: 'priority',
        size: 330,
        header: 'Priority',
        cell: ({ row }) => <ScoreCell score={row.original} />,
      },
      { id: 'stage', size: 110, header: 'Stage', cell: ({ row }) => row.original.stage },
      {
        id: 'stream',
        size: 100,
        header: 'Stream',
        cell: ({ row }) => STREAM_LABEL[row.original.firstSource] ?? row.original.firstSource,
      },
      {
        id: 'last',
        size: 70,
        header: 'Last',
        cell: ({ row }) => relTime(row.original.lastActivityAt, now),
      },
      {
        id: 'next',
        size: 170,
        header: 'Next step',
        cell: ({ row }) =>
          row.original.nextStep ? (
            <span className="truncate" title={row.original.nextStep}>
              {row.original.nextStep}
              {row.original.nextStepDueAt ? (
                <span className="text-muted-foreground">
                  {' '}
                  ·{' '}
                  {new Date(row.original.nextStepDueAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'industry',
        size: 160,
        header: 'Industry',
        cell: ({ row }) => row.original.industry ?? '—',
      },
      { id: 'state', size: 60, header: 'State', cell: ({ row }) => row.original.state ?? '—' },
      { id: 'size', size: 90, header: 'Size', cell: ({ row }) => row.original.sizeRange ?? '—' },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selected],
  );

  const columnVisibility = useMemo<VisibilityState>(() => {
    const v: VisibilityState = {};
    for (const c of ['priority', 'stage', 'stream', 'last', 'next', 'industry', 'state', 'size'])
      v[c] = visibleCols.includes(c);
    return v;
  }, [visibleCols]);

  // TanStack Table returns non-memoizable functions by design; the React Compiler lint knows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
  });
  const parentRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    if (cursor >= 0) virtualizer.scrollToIndex(cursor, { align: 'auto' });
  }, [cursor, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;
  const visibleCount = table.getVisibleLeafColumns().length;

  return (
    <div className="flex flex-col rounded-lg border">
      <div ref={parentRef} className="overflow-auto" style={{ maxHeight: height }}>
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <colgroup>
            {table.getVisibleLeafColumns().map((c) => (
              <col key={c.id} style={{ width: c.getSize() }} />
            ))}
          </colgroup>
          <thead className="bg-background sticky top-0 z-20">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className={cn(
                      'text-muted-foreground bg-background border-b px-2 py-2 text-left text-xs font-medium',
                      h.column.id === 'select' && 'sticky left-0 z-10',
                      h.column.id === 'company' && 'sticky left-9 z-10',
                    )}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 ? (
              <tr aria-hidden>
                <td colSpan={visibleCount} style={{ height: padTop }} />
              </tr>
            ) : null}
            {items.map((vi) => {
              const row = tableRows[vi.index]!;
              const active = vi.index === cursor;
              return (
                <tr
                  key={row.id}
                  data-index={vi.index}
                  aria-selected={selected.has(row.id)}
                  onClick={() => onCursor(vi.index)}
                  onDoubleClick={() => onOpen(row.id)}
                  className={cn(
                    'group/row',
                    active
                      ? 'bg-accent'
                      : selected.has(row.id)
                        ? 'bg-muted'
                        : 'bg-background hover:bg-muted',
                  )}
                  style={{ height: ROW_HEIGHT }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn(
                        'truncate border-b px-2',
                        cell.column.id === 'select' && 'sticky left-0 z-10 bg-inherit',
                        cell.column.id === 'company' && 'sticky left-9 z-10 bg-inherit',
                        active &&
                          cell.column.id === 'select' &&
                          'shadow-[inset_2px_0_0_0_var(--foreground)]',
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {padBottom > 0 ? (
              <tr aria-hidden>
                <td colSpan={visibleCount} style={{ height: padBottom }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="text-muted-foreground flex justify-end border-t px-3 py-1.5 text-xs">
        {rows.length} account{rows.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}
