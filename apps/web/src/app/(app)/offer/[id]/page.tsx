'use client';
import type { OfferProfile } from '@le/shared';
import { INTENT_KINDS } from '@le/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { api, ApiError, errorMessage, fmtDate } from '@/lib/api';

interface Version {
  id: string;
  version: number;
  status: 'drafting' | 'draft' | 'approved' | 'superseded' | 'failed';
  source: 'llm' | 'human';
  data: OfferProfile | null;
  pages: { url: string; title?: string }[] | null;
  error: string | null;
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

export default function OfferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['offer', id],
    queryFn: () => api<Detail>(`/offers/${id}`),
    // Poll while a draft is being written.
    refetchInterval: (query) =>
      query.state.data?.versions.some((v) => v.status === 'drafting') ? 3000 : false,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const versions = q.data?.versions ?? [];
  const current =
    versions.find((v) => v.version === selected) ?? versions[versions.length - 1] ?? null;

  if (!q.data) return <p className="text-muted-foreground text-sm">Loading…</p>;
  const refresh = () => qc.invalidateQueries({ queryKey: ['offer', id] });

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {q.data.offer.name || q.data.offer.websiteUrl}
          </h1>
          <p className="text-muted-foreground text-sm">{q.data.offer.websiteUrl}</p>
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            await api(`/offers/${id}/redraft`, { method: 'POST', body: {} });
            setSelected(null);
            await refresh();
          }}
        >
          Redraft from website
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setSelected(v.version)}
            className={`rounded-md border px-3 py-1 text-sm ${current?.id === v.id ? 'bg-accent' : ''}`}
          >
            v{v.version} <Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge>
          </button>
        ))}
      </div>
      {current ? (
        <VersionView
          key={current.id}
          offerId={id}
          v={current}
          onSaved={(n) => {
            setSelected(n);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function VersionView({
  offerId,
  v,
  onSaved,
}: {
  offerId: string;
  v: Version;
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
  return <Editor offerId={offerId} v={v} onSaved={onSaved} />;
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
  onSaved,
}: {
  offerId: string;
  v: Version;
  onSaved: (version: number) => void;
}) {
  const [data, setData] = useState<OfferProfile>(v.data!);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const locked = v.status === 'approved' || v.status === 'superseded';
  const set = <K extends keyof OfferProfile>(k: K, value: OfferProfile[K]) =>
    setData({ ...data, [k]: value });
  const setIcp = <K extends keyof OfferProfile['icp']>(k: K, value: OfferProfile['icp'][K]) =>
    setData({ ...data, icp: { ...data.icp, [k]: value } });

  async function save(): Promise<number | null> {
    try {
      const res = await api<{ version: number; created: boolean }>(
        `/offers/${offerId}/versions/${v.version}`,
        {
          method: 'PUT',
          body: { data },
        },
      );
      setMsg({ tone: 'ok', text: res.created ? `Saved as new draft v${res.version}` : 'Saved' });
      onSaved(res.version);
      return res.version;
    } catch (err) {
      setMsg({ tone: 'err', text: describe(err) });
      return null;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()}>
          {locked ? 'Save changes as a new version' : 'Save draft'}
        </Button>
        {v.status === 'draft' ? (
          <Button
            variant="outline"
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
            Save and approve
          </Button>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {v.source === 'llm' ? 'LLM draft' : 'edited'} · created {fmtDate(v.createdAt)}
          {v.approvedAt ? ` · approved ${fmtDate(v.approvedAt)}` : ''}
        </span>
        {msg ? (
          <span
            className={msg.tone === 'ok' ? 'text-sm text-emerald-700' : 'text-destructive text-sm'}
          >
            {msg.text}
          </span>
        ) : null}
      </div>
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
        <div className="flex flex-col gap-3">
          <Label>
            Name
            <Input value={data.name} onChange={(e) => set('name', e.target.value)} />
          </Label>
          <Label>
            Summary
            <Textarea
              rows={4}
              value={data.summary}
              onChange={(e) => set('summary', e.target.value)}
            />
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <Label>
              Value propositions (one per line)
              <Textarea
                rows={5}
                value={lines(data.valueProps)}
                onChange={(e) => set('valueProps', fromLines(e.target.value))}
              />
            </Label>
            <Label>
              Competitors (one per line)
              <Textarea
                rows={5}
                value={lines(data.competitors)}
                onChange={(e) => set('competitors', fromLines(e.target.value))}
              />
            </Label>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Ideal customer profile (US)</CardTitle>
        <div className="grid grid-cols-2 gap-3">
          <ListField
            label="Industries"
            value={data.icp.industries}
            onChange={(x) => setIcp('industries', x)}
          />
          <ListField
            label="NAICS codes"
            value={data.icp.naics}
            onChange={(x) => setIcp('naics', x)}
          />
          <Label>
            Employee range
            <Input
              value={data.icp.employeeRange}
              onChange={(e) => setIcp('employeeRange', e.target.value)}
            />
          </Label>
          <Label>
            Revenue range
            <Input
              value={data.icp.revenueRange ?? ''}
              onChange={(e) => setIcp('revenueRange', e.target.value || null)}
            />
          </Label>
          <ListField
            label="States (two-letter, empty = all)"
            value={data.icp.states}
            onChange={(x) =>
              setIcp(
                'states',
                x.map((s) => s.toUpperCase()),
              )
            }
          />
          <ListField
            label="Uses technology"
            value={data.icp.techUses}
            onChange={(x) => setIcp('techUses', x)}
          />
          <ListField
            label="Avoids technology"
            value={data.icp.techAvoids}
            onChange={(x) => setIcp('techAvoids', x)}
          />
          <ListField
            label="Must have"
            value={data.icp.mustHave}
            onChange={(x) => setIcp('mustHave', x)}
          />
          <ListField
            label="Exclude"
            value={data.icp.exclude}
            onChange={(x) => setIcp('exclude', x)}
          />
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Personas</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              set('personas', [
                ...data.personas,
                { title: '', seniority: '', department: '', pains: [], titleKeywords: [] },
              ])
            }
          >
            Add persona
          </Button>
        </div>
        <div className="flex flex-col gap-4">
          {data.personas.map((p, i) => {
            const update = (patch: Partial<typeof p>) =>
              set(
                'personas',
                data.personas.map((x, j) => (j === i ? { ...x, ...patch } : x)),
              );
            return (
              <div key={i} className="grid grid-cols-3 gap-2 border-t pt-3">
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
                <ListField
                  label="Pains"
                  value={p.pains}
                  onChange={(x) => update({ pains: x })}
                  wide
                />
                <ListField
                  label="Title keywords"
                  value={p.titleKeywords}
                  onChange={(x) => update({ titleKeywords: x })}
                />
                <div className="col-span-3">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      set(
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
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Intent phrases ({data.intentPhrases.length})</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              set('intentPhrases', [
                ...data.intentPhrases,
                { phrase: '', kind: 'seeking', negative: [] },
              ])
            }
          >
            Add phrase
          </Button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th>Phrase</th>
              <th>Kind</th>
              <th>Negative keywords</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.intentPhrases.map((p, i) => {
              const update = (patch: Partial<typeof p>) =>
                set(
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
                    <Input
                      value={commas(p.negative)}
                      onChange={(e) => update({ negative: fromCommas(e.target.value) })}
                      aria-label="Negative keywords"
                    />
                  </td>
                  <td>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        set(
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
      </Card>
    </div>
  );
}

/** Comma-separated list input; committed on blur, reset when the value changes elsewhere. */
function ListField({
  label,
  value,
  onChange,
  wide = false,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  wide?: boolean;
}): ReactNode {
  return (
    <Label className={wide ? 'col-span-2' : undefined}>
      {label}
      <Input
        key={commas(value)}
        defaultValue={commas(value)}
        onBlur={(e) => onChange(fromCommas(e.target.value))}
      />
    </Label>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError && Array.isArray(err.details)) {
    const first = err.details[0] as { path?: (string | number)[]; message?: string } | undefined;
    if (first) return `${err.message}: ${first.path?.join('.') ?? ''} ${first.message ?? ''}`;
  }
  return errorMessage(err);
}
