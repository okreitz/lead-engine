'use client';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AccountsTable } from '@/components/accounts-table';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { ViewBar } from '@/components/view-bar';
import { api, errorMessage, usd } from '@/lib/api';
import type { AccountRow } from '@/lib/crm';
import { useKeys } from '@/lib/keys';
import { useSheet } from '@/lib/sheet';
import { cn } from '@/lib/utils';
import { apiQuery, useViewState } from '@/lib/views';

interface Pipeline {
  stages: string[];
  columns: { stage: string; accounts: AccountRow[]; count: number; openDealsUsd: number }[];
  other: AccountRow[];
}

const CLOSED = new Set(['Won', 'Lost']);
const DAY = 86_400_000;

export default function PipelinePage() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <PipelineView />
    </Suspense>
  );
}

/**
 * Pipeline (docs/ui.md §3.4): one view, shown as a table or a board. Cards show priority,
 * next step and days in stage; columns show count and open deal value; Won and Lost
 * collapse. Dragging or `[` / `]` moves a card and writes a stage_change activity.
 */
function PipelineView() {
  const qc = useQueryClient();
  const router = useRouter();
  const sheet = useSheet();
  const { state, set, views } = useViewState();
  const query = apiQuery(state);
  const board = useQuery({
    queryKey: ['pipeline', query],
    queryFn: () => api<Pipeline>(`/pipeline?${query}`),
    placeholderData: (prev) => prev,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tableSel, setTableSel] = useState<Set<string>>(new Set());
  const [tableCursor, setTableCursor] = useState(-1);
  // Reference time for "days in stage", fixed per page load.
  const [now] = useState(() => Date.now());

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api(`/accounts/${id}/stage`, { method: 'PATCH', body: { stage } }),
    onMutate: async ({ id, stage }) => {
      await qc.cancelQueries({ queryKey: ['pipeline', query] });
      const prev = qc.getQueryData<Pipeline>(['pipeline', query]);
      if (prev) {
        const card = prev.columns.flatMap((c) => c.accounts).find((a) => a.id === id);
        if (card) {
          const moved = { ...card, stage, stageSince: now };
          qc.setQueryData<Pipeline>(['pipeline', query], {
            ...prev,
            columns: prev.columns.map((c) => {
              const accounts =
                c.stage === stage
                  ? [moved, ...c.accounts.filter((a) => a.id !== id)]
                  : c.accounts.filter((a) => a.id !== id);
              return {
                ...c,
                accounts,
                count: accounts.length,
                openDealsUsd: accounts.reduce((s, a) => s + (a.openDealsUsd ?? 0), 0),
              };
            }),
          });
        }
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['pipeline', query], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['pipeline'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['account'] });
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // A drop can remount the card under the pointer; the browser then follows the detached
  // link's href. Swallow clicks right after a drop.
  const lastDrop = useRef(0);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (Date.now() - lastDrop.current < 300) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const data = board.data;
  const stages = useMemo(() => data?.stages ?? [], [data]);
  const allCards = useMemo(() => data?.columns.flatMap((c) => c.accounts) ?? [], [data]);
  const tableRows = useMemo(
    () =>
      [...allCards].sort(
        (a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage) || b.priority - a.priority,
      ),
    [allCards, stages],
  );

  function shift(dir: -1 | 1) {
    const card = allCards.find((a) => a.id === selectedId);
    if (!card) return;
    const next = stages[stages.indexOf(card.stage) + dir];
    if (next) move.mutate({ id: card.id, stage: next });
  }

  useKeys(
    {
      '[': () => shift(-1),
      ']': () => shift(1),
      Enter: () => {
        if (selectedId) router.push(`/accounts/${selectedId}`);
      },
      ' ': () => {
        if (selectedId) sheet.open(selectedId);
      },
    },
    state.layout === 'board',
  );

  function onDragEnd(e: DragEndEvent) {
    lastDrop.current = Date.now();
    const stage = e.over?.id;
    const card = e.active.data.current as AccountRow | undefined;
    if (typeof stage === 'string' && card && card.stage !== stage)
      move.mutate({ id: card.id, stage });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Layout">
          {(['table', 'board'] as const).map((l) => (
            <button
              key={l}
              role="tab"
              type="button"
              aria-selected={state.layout === l}
              onClick={() => set({ layout: l })}
              className={cn(
                'rounded px-3 py-1 text-sm capitalize',
                state.layout === l ? 'bg-foreground text-background' : 'hover:bg-accent',
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <ViewBar
        state={state}
        set={set}
        views={views.data ?? []}
        entity="pipeline"
        showColumns={state.layout === 'table'}
      />
      {move.error ? <p className="text-destructive text-sm">{errorMessage(move.error)}</p> : null}

      {!data ? (
        <SkeletonRows rows={6} />
      ) : allCards.length === 0 ? (
        <EmptyState
          title="No accounts in this view"
          next="Add or import accounts"
          href="/accounts"
        />
      ) : state.layout === 'table' ? (
        <AccountsTable
          rows={tableRows}
          columns={state.cols}
          selected={tableSel}
          onToggle={(id) =>
            setTableSel((p) => {
              const n = new Set(p);
              if (n.has(id)) n.delete(id);
              else n.add(id);
              return n;
            })
          }
          onToggleAll={(all) => setTableSel(all ? new Set(tableRows.map((r) => r.id)) : new Set())}
          cursor={tableCursor}
          onCursor={setTableCursor}
          onPreview={(id) => sheet.open(id)}
          onOpen={(id) => router.push(`/accounts/${id}`)}
        />
      ) : (
        <>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="flex gap-3 overflow-x-auto pb-4">
              {data.columns.map((col) => {
                const collapsed = CLOSED.has(col.stage) && !expanded.has(col.stage);
                return (
                  <Column
                    key={col.stage}
                    stage={col.stage}
                    count={col.count}
                    valueUsd={col.openDealsUsd}
                    collapsed={collapsed}
                    onToggle={() =>
                      setExpanded((p) => {
                        const n = new Set(p);
                        if (n.has(col.stage)) n.delete(col.stage);
                        else n.add(col.stage);
                        return n;
                      })
                    }
                  >
                    {collapsed
                      ? null
                      : col.accounts.map((a) => (
                          <Card
                            now={now}
                            key={a.id}
                            account={a}
                            selected={selectedId === a.id}
                            onSelect={() => setSelectedId(a.id)}
                            onPreview={() => sheet.open(a.id)}
                          />
                        ))}
                  </Column>
                );
              })}
            </div>
          </DndContext>
          <p className="text-muted-foreground text-xs">
            Click a card to select it · <kbd>[</kbd>/<kbd>]</kbd> move one stage · <kbd>Space</kbd>{' '}
            preview · <kbd>Enter</kbd> open · drag to any stage
          </p>
        </>
      )}
    </div>
  );
}

function Column({
  stage,
  count,
  valueUsd,
  collapsed,
  onToggle,
  children,
}: {
  stage: string;
  count: number;
  valueUsd: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={stage}
      className={cn(
        'bg-muted/40 flex shrink-0 flex-col gap-2 rounded-xl border p-2 transition-[width]',
        collapsed ? 'w-14 items-center' : 'w-64',
        isOver && 'ring-ring/50 ring-2',
      )}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-col items-center gap-1 py-1 text-xs"
          aria-label={`Expand ${stage} (${count})`}
        >
          <span className="font-medium [writing-mode:vertical-rl]">{stage}</span>
          <span className="text-muted-foreground">{count}</span>
        </button>
      ) : (
        <header className="flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-sm font-medium">
            {stage} <span className="text-muted-foreground font-normal">({count})</span>
          </h2>
          <span className="text-muted-foreground text-xs">{valueUsd ? usd(valueUsd) : ''}</span>
          {CLOSED.has(stage) ? (
            <button
              type="button"
              onClick={onToggle}
              className="text-muted-foreground text-xs hover:underline"
            >
              collapse
            </button>
          ) : null}
        </header>
      )}
      {children}
    </section>
  );
}

function Card({
  account,
  now,
  selected,
  onSelect,
  onPreview,
}: {
  account: AccountRow;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: account.id,
    data: account,
  });
  const days = Math.max(0, Math.floor((now - account.stageSince) / DAY));
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onSelect}
      onDoubleClick={onPreview}
      aria-pressed={selected}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn(
        'bg-background cursor-grab rounded-lg border p-2 text-sm shadow-xs',
        selected && 'ring-foreground ring-2',
        isDragging && 'z-10 opacity-80 shadow-lg',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          className="min-w-0 truncate text-left font-medium hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
            onPreview();
          }}
        >
          {account.name}
        </button>
        <span className="font-semibold tabular-nums" title="Priority">
          {Math.round(account.priority)}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 truncate text-xs">
        next: {account.nextStep ?? '—'}
      </div>
      <div className="text-muted-foreground text-xs">
        {days}d in stage{account.openDealsUsd ? ` · ${usd(account.openDealsUsd)}` : ''}
      </div>
    </div>
  );
}
