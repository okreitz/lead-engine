/**
 * "Find matching companies" (SPEC §5.1 steps 2–4) as the `persona.fit` job. Each slice takes
 * the next pending candidates in rank order: fetch the homepage (robots.txt, throttled),
 * optionally detect technologies, then ask the LLM for a fit score. A candidate whose final
 * fit reaches the threshold becomes an account with a `fit` signal. Budget stops make the job
 * wait with pending candidates intact; nothing already scored is paid for twice (LLM cache).
 */
import { DEFAULT_FIT_THRESHOLD, offerProfileSchema, type OfferProfile } from '@le/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { Crawler, CrawlError, type CrawledPage } from '../crawler/crawler.ts';
import { createAccountForCompany } from '../crm/accounts.ts';
import { fitScore } from '../crm/scoring.ts';
import { rescoreAccount } from '../crm/scoring.ts';
import type { Tx } from '../db/client.ts';
import {
  companies,
  offerVersions,
  personaCandidates,
  personaRuns,
  signals,
  workspaces,
  type CandidateFilters,
  type PersonaRunCounts,
} from '../db/schema.ts';
import { newId } from '../ids.ts';
import { ContinueJob, enqueue, PermanentJobError, type JobHandler } from '../jobs/queue.ts';
import { LlmOutputError, llmAdapterFor, runLlm } from '../llm/index.ts';
import { estimateCallUsd } from '../llm/pricing.ts';
import { UNTRUSTED_RULES } from '../llm/prompt.ts';
import { ProviderCallError } from '../providers/errors.ts';
import { selectCandidates } from './candidates.ts';
import {
  buildFitPrompt,
  FIT_MAX_OUTPUT,
  FIT_SYSTEM,
  fitLlmSchema,
  HOMEPAGE_CHARS,
  verifiedEvidence,
} from './fit.ts';
import { httpxDetector, type TechDetector } from './tech.ts';

export const RUN_LIMITS = { sliceMs: 20_000, batch: 5 };

/** Approved offer version the run scores against. */
export function approvedOffer(
  tx: Tx,
  workspaceId: string,
): { id: string; profile: OfferProfile } | null {
  const row = tx
    .select({ id: offerVersions.id, data: offerVersions.data })
    .from(offerVersions)
    .where(and(eq(offerVersions.workspaceId, workspaceId), eq(offerVersions.status, 'approved')))
    .orderBy(sql`${offerVersions.approvedAt} DESC`)
    .get();
  const parsed = offerProfileSchema.safeParse(row?.data);
  return row && parsed.success ? { id: row.id, profile: parsed.data } : null;
}

/** Upper bound of one candidate's LLM fit call (the budget check uses the same bound). */
export function perCandidateUsd(ctx: AppContext, workspaceId: string, offer: OfferProfile) {
  const adapter = llmAdapterFor(ctx, workspaceId);
  const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  const model = ws?.settings.llmModel ?? adapter.defaultModel;
  const prompt = buildFitPrompt(
    offer,
    { name: 'x'.repeat(60), domain: 'x'.repeat(40) },
    { url: 'https://example.com/', title: '', description: '', text: 'x'.repeat(HOMEPAGE_CHARS) },
  );
  return {
    usd: estimateCallUsd(model, `${FIT_SYSTEM}\n\n${UNTRUSTED_RULES}`, prompt, FIT_MAX_OUTPUT),
    provider: adapter.name,
    model,
  };
}

export function emptyCounts(candidates = 0): PersonaRunCounts {
  return { candidates, scored: 0, accounts: 0, skipped: 0, errors: 0, techChecked: 0 };
}

/** Creates the run with its ranked candidate list and queues the job. */
export function startRun(
  ctx: AppContext,
  input: {
    workspaceId: string;
    userId: string | null;
    offer: { id: string; profile: OfferProfile };
    filters: CandidateFilters;
    limit: number;
    tech: boolean;
    people: boolean;
    estimateUsd: number;
  },
): { id: string; jobId: string; candidates: number } {
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const ws = tx.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).get()!;
    const list = selectCandidates(
      tx,
      input.workspaceId,
      input.offer.profile.icp,
      input.filters,
      input.limit,
    );
    const id = newId('run');
    tx.insert(personaRuns)
      .values({
        id,
        workspaceId: input.workspaceId,
        offerVersionId: input.offer.id,
        filters: input.filters,
        limit: input.limit,
        threshold: ws.settings.fitThreshold ?? DEFAULT_FIT_THRESHOLD,
        options: { tech: input.tech, people: input.people },
        state: 'queued',
        counts: emptyCounts(list.length),
        estimateUsd: input.estimateUsd,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    list.forEach((c, position) =>
      tx
        .insert(personaCandidates)
        .values({
          id: newId('cand'),
          runId: id,
          workspaceId: input.workspaceId,
          companyId: c.companyId,
          position,
          ruleFit: c.ruleFit,
          state: 'pending',
        })
        .run(),
    );
    const jobId = enqueue(
      tx,
      {
        workspaceId: input.workspaceId,
        type: 'persona.fit',
        payload: { runId: id },
        maxAttempts: 5,
      },
      now,
    );
    tx.update(personaRuns).set({ jobId }).where(eq(personaRuns.id, id)).run();
    return { id, jobId, candidates: list.length };
  });
}

export function runCounts(tx: Tx, runId: string, techChecked: number): PersonaRunCounts {
  const rows = tx
    .select({
      state: personaCandidates.state,
      n: sql<number>`count(*)`,
      accounts: sql<number>`sum(${personaCandidates.accountId} IS NOT NULL)`,
    })
    .from(personaCandidates)
    .where(eq(personaCandidates.runId, runId))
    .groupBy(personaCandidates.state)
    .all();
  const by = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
  return {
    candidates: rows.reduce((s, r) => s + r.n, 0),
    scored: by('scored'),
    accounts: rows.reduce((s, r) => s + (r.accounts ?? 0), 0),
    skipped: by('skipped'),
    errors: by('error'),
    techChecked,
  };
}

const FIT_SIGNAL_TTL_MS = 180 * 86_400_000;

export function personaFitHandler(
  getCrawler: () => Crawler,
  getTech: (ctx: AppContext) => TechDetector = (ctx) => ctx.tech ?? httpxDetector(),
): JobHandler {
  return async ({ ctx, job }) => {
    const runId = String(job.payload.runId);
    const load = () => ctx.db.select().from(personaRuns).where(eq(personaRuns.id, runId)).get();
    let run = load();
    if (!run) throw new PermanentJobError('run not found');
    if (run.state === 'done' || run.state === 'cancelled' || run.state === 'failed')
      return { skipped: run.state };
    const offerRow = ctx.db
      .select({ data: offerVersions.data })
      .from(offerVersions)
      .where(eq(offerVersions.id, run.offerVersionId))
      .get();
    const parsed = offerProfileSchema.safeParse(offerRow?.data);
    if (!parsed.success) {
      ctx.db
        .update(personaRuns)
        .set({ state: 'failed', error: 'offer version is gone', updatedAt: ctx.now() })
        .where(eq(personaRuns.id, runId))
        .run();
      throw new PermanentJobError('offer version is gone');
    }
    const offer = parsed.data;
    if (run.state === 'queued') {
      ctx.db
        .update(personaRuns)
        .set({ state: 'running', updatedAt: ctx.now() })
        .where(eq(personaRuns.id, runId))
        .run();
    }

    let tech: TechDetector | null = null;
    if (run.options.tech) {
      const detector = getTech(ctx);
      const why = await detector.unavailable();
      if (why) {
        if (run.techNote !== why)
          ctx.db
            .update(personaRuns)
            .set({ techNote: `Technographics skipped: ${why}` })
            .where(eq(personaRuns.id, runId))
            .run();
      } else tech = detector;
    }

    const crawler = getCrawler();
    const deadline = ctx.now() + RUN_LIMITS.sliceMs;
    let techChecked = run.counts.techChecked;
    do {
      const batch = ctx.db
        .select({ cand: personaCandidates, company: companies })
        .from(personaCandidates)
        .innerJoin(companies, eq(companies.id, personaCandidates.companyId))
        .where(and(eq(personaCandidates.runId, runId), eq(personaCandidates.state, 'pending')))
        .orderBy(asc(personaCandidates.position))
        .limit(RUN_LIMITS.batch)
        .all();
      if (!batch.length) break;
      const setCand = (id: string, values: Partial<typeof personaCandidates.$inferInsert>) =>
        ctx.db
          .update(personaCandidates)
          .set({ ...values, scoredAt: ctx.now() })
          .where(eq(personaCandidates.id, id))
          .run();

      // 1. Homepages, fetched concurrently (different hosts; the crawler throttles per host).
      const pages = new Map<string, CrawledPage>();
      await Promise.all(
        batch.map(async ({ cand, company }) => {
          try {
            pages.set(cand.id, await crawler.fetchPage(`https://${company.domain}/`));
          } catch (err) {
            if (!(err instanceof CrawlError)) throw err;
            setCand(cand.id, {
              state: 'skipped',
              note:
                err.kind === 'robots'
                  ? 'robots.txt disallows our crawler'
                  : `homepage not fetched: ${err.message}`.slice(0, 200),
            });
          }
        }),
      );

      // 2. Technographics for the fetched homepages (optional, free).
      if (tech && pages.size) {
        const targets = batch
          .filter(({ cand }) => pages.has(cand.id))
          .map(({ company }) => `https://${company.domain}/`);
        let found = new Map<string, string[]>();
        try {
          found = await tech.detect(targets);
        } catch {
          // A failing detector only loses the tech facts.
        }
        const now = ctx.now();
        for (const { company } of batch) {
          const t = found.get(`https://${company.domain}/`);
          if (!t) continue;
          techChecked++;
          company.tech = t;
          ctx.db
            .update(companies)
            .set({
              tech: t,
              techCheckedAt: now,
              origins: { ...company.origins, tech: 'httpx' },
              updatedAt: now,
            })
            .where(eq(companies.id, company.id))
            .run();
        }
      }

      // 3. LLM fit, one call at a time (budget checks never race).
      for (const { cand, company } of batch) {
        const page = pages.get(cand.id);
        if (!page) continue;
        let llm;
        try {
          llm = await runLlm(ctx, {
            workspaceId: run.workspaceId,
            stream: 'personas',
            jobId: job.id,
            system: FIT_SYSTEM,
            prompt: buildFitPrompt(offer, company, page),
            schema: fitLlmSchema,
            maxOutputTokens: FIT_MAX_OUTPUT,
            ledgerEntity: { type: 'company', id: company.id },
          });
        } catch (err) {
          if (
            err instanceof LlmOutputError ||
            (err instanceof ProviderCallError && !err.retryable)
          ) {
            setCand(cand.id, { state: 'error', note: err.message.slice(0, 200) });
            continue;
          }
          throw err; // budget stops wait; transient errors retry the slice
        }
        const evidence = verifiedEvidence(
          llm.evidence,
          [page.title, page.description, page.text].join('\n'),
        );
        const final = fitScore(company, offer.icp, { score: llm.fit, reasons: llm.reasons });
        const now = ctx.now();
        ctx.db.transaction((tx) => {
          let accountId: string | null = null;
          if (final.score >= run!.threshold) {
            accountId = createAccountForCompany(
              tx,
              run!.workspaceId,
              company.id,
              'personas',
              now,
            ).id;
            tx.insert(signals)
              .values({
                id: newId('sig'),
                workspaceId: run!.workspaceId,
                accountId,
                stream: 'personas',
                kind: 'fit',
                weight: 0,
                occurredAt: now,
                payload: {
                  score: llm.fit,
                  reasons: llm.reasons,
                  evidence,
                  runId,
                  source: 'homepage',
                },
                evidenceUrl: page.url,
                expiresAt: now + FIT_SIGNAL_TTL_MS,
              })
              .run();
            rescoreAccount(tx, run!.workspaceId, accountId, now, offer.icp);
          }
          tx.update(personaCandidates)
            .set({
              state: 'scored',
              llmFit: llm.fit,
              fit: final.score,
              reasons: final.reasons,
              evidence,
              evidenceUrl: page.url,
              accountId,
              scoredAt: now,
            })
            .where(eq(personaCandidates.id, cand.id))
            .run();
        });
      }

      ctx.db
        .update(personaRuns)
        .set({ counts: runCounts(ctx.db, runId, techChecked), updatedAt: ctx.now() })
        .where(eq(personaRuns.id, runId))
        .run();
      run = load()!;
      if (run.state === 'cancelled') return { stopped: 'cancelled' };
    } while (ctx.now() < deadline);

    const pending = ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(personaCandidates)
      .where(and(eq(personaCandidates.runId, runId), eq(personaCandidates.state, 'pending')))
      .get()!.n;
    if (pending > 0) return new ContinueJob(0, { pending });
    const now = ctx.now();
    const counts = runCounts(ctx.db, runId, techChecked);
    ctx.db
      .update(personaRuns)
      .set({ state: 'done', counts, finishedAt: now, updatedAt: now })
      .where(eq(personaRuns.id, runId))
      .run();
    if (run.options.people) onRunAccounts?.(ctx, run.workspaceId, runId);
    return counts;
  };
}

/** Hook for the people + email step (set by `people/`), called when a run finishes. */
export let onRunAccounts: ((ctx: AppContext, workspaceId: string, runId: string) => void) | null =
  null;
export function setOnRunAccounts(fn: typeof onRunAccounts): void {
  onRunAccounts = fn;
}
