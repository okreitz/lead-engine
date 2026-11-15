'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MissingKey, WaitReason } from '@/components/blocks/key-help';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';

interface Enrichment {
  remainingUsd: number;
  people: { usd: number; provider: string; model: string; confirm: boolean } | null;
  email: {
    contacts: number;
    usd: number;
    perContactUsd: number;
    provider: string;
    verifier: 'reacher' | 'icypeas' | null;
    finder: 'icypeas' | null;
    confirm: boolean;
  };
  jobs: {
    id: string;
    type: string;
    state: string;
    waitReason: string | null;
    lastError: string | null;
    result: Record<string, unknown> | null;
  }[];
}

const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const ACTIVE = ['queued', 'running', 'waiting'];

/**
 * "Find people" and "Find email" on the account page (docs/ui.md §3.3): the estimate and the
 * remaining budget show next to each button; a dialog confirms only costly runs.
 */
export function Enrichment({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['enrichment', accountId],
    queryFn: () => api<Enrichment>(`/accounts/${accountId}/enrichment`),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => ACTIVE.includes(j.state)) ? 3_000 : false,
  });
  const [prevActive, setPrevActive] = useState(false);
  const active = q.data?.jobs.some((j) => ACTIVE.includes(j.state)) ?? false;
  if (prevActive !== active) {
    setPrevActive(active);
    // A finished job added contacts or emails: reload the account.
    if (!active) void qc.invalidateQueries({ queryKey: ['account', accountId] });
  }
  const start = useMutation({
    mutationFn: (path: string) =>
      api(`/accounts/${accountId}/${path}`, { method: 'POST', body: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['enrichment', accountId] }),
  });
  const e = q.data;
  if (!e) return null;
  const running = (type: string) => e.jobs.some((j) => j.type === type && ACTIVE.includes(j.state));
  const latest = (type: string) => e.jobs.find((j) => j.type === type);
  const noEmailProvider = !e.email.verifier && !e.email.finder;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {e.people ? (
          <Paid
            label="Find people"
            busy={running('people.find')}
            usd={e.people.usd}
            confirm={e.people.confirm}
            remainingUsd={e.remainingUsd}
            what="Read the team, about and leadership pages and extract people with the LLM"
            detail={`${e.people.provider} · ${e.people.model}; SEC EDGAR officers and job boards are free`}
            onRun={() => start.mutate('people')}
          />
        ) : (
          <span className="text-muted-foreground">Approve an offer profile to find people.</span>
        )}
        <Paid
          label={`Find email${e.email.contacts === 1 ? '' : 's'} (${e.email.contacts})`}
          busy={running('email.find')}
          disabled={e.email.contacts === 0 || noEmailProvider}
          usd={e.email.usd}
          confirm={e.email.confirm}
          remainingUsd={e.remainingUsd}
          what={`Find and verify emails for ${e.email.contacts} contacts (pattern from the site, then ${e.email.provider})`}
          detail={`up to ${money(e.email.perContactUsd)} per contact; finder misses are free`}
          onRun={() => start.mutate('emails')}
        />
      </div>
      {noEmailProvider ? (
        <p className="text-muted-foreground">
          <MissingKey id="icypeas" what="Email verification" /> Reacher stays off until the port 25
          test passes.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Verifier: {e.email.verifier ?? 'none'} · finder: {e.email.finder ?? 'none'}
        </p>
      )}
      {['people.find', 'email.find'].map((t) => {
        const j = latest(t);
        if (!j) return null;
        const label = t === 'people.find' ? 'People' : 'Emails';
        return (
          <p
            key={t}
            className={j.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
          >
            {label}: {j.state}
            {j.state === 'waiting' && j.waitReason ? (
              <>
                {' ('}
                <WaitReason text={j.waitReason} />)
              </>
            ) : null}
            {j.state === 'failed' && j.lastError ? (
              <>
                {' ('}
                <WaitReason text={j.lastError} />)
              </>
            ) : null}
            {j.state === 'done' && j.result ? ` · ${summary(j.result)}` : ''}
          </p>
        );
      })}
      {start.error ? <p className="text-destructive">{errorMessage(start.error)}</p> : null}
    </div>
  );
}

function summary(r: Record<string, unknown>): string {
  if ('contactsCreated' in r) {
    const pages = (r.pages as string[] | undefined)?.length ?? 0;
    return [
      `${r.contactsCreated} new contacts from ${pages} pages`,
      r.officers ? `${r.officers} EDGAR officers` : '',
      r.pattern ? `pattern ${r.pattern}` : '',
      r.hiring ? `${r.hiring} hiring signals` : '',
    ]
      .filter(Boolean)
      .join(', ');
  }
  if ('withEmail' in r) return `${r.withEmail} of ${r.contacts} contacts have an email`;
  return '';
}

function Paid(props: {
  label: string;
  usd: number;
  confirm: boolean;
  remainingUsd: number;
  what: string;
  detail: string;
  busy: boolean;
  disabled?: boolean;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        size="xs"
        variant="outline"
        disabled={props.busy || props.disabled}
        onClick={() => (props.confirm ? setOpen(true) : props.onRun())}
      >
        {props.busy ? `${props.label}…` : props.label}
      </Button>
      <span className="text-muted-foreground" title={props.detail}>
        est. up to {money(props.usd)} · {money(props.remainingUsd)} left
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Run this paid action?"
          description={`${props.what}. Estimated cost up to ${money(props.usd)}; ${money(props.remainingUsd)} of this month's budget is left.`}
        >
          <p className="text-muted-foreground text-xs">
            {props.detail}. Every charge is in the ledger.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => {
                setOpen(false);
                props.onRun();
              }}
            >
              Run for up to {money(props.usd)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}
