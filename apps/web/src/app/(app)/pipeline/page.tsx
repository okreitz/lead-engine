'use client';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { api, errorMessage } from '@/lib/api';
import { score, type AccountRow } from '@/lib/crm';
import { cn } from '@/lib/utils';

interface Pipeline {
  stages: string[];
  columns: { stage: string; accounts: AccountRow[] }[];
  other: AccountRow[];
}

/** Drag accounts between stages; each move is logged as a stage_change activity (SPEC §6). */
export default function PipelinePage() {
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['pipeline'], queryFn: () => api<Pipeline>('/pipeline') });
  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api(`/accounts/${id}/stage`, { method: 'PATCH', body: { stage } }),
    onMutate: async ({ id, stage }) => {
      await qc.cancelQueries({ queryKey: ['pipeline'] });
      const prev = qc.getQueryData<Pipeline>(['pipeline']);
      if (prev) {
        const card = prev.columns.flatMap((c) => c.accounts).find((a) => a.id === id);
        if (card) {
          qc.setQueryData<Pipeline>(['pipeline'], {
            ...prev,
            columns: prev.columns.map((c) => ({
              ...c,
              accounts:
                c.stage === stage
                  ? [{ ...card, stage }, ...c.accounts.filter((a) => a.id !== id)]
                  : c.accounts.filter((a) => a.id !== id),
            })),
          });
        }
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(['pipeline'], context.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['pipeline'] }),
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // A drop moves the card to another column, which remounts it; the browser then delivers
  // the pointer's click to the detached <a> and follows its href natively. Swallow clicks
  // that arrive right after a drop.
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

  function onDragEnd(e: DragEndEvent) {
    lastDrop.current = Date.now();
    const stage = e.over?.id;
    const card = e.active.data.current as AccountRow | undefined;
    if (typeof stage === 'string' && card && card.stage !== stage) {
      move.mutate({ id: card.id, stage });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
      {move.error ? <p className="text-destructive text-sm">{errorMessage(move.error)}</p> : null}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {board.data?.columns.map((col) => (
            <Column key={col.stage} stage={col.stage} accounts={col.accounts} />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

function Column({ stage, accounts }: { stage: string; accounts: AccountRow[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={stage}
      className={cn(
        'bg-muted/40 flex w-60 shrink-0 flex-col gap-2 rounded-xl border p-2',
        isOver && 'ring-ring/50 ring-2',
      )}
    >
      <h2 className="flex items-center justify-between px-1 text-sm font-medium">
        {stage}
        <span className="text-muted-foreground text-xs">{accounts.length}</span>
      </h2>
      {accounts.map((a) => (
        <Card key={a.id} account={a} />
      ))}
    </section>
  );
}

function Card({ account }: { account: AccountRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: account.id,
    data: account,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn(
        'bg-background cursor-grab rounded-lg border p-2 text-sm shadow-xs',
        isDragging && 'z-10 opacity-80 shadow-lg',
      )}
    >
      {/* Native link dragging would hijack the pointer; dnd-kit handles the drag. */}
      <Link
        href={`/accounts/${account.id}`}
        draggable={false}
        className="font-medium hover:underline"
      >
        {account.name}
      </Link>
      <div className="text-muted-foreground text-xs">{account.domain}</div>
      <div className="text-muted-foreground mt-1 flex gap-3 text-xs">
        <span>P {score(account.priority)}</span>
        <span>Fit {score(account.fitScore)}</span>
        <span>Int {score(account.intentScore)}</span>
      </div>
    </div>
  );
}
