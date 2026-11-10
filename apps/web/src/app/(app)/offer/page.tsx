'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CostAction } from '@/components/blocks/cost-action';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface OfferRow {
  id: string;
  name: string;
  websiteUrl: string;
  updatedAt: number;
  latest: { version: number; status: string } | null;
  approvedVersion: number | null;
}

export default function OffersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const list = useQuery({ queryKey: ['offers'], queryFn: () => api<OfferRow[]>('/offers') });
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

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
      await qc.invalidateQueries({ queryKey: ['budget'] });
      router.push(`/offer/${res.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Offer profile</h1>
      <p className="text-muted-foreground text-sm">
        Enter your website. The engine reads the homepage and up to 5 key pages, drafts the offer,
        ICP, personas and intent phrases, and you edit and approve it. Streams use only the approved
        version.
      </p>
      <Card>
        <CardTitle>New offer</CardTitle>
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
              <span className="font-medium">{o.name || o.websiteUrl}</span>
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
