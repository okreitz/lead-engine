'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CostAction } from '@/components/blocks/cost-action';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';
import { useMe } from '@/lib/me';
import { offerLabel, type OfferRow } from '@/lib/offers';

export default function OffersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const list = useQuery({ queryKey: ['offers'], queryFn: () => api<OfferRow[]>('/offers') });
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const ws = useMe().data?.workspace;
  const limit = ws?.offerLimit ?? null;
  const count = list.data?.length ?? ws?.offerCount ?? 0;
  const atLimit = limit !== null && count >= limit;

  async function create() {
    const f = new FormData(form.current!);
    const competitors = String(f.get('competitors') ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const notes = String(f.get('notes') ?? '').trim();
    try {
      setError(null);
      const res = await api<{ id: string }>('/offers', {
        method: 'POST',
        body: {
          websiteUrl: String(f.get('url')),
          ...(notes ? { notes } : {}),
          ...(competitors.length ? { competitors } : {}),
        },
      });
      await qc.invalidateQueries({ queryKey: ['offers'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['budget'] });
      router.push(`/offer/${res.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Offer profile</h1>
        {list.data?.some((o) => o.approvedVersion) ? (
          <Link href="/find" className="text-sm font-medium underline-offset-4 hover:underline">
            Find matching companies →
          </Link>
        ) : null}
      </div>
      <p className="text-muted-foreground text-sm">
        One offer per business or funnel (e.g. your consulting site and each product). For each,
        enter its website: the engine reads the homepage and up to 5 key pages, drafts the offer,
        ICP, personas and intent phrases, and you edit and approve it. Every approved offer runs:
        the inbox searches all their intent phrases, and each account, thread and site belongs to
        one offer.
      </p>
      <Card>
        <div className="flex items-baseline justify-between">
          <CardTitle>New offer</CardTitle>
          {limit !== null ? (
            <span className="text-muted-foreground text-sm">
              {count} of {limit} offers used
            </span>
          ) : null}
        </div>
        {atLimit ? (
          <p className="text-muted-foreground mb-3 text-sm">
            This workspace has reached its limit of {limit} offer{limit === 1 ? '' : 's'}. Delete an
            offer (on its page) to add another.
          </p>
        ) : null}
        <form
          ref={form}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            // Enter in a field goes through the same cost check as the button.
            e.preventDefault();
          }}
        >
          <Label>
            Website URL
            <Input name="url" placeholder="https://example.com" required />
          </Label>
          <Label>
            Notes (optional)
            <Textarea name="notes" placeholder="Who you sell to, what to emphasise…" />
          </Label>
          <Label>
            Competitors (optional, comma or line separated)
            <Input name="competitors" />
          </Label>
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <div>
            <CostAction
              estimatePath="/offers/draft-estimate"
              label="Draft offer profile"
              what="Read the website and draft the offer profile with the LLM"
              disabled={atLimit}
              validate={() => form.current?.reportValidity() ?? false}
              onRun={create}
            />
          </div>
        </form>
      </Card>
      <ul className="flex flex-col gap-2">
        {list.data?.map((o) => (
          <li key={o.id}>
            <Link
              href={`/offer/${o.id}`}
              className="hover:bg-muted/40 flex items-center gap-3 rounded-lg border p-3 text-sm"
            >
              <span className="font-medium">{offerLabel(o)}</span>
              <span className="text-muted-foreground">{o.websiteUrl}</span>
              <span className="ml-auto flex items-center gap-2">
                {o.approvedVersion ? <Badge tone="ok">v{o.approvedVersion} approved</Badge> : null}
                {o.latest ? (
                  <Badge tone="muted">
                    v{o.latest.version} {o.latest.status}
                  </Badge>
                ) : null}
                <span className="text-muted-foreground text-xs">{fmtDate(o.updatedAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
