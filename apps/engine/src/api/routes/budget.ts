import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JOB_STATES, jobs } from '../../db/schema.ts';
import { budgetStatus } from '../../providers/budget.ts';
import type { AppContext } from '../context.ts';
import { parse, workspaceOf } from '../http.ts';

export function registerBudgetRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Spend vs budget for the current month, with waiting jobs and their reasons (SPEC §8.1). */
  app.get('/api/v1/budget', { config: { token: 'read' } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    const status = budgetStatus(ctx.db, workspaceId, ctx.now());
    const waiting = ctx.db
      .select({ id: jobs.id, type: jobs.type, waitReason: jobs.waitReason, runAt: jobs.runAt })
      .from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.state, 'waiting')))
      .all();
    return { ...status, waitingJobs: waiting };
  });

  app.get('/api/v1/jobs', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const q = parse(
      z.object({
        state: z.enum(JOB_STATES).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    return ctx.db
      .select({
        id: jobs.id,
        type: jobs.type,
        state: jobs.state,
        attempts: jobs.attempts,
        runAt: jobs.runAt,
        lastError: jobs.lastError,
        waitReason: jobs.waitReason,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          q.state ? inArray(jobs.state, [q.state]) : undefined,
        ),
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(q.limit)
      .all();
  });
}
