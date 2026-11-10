'use client';
import type { OfferProfile, ReviewDecision, ReviewField } from '@le/shared';
import { INTENT_KINDS, REVIEW_FIELDS } from '@le/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Info, Pencil, X } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { CostAction } from '@/components/blocks/cost-action';
import { SkeletonRows } from '@/components/blocks/empty-state';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { api, ApiError, errorMessage, fmtDate } from '@/lib/api';
import { diffVersions, emptyOf, FIELD_LABEL, getField, setField, type Review } from '@/lib/offer';
import { cn } from '@/lib/utils';

interface Version {
  id: string;
  version: number;
  status: 'drafting' | 'draft' | 'approved' | 'superseded' | 'failed';
  source: 'llm' | 'human';
  data: OfferProfile | null;
  pages: { url: string; title?: string }[] | null;
  error: string | null;
  rationale: Partial<Record<ReviewField, string>> | null;
  review: Review | null;
  createdAt: number;
  approvedAt: number | null;
  job: { state: string | null; waitReason: string | null; lastError: string | null } | null;
}

interface Detail {
  offer: { id: string; name: string; websiteUrl: string };
  versions: Version[];
}

const STATUS_TONE = {
  drafting: 'warn',
  draft: 'default',
  approved: 'ok',
  superseded: 'muted',
  failed: 'danger',
} as const;

const shortDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

export default function OfferDetailPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <OfferDetail />
    </Suspense>
  );
}

/**
 * Offer profile (docs/ui.md §3.7): each LLM-drafted field is accepted, edited or rejected
 * with the model's "why" beside it; a live preview shows how many companies match; approval
 * creates a version, and Compare shows a field-level diff. `?v=` picks the version and
 * `?compare=` the version to diff against.
 */
function OfferDetail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['offer', id],
    queryFn: () => api<Detail>(`/offers/${id}`),
    // Poll while a draft is being written.
    refetchInterval: (query) =>
      query.state.data?.versions.some((v) => v.status === 'drafting') ? 3000 : false,
  });
  const versions = q.data?.versions ?? [];
  const selected = Number(params.get('v')) || null;
  const compare = Number(params.get('compare')) || null;
  const current =
    versions.find((v) => v.version === selected) ?? versions[versions.length - 1] ?? null;
  const approved = [...versions].reverse().find((v) => v.status === 'approved') ?? null;

  const go = (patch: { v?: number | null; compare?: number | null }) => {
    const next = new URLSearchParams(params);
    for (const [k, val] of Object.entries(patch)) {
      if (val) next.set(k, String(val));
      else next.delete(k);
    }
    router.replace(`/offer/${id}?${next}`, { scroll: false });
  };

  if (!q.data) return <SkeletonRows rows={6} />;
  const refresh = () => qc.invalidateQueries({ queryKey: ['offer', id] });
  const compareTarget =
    current && compare ? (versions.find((v) => v.version === compare) ?? null) : null;
  const defaultCompare =
    current && approved && approved.version !== current.version
      ? approved.version
      : (versions.filter((v) => v.data && v.version < (current?.version ?? 0)).at(-1)?.version ??
        null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Offer profile{' '}
            <span className="text-muted-foreground text-base font-normal">
              {approved
                ? `v${approved.version} (approved ${shortDate(approved.approvedAt)})`
                : 'no approved version yet'}
            </span>
          </h1>
          <p className="text-muted-foreground text-sm">
            {q.data.offer.name || q.data.offer.websiteUrl} · {q.data.offer.websiteUrl}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {current?.data && defaultCompare ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => go({ compare: compareTarget ? null : defaultCompare })}
            >
              {compareTarget ? 'Close compare' : `Compare with v${defaultCompare}`}
            </Button>
          ) : null}
          <CostAction
            estimatePath="/offers/draft-estimate"
            label="Draft new version"
            what={`Re-read ${q.data.offer.websiteUrl} and draft a new version with the LLM`}
            variant="outline"
            size="sm"
            onRun={async () => {
              const res = await api<{ version: number }>(`/offers/${id}/redraft`, {
                method: 'POST',
                body: {},
              });
              go({ v: res.version, compare: null });
              await refresh();
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Versions">
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={current?.id === v.id}
            onClick={() => go({ v: v.version, compare: null })}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm',
              current?.id === v.id && 'bg-accent',
            )}
          >
            v{v.version} <Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge>
          </button>
        ))}
        {compareTarget && current ? (
          <span className="text-muted-foreground ml-2 flex items-center gap-1 text-sm">
            comparing v{current.version} with
            <NativeSelect
              aria-label="Compare with version"
              value={compareTarget.version}
              onChange={(e) => go({ compare: Number(e.target.value) })}
              className="h-7 w-auto py-0"
            >
              {versions
                .filter((v) => v.data && v.version !== current.version)
                .map((v) => (
                  <option key={v.id} value={v.version}>
                    v{v.version} ({v.status})
                  </option>
                ))}
            </NativeSelect>
          </span>
        ) : null}
      </div>

      {current && compareTarget ? <VersionDiff from={compareTarget} to={current} /> : null}
      {current ? (
        // Stays mounted while comparing, so unsaved edits and review decisions survive.
        <div hidden={Boolean(compareTarget)}>
          <VersionView
            key={current.id}
            offerId={id}
            v={current}
            baseline={approved && approved.id !== current.id ? approved.data : null}
            onSaved={(n) => {
              go({ v: n });
              void refresh();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function VersionView({
  offerId,
  v,
  baseline,
  onSaved,
}: {
  offerId: string;
  v: Version;
  baseline: OfferProfile | null;
  onSaved: (version: number) => void;
}) {
  if (v.status === 'drafting') {
    return (
      <Card>
        <CardTitle>Drafting…</CardTitle>
        <p className="text-sm">Reading the website and asking the model for a draft.</p>
        {v.job?.state === 'waiting' ? (
          <p className="mt-2 text-sm text-amber-800">Waiting: {v.job.waitReason}</p>
        ) : null}
        {v.job?.lastError ? (
          <p className="text-muted-foreground mt-2 text-xs">Last error: {v.job.lastError}</p>
        ) : null}
      </Card>
    );
  }
  if (v.status === 'failed' && !v.data) {
    return (
      <Card>
        <CardTitle>Draft failed</CardTitle>
        <p className="text-destructive text-sm">{v.error}</p>
      </Card>
    );
  }
  return <Editor offerId={offerId} v={v} baseline={baseline} onSaved={onSaved} />;
}

const lines = (a: string[]) => a.join('\n');
const fromLines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
const commas = (a: string[]) => a.join(', ');
const fromCommas = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function Editor({
  offerId,
  v,
  baseline,
  onSaved,
}: {
  offerId: string;
  v: Version;
  baseline: OfferProfile | null;
  onSaved: (version: number) => void;
}) {
  const [data, setData] = useState<OfferProfile>(v.data!);
  const [review, setReview] = useState<Review>(v.review ?? {});
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const underReview = v.review !== null && v.status === 'draft';
  const locked = v.status === 'approved' || v.status === 'superseded';
  const pending = underReview ? REVIEW_FIELDS.filter((f) => !review[f]) : [];

  /** Any edit to an LLM-drafted field marks it "edited". */
  const change = (f: ReviewField, value: unknown) => {
    setData((d) => setField(d, f, value));
    if (underReview) setReview((r) => ({ ...r, [f]: 'edited' }));
  };
  const decide = (f: ReviewField, decision: ReviewDecision) => {
    setReview((r) => ({ ...r, [f]: decision }));
    if (decision === 'rejected')
      setData((d) => setField(d, f, baseline ? getField(baseline, f) : emptyOf(f)));
  };

  async function save(): Promise<number | null> {
    try {
      const res = await api<{ version: number; created: boolean }>(
        `/offers/${offerId}/versions/${v.version}`,
        { method: 'PUT', body: { data, ...(underReview ? { review } : {}) } },
      );
      setMsg({ tone: 'ok', text: res.created ? `Saved as new draft v${res.version}` : 'Saved' });
      onSaved(res.version);
      return res.version;
    } catch (err) {
      setMsg({ tone: 'err', text: describe(err) });
      return null;
    }
  }

  const field = (f: ReviewField, children: ReactNode, className?: string) => (
    <ReviewRow
      field={f}
      why={v.rationale?.[f]}
      decision={underReview ? (review[f] ?? null) : undefined}
      onDecide={(d) => decide(f, d)}
      className={className}
    >
      {children}
    </ReviewRow>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void save()}
            variant={v.status === 'draft' ? 'outline' : 'default'}
          >
            {locked ? 'Save changes as a new version' : 'Save draft'}
          </Button>
          {v.status === 'draft' ? (
            <Button
              disabled={pending.length > 0}
              onClick={async () => {
                const n = await save();
                if (n === null) return;
                try {
                  const res = await api<{ rescored: number }>(
                    `/offers/${offerId}/versions/${n}/approve`,
                    { method: 'POST' },
                  );
                  setMsg({ tone: 'ok', text: `Approved v${n}; ${res.rescored} accounts rescored` });
                  onSaved(n);
                } catch (err) {
                  setMsg({ tone: 'err', text: describe(err) });
                }
              }}
            >
              Approve as v{v.version}
            </Button>
          ) : null}
          {pending.length ? (
            <span className="text-sm font-medium text-amber-800">
              {pending.length} of {REVIEW_FIELDS.length} drafted fields still need a decision
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {v.source === 'llm' ? 'LLM draft' : 'edited by a person'} · created{' '}
            {fmtDate(v.createdAt)}
            {v.approvedAt ? ` · approved ${fmtDate(v.approvedAt)}` : ''}
          </span>
          {msg ? (
            <span
              role="status"
              className={
                msg.tone === 'ok' ? 'text-sm text-emerald-700' : 'text-destructive text-sm'
              }
            >
              {msg.text}
            </span>
          ) : null}
        </div>
        {underReview ? (
          <p className="text-muted-foreground text-xs">
            The model drafted this version. Accept ✓, edit ✎ or reject ✗ each field; editing a field
            marks it edited, and rejecting it reverts it to{' '}
            {baseline ? 'the approved version' : 'empty'}. Nothing is applied until you approve.
          </p>
        ) : null}
        {v.pages?.length ? (
          <p className="text-muted-foreground text-xs">
            Drafted from:{' '}
            {v.pages.map((p, i) => (
              <span key={p.url}>
                {i ? ', ' : ''}
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="underline"
                >
                  {p.title || p.url}
                </a>
              </span>
            ))}
          </p>
        ) : null}

        <Card>
          <CardTitle>Offer</CardTitle>
          <div className="flex flex-col gap-1">
            {field(
              'name',
              <Input
                aria-label="Name"
                value={data.name}
                onChange={(e) => change('name', e.target.value)}
              />,
            )}
            {field(
              'summary',
              <Textarea
                aria-label="Summary"
                rows={3}
                value={data.summary}
                onChange={(e) => change('summary', e.target.value)}
              />,
            )}
            {field(
              'valueProps',
              <Textarea
                aria-label="Value propositions (one per line)"
                rows={4}
                value={lines(data.valueProps)}
                onChange={(e) => change('valueProps', fromLines(e.target.value))}
              />,
            )}
            {field(
              'competitors',
              <ListInput
                label="Competitors"
                value={data.competitors}
                onChange={(x) => change('competitors', x)}
              />,
            )}
          </div>
        </Card>

        <Card>
          <CardTitle>Ideal customer profile (US)</CardTitle>
          <div className="flex flex-col gap-1">
            {field(
              'icp.industries',
              <ListInput
                label="Industries"
                value={data.icp.industries}
                onChange={(x) => change('icp.industries', x)}
              />,
            )}
            {field(
              'icp.naics',
              <ListInput
                label="NAICS codes"
                value={data.icp.naics}
                onChange={(x) => change('icp.naics', x)}
              />,
            )}
            {field(
              'icp.employeeRange',
              <Input
                aria-label="Employee range"
                value={data.icp.employeeRange}
                onChange={(e) => change('icp.employeeRange', e.target.value)}
              />,
            )}
            {field(
              'icp.revenueRange',
              <Input
                aria-label="Revenue range"
                value={data.icp.revenueRange ?? ''}
                onChange={(e) => change('icp.revenueRange', e.target.value || null)}
              />,
            )}
            {field(
              'icp.states',
              <ListInput
                label="States (two-letter, empty = all)"
                value={data.icp.states}
                onChange={(x) =>
                  change(
                    'icp.states',
                    x.map((s) => s.toUpperCase()),
                  )
                }
              />,
            )}
            {field(
              'icp.techUses',
              <ListInput
                label="Uses technology"
                value={data.icp.techUses}
                onChange={(x) => change('icp.techUses', x)}
              />,
            )}
            {field(
              'icp.techAvoids',
              <ListInput
                label="Avoids technology"
                value={data.icp.techAvoids}
                onChange={(x) => change('icp.techAvoids', x)}
              />,
            )}
            {field(
              'icp.mustHave',
              <ListInput
                label="Must have"
                value={data.icp.mustHave}
                onChange={(x) => change('icp.mustHave', x)}
              />,
            )}
            {field(
              'icp.exclude',
              <ListInput
                label="Exclude"
                value={data.icp.exclude}
                onChange={(x) => change('icp.exclude', x)}
              />,
            )}
          </div>
        </Card>

        <Card>
          {field(
            'personas',
            <div className="flex flex-col gap-3">
              {data.personas.map((p, i) => {
                const update = (patch: Partial<typeof p>) =>
                  change(
                    'personas',
                    data.personas.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  );
                return (
                  <div key={i} className="grid grid-cols-3 gap-2 border-t pt-3 first:border-t-0">
                    <Label>
                      Title
                      <Input value={p.title} onChange={(e) => update({ title: e.target.value })} />
                    </Label>
                    <Label>
                      Seniority
                      <Input
                        value={p.seniority}
                        onChange={(e) => update({ seniority: e.target.value })}
                      />
                    </Label>
                    <Label>
                      Department
                      <Input
                        value={p.department}
                        onChange={(e) => update({ department: e.target.value })}
                      />
                    </Label>
                    <Label className="col-span-2">
                      Pains
                      <ListInput
                        label="Pains"
                        value={p.pains}
                        onChange={(x) => update({ pains: x })}
                      />
                    </Label>
                    <Label>
                      Title keywords
                      <ListInput
                        label="Title keywords"
                        value={p.titleKeywords}
                        onChange={(x) => update({ titleKeywords: x })}
                      />
                    </Label>
                    <div className="col-span-3">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          change(
                            'personas',
                            data.personas.filter((_, j) => j !== i),
                          )
                        }
                      >
                        Remove persona
                      </Button>
                    </div>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() =>
                  change('personas', [
                    ...data.personas,
                    { title: '', seniority: '', department: '', pains: [], titleKeywords: [] },
                  ])
                }
              >
                Add persona
              </Button>
            </div>,
          )}
        </Card>

        <Card>
          {field(
            'intentPhrases',
            <div className="flex flex-col gap-2">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="font-medium">Phrase ({data.intentPhrases.length})</th>
                    <th className="font-medium">Kind</th>
                    <th className="font-medium">Negative keywords</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.intentPhrases.map((p, i) => {
                    const update = (patch: Partial<typeof p>) =>
                      change(
                        'intentPhrases',
                        data.intentPhrases.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                      );
                    return (
                      <tr key={i}>
                        <td className="py-1 pr-2">
                          <Input
                            value={p.phrase}
                            onChange={(e) => update({ phrase: e.target.value })}
                            aria-label="Phrase"
                          />
                        </td>
                        <td className="pr-2">
                          <NativeSelect
                            value={p.kind}
                            onChange={(e) => update({ kind: e.target.value as typeof p.kind })}
                            aria-label="Kind"
                          >
                            {INTENT_KINDS.map((k) => (
                              <option key={k}>{k}</option>
                            ))}
                          </NativeSelect>
                        </td>
                        <td className="pr-2">
                          <ListInput
                            label="Negative keywords"
                            value={p.negative}
                            onChange={(x) => update({ negative: x })}
                          />
                        </td>
                        <td>
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Remove phrase"
                            onClick={() =>
                              change(
                                'intentPhrases',
                                data.intentPhrases.filter((_, j) => j !== i),
                              )
                            }
                          >
                            ✕
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() =>
                  change('intentPhrases', [
                    ...data.intentPhrases,
                    { phrase: '', kind: 'seeking', negative: [] },
                  ])
                }
              >
                Add phrase
              </Button>
            </div>,
          )}
        </Card>
      </div>
      <aside aria-label="Match preview" className="lg:sticky lg:top-4 lg:self-start">
        <MatchPreview icp={data.icp} />
      </aside>
    </div>
  );
}

const DECISION_TEXT: Record<ReviewDecision, string> = {
  accepted: 'Accepted',
  edited: 'Edited',
  rejected: 'Rejected',
};

/**
 * One reviewable field: label, the model's "why", and accept / edit / reject. `decision`
 * undefined means the version isn't under review (human edit or approved), null means pending.
 */
function ReviewRow({
  field,
  why,
  decision,
  onDecide,
  className,
  children,
}: {
  field: ReviewField;
  why: string | undefined;
  decision: ReviewDecision | null | undefined;
  onDecide: (d: ReviewDecision) => void;
  className?: string | undefined;
  children: ReactNode;
}) {
  const id = `field-${field.replace('.', '-')}`;
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md py-1.5',
        decision === null && 'border-l-2 border-amber-500 pl-2',
        className,
      )}
      data-field={field}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={id} className="font-medium">
          {FIELD_LABEL[field]}
        </label>
        {why ? (
          <Tooltip content={why}>
            <button
              type="button"
              className="text-muted-foreground inline-flex items-center gap-0.5 text-xs hover:underline"
            >
              <Info className="size-3" aria-hidden /> why
            </button>
          </Tooltip>
        ) : null}
        {decision !== undefined ? (
          <span className="ml-auto flex items-center gap-1">
            <span
              className={cn(
                'text-xs',
                decision === null ? 'font-medium text-amber-800' : 'text-muted-foreground',
              )}
            >
              {decision ? DECISION_TEXT[decision] : 'Needs review'}
            </span>
            <DecisionButton
              active={decision === 'accepted'}
              label={`Accept ${FIELD_LABEL[field]}`}
              onClick={() => onDecide('accepted')}
            >
              <Check />
            </DecisionButton>
            <DecisionButton
              active={decision === 'edited'}
              label={`Edit ${FIELD_LABEL[field]}`}
              onClick={() => {
                onDecide('edited');
                document
                  .getElementById(id)
                  ?.querySelector<HTMLElement>('input,textarea,select')
                  ?.focus();
              }}
            >
              <Pencil />
            </DecisionButton>
            <DecisionButton
              active={decision === 'rejected'}
              label={`Reject ${FIELD_LABEL[field]}`}
              onClick={() => onDecide('rejected')}
            >
              <X />
            </DecisionButton>
          </span>
        ) : null}
      </div>
      <div id={id}>{children}</div>
    </div>
  );
}

function DecisionButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <Button
        size="icon-xs"
        variant={active ? 'default' : 'outline'}
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

interface Preview {
  scanned: number;
  matches: number;
  threshold: number;
  byState: { state: string; count: number }[];
  sample: string[];
}

/** Live match count for the ICP being edited (debounced; rule-based, no paid calls). */
function MatchPreview({ icp }: { icp: OfferProfile['icp'] }) {
  const key = JSON.stringify({
    industries: icp.industries,
    naics: icp.naics,
    employeeRange: icp.employeeRange,
    states: icp.states,
    techUses: icp.techUses,
    techAvoids: icp.techAvoids,
    exclude: icp.exclude,
  });
  const [debounced, setDebounced] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(key), 400);
    return () => clearTimeout(t);
  }, [key]);
  const q = useQuery({
    queryKey: ['offer-preview', debounced],
    queryFn: () =>
      api<Preview>('/offers/preview', { method: 'POST', body: { icp: JSON.parse(debounced) } }),
    placeholderData: (prev) => prev,
  });
  const p = q.data;
  return (
    <Card>
      <CardTitle>Preview</CardTitle>
      {!p ? (
        <p className="text-muted-foreground text-sm">Counting…</p>
      ) : (
        <div className={cn('flex flex-col gap-2 text-sm', q.isFetching && 'opacity-60')}>
          <p>
            <span className="text-2xl font-semibold tabular-nums">{p.matches}</span> of {p.scanned}{' '}
            {p.scanned === 1 ? 'company' : 'companies'} match
          </p>
          <p className="text-muted-foreground text-xs">
            Fit ≥ {p.threshold} on industry, size, state and technology, across your accounts.
            Updates as you edit; no paid calls.
          </p>
          {p.byState.length ? (
            <ul className="text-xs">
              {p.byState.map((s) => (
                <li key={s.state}>
                  · {s.count} {s.state}
                </li>
              ))}
            </ul>
          ) : null}
          {p.sample.length ? (
            <p className="text-xs">
              <span className="text-muted-foreground">Sample:</span> {p.sample.join(', ')}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** Field-level diff (docs/ui.md §4 VersionDiff). Text markers, not only colour. */
function VersionDiff({ from, to }: { from: Version; to: Version }) {
  const diffs = diffVersions(from.data, to.data);
  const changed = diffs.filter((d) => d.added.length || d.removed.length);
  const same = diffs.length - changed.length;
  return (
    <Card>
      <CardTitle>
        v{from.version} → v{to.version}: {changed.length} field{changed.length === 1 ? '' : 's'}{' '}
        changed{same ? `, ${same} unchanged` : ''}
      </CardTitle>
      <p className="text-muted-foreground mb-2 text-xs">
        Compares saved versions; unsaved edits stay in the editor.
      </p>
      {changed.length === 0 ? (
        <p className="text-muted-foreground text-sm">The two versions are identical.</p>
      ) : (
        <dl className="flex flex-col divide-y text-sm">
          {changed.map((d) => (
            <div key={d.field} className="grid gap-2 py-2 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium">
                {FIELD_LABEL[d.field]}
                {to.review?.[d.field] ? (
                  <span className="text-muted-foreground block text-xs font-normal">
                    {DECISION_TEXT[to.review[d.field]!]} in v{to.version}
                  </span>
                ) : null}
              </dt>
              <dd className="flex flex-col gap-0.5">
                {d.removed.map((x) => (
                  <span key={`-${x}`} className="text-red-800">
                    <span aria-hidden>− </span>
                    <span className="sr-only">removed: </span>
                    <del>{x}</del>
                  </span>
                ))}
                {d.added.map((x) => (
                  <span key={`+${x}`} className="text-emerald-800">
                    <span aria-hidden>+ </span>
                    <span className="sr-only">added: </span>
                    <ins className="no-underline">{x}</ins>
                  </span>
                ))}
                {d.kept.length ? (
                  <span className="text-muted-foreground text-xs">
                    {d.kept.length} unchanged item{d.kept.length === 1 ? '' : 's'}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

/** Comma-separated list input; committed on blur, reset when the value changes elsewhere. */
function ListInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <Input
      aria-label={label}
      key={commas(value)}
      defaultValue={commas(value)}
      onBlur={(e) => {
        const next = fromCommas(e.target.value);
        if (commas(next) !== commas(value)) onChange(next);
      }}
    />
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError && Array.isArray(err.details)) {
    const first = err.details[0] as
      { path?: (string | number)[]; message?: string } | string | undefined;
    if (typeof first === 'string')
      return `${err.message}: ${err.details.map((f) => FIELD_LABEL[f as ReviewField] ?? f).join(', ')}`;
    if (first) return `${err.message}: ${first.path?.join('.') ?? ''} ${first.message ?? ''}`;
  }
  return errorMessage(err);
}
