'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover } from '@/components/ui/popover';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import {
  OPTIONAL_COLUMNS,
  PRESET_VIEWS,
  stateToSaved,
  viewToState,
  type SavedView,
  type ViewState,
} from '@/lib/views';

const STREAMS = [
  { key: 'personas', label: 'Persona fit' },
  { key: 'visits', label: 'Visits' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'manual', label: 'Manual' },
];
const SORTS = [
  { key: 'priority', label: 'Priority ↓' },
  { key: 'fit', label: 'Fit ↓' },
  { key: 'intent', label: 'Intent ↓' },
  { key: 'last', label: 'Last activity ↓' },
  { key: 'updated', label: 'Updated ↓' },
  { key: 'name', label: 'Name A–Z' },
];

/**
 * Saved-view tabs, filter chips (OR within a filter, AND between), sort and column toggle
 * (docs/ui.md §4 ViewBar).
 */
export function ViewBar({
  state,
  set,
  views,
  entity = 'accounts',
  showColumns = true,
}: {
  state: ViewState;
  set: (patch: Partial<ViewState>) => void;
  views: SavedView[];
  entity?: 'accounts' | 'pipeline';
  showColumns?: boolean;
}) {
  const qc = useQueryClient();
  const stages = useMe().data?.workspace?.settings.stages ?? [];
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = views.filter((v) => v.entity === 'accounts' || v.entity === entity);
  const activeSaved = saved.find((v) => v.id === state.view);

  async function saveAs(name: string) {
    try {
      const res = await api<{ id: string }>('/views', {
        method: 'POST',
        body: { name, entity: 'accounts', state: stateToSaved(state), pinned: false },
      });
      await qc.invalidateQueries({ queryKey: ['views'] });
      set({ view: res.id });
      setNaming(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const chip = (label: string, onClear: () => void, body: React.ReactNode) => (
    <Popover
      trigger={
        <button
          type="button"
          className="bg-muted hover:bg-accent inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
        >
          {label}
          <span
            role="button"
            tabIndex={0}
            aria-label={`Remove filter ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onClear();
            }}
            className="hover:text-foreground text-muted-foreground"
          >
            <X className="size-3" />
          </span>
        </button>
      }
    >
      {body}
    </Popover>
  );

  const checkList = (
    options: { key: string; label: string }[],
    selected: string[],
    onChange: (v: string[]) => void,
  ) => (
    <div className="flex flex-col gap-1">
      {options.map((o) => (
        <label key={o.key} className="hover:bg-accent flex items-center gap-2 rounded px-1 py-0.5">
          <input
            type="checkbox"
            checked={selected.includes(o.key)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, o.key] : selected.filter((x) => x !== o.key),
              )
            }
          />
          {o.label}
        </label>
      ))}
    </div>
  );
  const numberInput = (value: string, onChange: (v: string) => void, label: string) => (
    <label className="flex items-center gap-2">
      {label} ≥
      <Input
        type="number"
        min={0}
        max={100}
        className="h-8 w-20"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
    </label>
  );
  const stageOptions = stages.map((s) => ({ key: s, label: s }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 border-b" role="tablist" aria-label="Views">
        {PRESET_VIEWS.map((v) => (
          <button
            key={v.key}
            role="tab"
            type="button"
            aria-selected={state.view === v.key}
            onClick={() => set({ ...viewToState(v.key, v.state), layout: state.layout })}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm',
              state.view === v.key
                ? 'border-foreground font-medium'
                : 'text-muted-foreground border-transparent hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
        {saved.map((v) => (
          <span
            key={v.id}
            className={cn(
              '-mb-px flex items-center border-b-2',
              state.view === v.id ? 'border-foreground' : 'border-transparent',
            )}
          >
            <button
              role="tab"
              type="button"
              aria-selected={state.view === v.id}
              onClick={() => set({ ...viewToState(v.id, v.state), layout: state.layout })}
              className={cn(
                'px-3 py-1.5 text-sm',
                state.view === v.id ? 'font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.name}
            </button>
          </span>
        ))}
        {naming ? (
          <form
            className="flex items-center gap-1 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveAs(String(new FormData(e.currentTarget).get('name')));
            }}
          >
            <Input
              name="name"
              placeholder="View name"
              className="h-7 w-40"
              autoFocus
              required
              maxLength={60}
            />
            <Button size="xs" type="submit">
              Save
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setNaming(true)}
            title="Save the current filters as a view"
          >
            <Plus /> view
          </Button>
        )}
        {activeSaved ? (
          <span className="ml-auto flex items-center gap-1 pb-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                await api(`/views/${activeSaved.id}`, {
                  method: 'PATCH',
                  body: { state: stateToSaved(state) },
                });
                await qc.invalidateQueries({ queryKey: ['views'] });
              }}
            >
              Update view
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label={activeSaved.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
              onClick={async () => {
                await api(`/views/${activeSaved.id}`, {
                  method: 'PATCH',
                  body: { pinned: !activeSaved.pinned },
                });
                await qc.invalidateQueries({ queryKey: ['views'] });
              }}
            >
              {activeSaved.pinned ? <PinOff /> : <Pin />}
              {activeSaved.pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                await api(`/views/${activeSaved.id}`, { method: 'DELETE' });
                await qc.invalidateQueries({ queryKey: ['views'] });
                set({ view: 'all' });
              }}
            >
              Delete view
            </Button>
          </span>
        ) : null}
      </div>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name or domain"
          className="h-8 w-56"
          value={state.q}
          onChange={(e) => set({ q: e.target.value })}
          aria-label="Search accounts"
        />
        <span className="text-muted-foreground text-xs">Filters:</span>
        {state.stage.length
          ? chip(
              `Stage: ${state.stage.join(', ')}`,
              () => set({ stage: [] }),
              checkList(stageOptions, state.stage, (v) => set({ stage: v })),
            )
          : null}
        {state.stream.length
          ? chip(
              `Stream: ${state.stream.map((s) => STREAMS.find((x) => x.key === s)?.label ?? s).join(', ')}`,
              () => set({ stream: [] }),
              checkList(STREAMS, state.stream, (v) => set({ stream: v })),
            )
          : null}
        {state.fit
          ? chip(
              `Fit ≥ ${state.fit}`,
              () => set({ fit: '' }),
              numberInput(state.fit, (v) => set({ fit: v }), 'Fit'),
            )
          : null}
        {state.intent
          ? chip(
              `Intent ≥ ${state.intent}`,
              () => set({ intent: '' }),
              numberInput(state.intent, (v) => set({ intent: v }), 'Intent'),
            )
          : null}
        <Popover
          trigger={
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent rounded-full border border-dashed px-2.5 py-1 text-xs"
            >
              + filter
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-medium">Stage (any of)</div>
              {checkList(stageOptions, state.stage, (v) => set({ stage: v }))}
            </div>
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-medium">Stream (any of)</div>
              {checkList(STREAMS, state.stream, (v) => set({ stream: v }))}
            </div>
            {numberInput(state.fit, (v) => set({ fit: v }), 'Fit')}
            {numberInput(state.intent, (v) => set({ intent: v }), 'Intent')}
          </div>
        </Popover>
        <span className="ml-auto flex items-center gap-2">
          <label className="text-muted-foreground flex items-center gap-1 text-xs">
            Sort
            <select
              className="border-input h-8 rounded-md border bg-transparent px-2 text-sm text-foreground"
              value={state.sort}
              onChange={(e) => set({ sort: e.target.value })}
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {showColumns ? (
            <Popover
              align="end"
              trigger={
                <Button size="sm" variant="outline">
                  Columns ▾
                </Button>
              }
            >
              {checkList(OPTIONAL_COLUMNS, state.cols, (v) =>
                set({ cols: OPTIONAL_COLUMNS.map((c) => c.key).filter((k) => v.includes(k)) }),
              )}
            </Popover>
          ) : null}
        </span>
      </div>
    </div>
  );
}
