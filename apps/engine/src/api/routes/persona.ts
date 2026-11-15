import { needsCostConfirm, personaRunBodySchema } from '@le/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import {
  companies,
  jobs,
  personaCandidates,
  personaRuns,
  type CandidateFilters,
} from '../../db/schema.ts';
import { countCandidates, filtersFromIcp, selectCandidates } from '../../persona/candidates.ts';
import { approvedOffer, perCandidateUsd, startRun } from '../../persona/run.ts';
import { budgetStatus } from '../../providers/budget.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, workspaceOf } from '../http.ts';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** "Find matching companies" from the approved offer profile (SPEC §5.1, docs/ui.md §1.3). */
export function registerPersonaRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prepare = (workspaceId: string, body: unknown) => {
    const input = parse(personaRunBodySchema, body ?? {});
    const offer = approvedOffer(ctx.db, workspaceId);
    if (!offer) throw new HttpError(409, 'no_offer', 'approve an offer profile first');
    const filters: CandidateFilters = filtersFromIcp(offer.profile.icp);
    for (const [k, v] of Object.entries(input.filters ?? {}))
      if (v !== undefined) (filters as unknown as Record<string, unknown>)[k] = v;
    const matches = countCandidates(ctx.db, workspaceId, filters);
    const n = Math.min(matches, input.limit);
    const each = perCandidateUsd(ctx, workspaceId, offer.profile);
    const usd = Number((each.usd * n).toFixed(4));
    const budget = budgetStatus(ctx.db, workspaceId, ctx.now());
    return { input, offer, filters, matches, n, each, usd, budget };
  };

  // Dry run: how many companies match, a sample, and the cost upper bound.
  app.post('/api/v1/persona/estimate', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const p = prepare(workspaceId, request.body);
    return {
      filters: p.filters,
      matches: p.matches,
      candidates: p.n,
      sample: selectCandidates(ctx.db, workspaceId, p.offer.profile.icp, p.filters, 8),
      usd: p.usd,
      perCandidateUsd: Number(p.each.usd.toFixed(5)),
      provider: p.each.provider,
      model: p.each.model,
      remainingUsd: p.budget.remainingUsd,
      confirm: needsCostConfirm(p.usd, p.budget.remainingUsd),
    };
  });

  app.post('/api/v1/persona/runs', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const p = prepare(workspaceId, request.body);
    if (p.n === 0) throw new HttpError(409, 'no_candidates', 'no universe companies match');
    if (p.budget.state === 'reached') throw new HttpError(409, 'budget_reached', 'budget reached');
    const res = startRun(ctx, {
      workspaceId,
      userId,
      offer: p.offer,
      filters: p.filters,
      limit: p.input.limit,
      tech: p.input.tech,
      people: p.input.people,
      estimateUsd: p.usd,
    });
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'persona.run',
        target: `run:${res.id}`,
        details: { candidates: res.candidates, estimateUsd: p.usd },
      },
      ctx.now(),
    );
    return reply.code(201).send(res);
  });

  const withJob = (run: typeof personaRuns.$inferSelect) => {
    const job = run.jobId
      ? ctx.db
          .select({ state: jobs.state, waitReason: jobs.waitReason, lastError: jobs.lastError })
          .from(jobs)
          .where(eq(jobs.id, run.jobId))
          .get()
      : undefined;
    return { ...run, job: job ?? null };
  };

  app.get('/api/v1/persona/runs', async (request) => {
    const { workspaceId } = workspaceOf(request);
    return ctx.db
      .select()
      .from(personaRuns)
      .where(eq(personaRuns.workspaceId, workspaceId))
      .orderBy(desc(personaRuns.createdAt))
      .limit(20)
      .all()
      .map(withJob);
  });

  app.get('/api/v1/persona/runs/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const run = ctx.db
      .select()
      .from(personaRuns)
      .where(and(eq(personaRuns.id, id), eq(personaRuns.workspaceId, workspaceId)))
      .get();
    if (!run) throw new HttpError(404, 'not_found', 'run not found');
    const candidates = ctx.db
      .select({
        id: personaCandidates.id,
        position: personaCandidates.position,
        state: personaCandidates.state,
        ruleFit: personaCandidates.ruleFit,
        llmFit: personaCandidates.llmFit,
        fit: personaCandidates.fit,
        reasons: personaCandidates.reasons,
        evidence: personaCandidates.evidence,
        evidenceUrl: personaCandidates.evidenceUrl,
        note: personaCandidates.note,
        accountId: personaCandidates.accountId,
        name: companies.name,
        domain: companies.domain,
        state_: companies.state,
        industry: companies.industry,
        sizeRange: companies.sizeRange,
        tech: companies.tech,
      })
      .from(personaCandidates)
      .innerJoin(companies, eq(companies.id, personaCandidates.companyId))
      .where(eq(personaCandidates.runId, id))
      .orderBy(asc(personaCandidates.position))
      .all();
    return { ...withJob(run), candidates };
  });

  app.post('/api/v1/persona/runs/:id/cancel', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const res = ctx.db
      .update(personaRuns)
      .set({ state: 'cancelled', finishedAt: ctx.now(), updatedAt: ctx.now() })
      .where(
        and(
          eq(personaRuns.id, id),
          eq(personaRuns.workspaceId, workspaceId),
          inArray(personaRuns.state, ['queued', 'running']),
        ),
      )
      .run();
    if (res.changes === 0) throw new HttpError(409, 'not_running', 'run is not running');
    audit(
      ctx.db,
      { workspaceId, userId, action: 'persona.cancel', target: `run:${id}` },
      ctx.now(),
    );
    return { ok: true };
  });
}
