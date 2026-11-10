'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { api } from './api';

/** URL-held view state for accounts and pipeline (docs/ui.md §3.2: view state lives in the URL). */
export interface ViewState {
  view: string;
  q: string;
  stage: string[];
  stream: string[];
  fit: string;
  intent: string;
  sort: string;
  cols: string[];
  layout: 'table' | 'board';
}

export interface SavedView {
  id: string;
  name: string;
  entity: 'accounts' | 'pipeline';
  pinned: boolean;
  userId: string | null;
  state: {
    filters?: Record<string, string[]>;
    sort?: string;
    columns?: string[];
    layout?: 'table' | 'board';
  };
}

export const DEFAULT_COLUMNS = ['priority', 'stage', 'stream', 'last', 'next'];
export const OPTIONAL_COLUMNS: { key: string; label: string }[] = [
  { key: 'priority', label: 'Priority' },
  { key: 'stage', label: 'Stage' },
  { key: 'stream', label: 'Stream' },
  { key: 'last', label: 'Last' },
  { key: 'next', label: 'Next step' },
  { key: 'industry', label: 'Industry' },
  { key: 'state', label: 'State' },
  { key: 'size', label: 'Size' },
];

/** Stream presets shipped as default views (docs/ui.md §3.2, Leadfeeder default feeds). */
export const PRESET_VIEWS: { key: string; label: string; state: SavedView['state'] }[] = [
  { key: 'all', label: 'All', state: { sort: 'priority' } },
  { key: 'hot', label: 'Hot', state: { filters: { intent: ['30'] }, sort: 'priority' } },
  { key: 'visitors', label: 'Visitors', state: { filters: { stream: ['visits'] }, sort: 'last' } },
  {
    key: 'conversations',
    label: 'Conversations',
    state: { filters: { stream: ['conversations'] }, sort: 'last' },
  },
  {
    key: 'personas',
    label: 'Persona fit',
    state: { filters: { stream: ['personas'] }, sort: 'priority' },
  },
];

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

export function stateToParams(s: Partial<ViewState>): URLSearchParams {
  const p = new URLSearchParams();
  if (s.view && s.view !== 'all') p.set('view', s.view);
  if (s.q) p.set('q', s.q);
  if (s.stage?.length) p.set('stage', s.stage.join(','));
  if (s.stream?.length) p.set('stream', s.stream.join(','));
  if (s.fit) p.set('fit', s.fit);
  if (s.intent) p.set('intent', s.intent);
  if (s.sort && s.sort !== 'priority') p.set('sort', s.sort);
  if (s.cols?.length && s.cols.join(',') !== DEFAULT_COLUMNS.join(','))
    p.set('cols', s.cols.join(','));
  if (s.layout && s.layout !== 'table') p.set('layout', s.layout);
  return p;
}

/** A saved/preset view's stored state, as URL view state. */
export function viewToState(key: string, state: SavedView['state']): Partial<ViewState> {
  const f = state.filters ?? {};
  return {
    view: key,
    stage: f.stage ?? [],
    stream: f.stream ?? [],
    fit: f.fit?.[0] ?? '',
    intent: f.intent?.[0] ?? '',
    q: f.q?.[0] ?? '',
    sort: state.sort ?? 'priority',
    cols: state.columns ?? DEFAULT_COLUMNS,
    ...(state.layout ? { layout: state.layout } : {}),
  };
}

export function stateToSaved(s: ViewState): SavedView['state'] {
  const filters: Record<string, string[]> = {};
  if (s.stage.length) filters.stage = s.stage;
  if (s.stream.length) filters.stream = s.stream;
  if (s.fit) filters.fit = [s.fit];
  if (s.intent) filters.intent = [s.intent];
  if (s.q) filters.q = [s.q];
  return { filters, sort: s.sort, columns: s.cols, layout: s.layout };
}

export function useSavedViews() {
  return useQuery({ queryKey: ['views'], queryFn: () => api<SavedView[]>('/views') });
}

export function useViewState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const views = useSavedViews();
  const state = useMemo<ViewState>(() => {
    const viewKey = params.get('view') ?? 'all';
    // A bare `?view=hot` (e.g. from the sidebar) expands to that view's stored state.
    const onlyView = [...params.keys()].every((k) => k === 'view' || k === 'sheet');
    if (onlyView && viewKey !== 'all') {
      const preset = PRESET_VIEWS.find((v) => v.key === viewKey);
      const saved = views.data?.find((v) => v.id === viewKey);
      const st = preset?.state ?? saved?.state;
      if (st) return { ...emptyState(), ...viewToState(viewKey, st) } as ViewState;
    }
    return {
      view: viewKey,
      q: params.get('q') ?? '',
      stage: list(params.get('stage')),
      stream: list(params.get('stream')),
      fit: params.get('fit') ?? '',
      intent: params.get('intent') ?? '',
      sort: params.get('sort') ?? 'priority',
      cols: params.get('cols') ? list(params.get('cols')) : DEFAULT_COLUMNS,
      layout: params.get('layout') === 'board' ? 'board' : 'table',
    };
  }, [params, views.data]);

  const set = useCallback(
    (patch: Partial<ViewState>) => {
      const next = stateToParams({ ...state, ...patch });
      const sheet = params.get('sheet');
      if (sheet) next.set('sheet', sheet);
      const qs = next.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [state, params, pathname, router],
  );
  return { state, set, views };
}

export function emptyState(): ViewState {
  return {
    view: 'all',
    q: '',
    stage: [],
    stream: [],
    fit: '',
    intent: '',
    sort: 'priority',
    cols: DEFAULT_COLUMNS,
    layout: 'table',
  };
}

/** API query string for the account list. */
export function apiQuery(s: ViewState): string {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.stage.length) p.set('stage', s.stage.join(','));
  if (s.stream.length) p.set('stream', s.stream.join(','));
  if (s.fit) p.set('minFit', s.fit);
  if (s.intent) p.set('minIntent', s.intent);
  if (s.sort) p.set('sort', s.sort);
  return p.toString();
}
