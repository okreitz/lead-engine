import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findAccount } from '../../crm/accounts.ts';
import { jobs } from '../../db/schema.ts';
import { enqueue } from '../../jobs/queue.ts';
import { estimates } from '../../people/jobs.ts';
import { approvedOffers } from '../../offer/approved.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, workspaceOf } from '../http.ts';

const idParam = z.object({ id: z.string().min(1).max(64) });
const peopleBody = z.object({ emails: z.boolean().default(false) }).strict();
const emailBody = z.object({ contactIds: z.array(z.string().max(64)).max(50).optional() }).strict();
const KINDS = ['people.find', 'email.find'];

/** "Find people" and "Find email" on the account page (docs/ui.md §3.3): cost first, then a job. */
export function registerPeopleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAcc = (workspaceId: string, id: string) => {
    if (!findAccount(ctx.db, workspaceId, id))
      throw new HttpError(404, 'not_found', 'account not found');
  };
  const running = (workspaceId: string, accountId: string, type: string) =>
    ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.type, type),
          inArray(jobs.state, ['queued', 'running', 'waiting']),
          sql`json_extract(${jobs.payload}, '$.accountId') = ${accountId}`,
        ),
      )
      .get();

  app.get('/api/v1/accounts/:id/enrichment', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    requireAcc(workspaceId, id);
    const recent = ctx.db
      .select({
        id: jobs.id,
        type: jobs.type,
        state: jobs.state,
        waitReason: jobs.waitReason,
        lastError: jobs.lastError,
        result: jobs.result,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          inArray(jobs.type, KINDS),
          sql`json_extract(${jobs.payload}, '$.accountId') = ${id}`,
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(6)
      .all();
    return { ...estimates(ctx, workspaceId, id), jobs: recent };
  });

  app.post('/api/v1/accounts/:id/people', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(peopleBody, request.body ?? {});
    requireAcc(workspaceId, id);
    if (!approvedOffers(ctx.db, workspaceId).length)
      throw new HttpError(409, 'no_offer', 'approve an offer profile first');
    if (running(workspaceId, id, 'people.find'))
      throw new HttpError(409, 'already_running', 'already finding people');
    const jobId = enqueue(
      ctx.db,
      { workspaceId, type: 'people.find', payload: { accountId: id, emails: body.emails } },
      ctx.now(),
    );
    return reply.code(202).send({ jobId });
  });

  app.post('/api/v1/accounts/:id/emails', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(emailBody, request.body ?? {});
    requireAcc(workspaceId, id);
    if (running(workspaceId, id, 'email.find'))
      throw new HttpError(409, 'already_running', 'already finding emails');
    const jobId = enqueue(
      ctx.db,
      {
        workspaceId,
        type: 'email.find',
        payload: { accountId: id, ...(body.contactIds ? { contactIds: body.contactIds } : {}) },
        maxAttempts: 5,
      },
      ctx.now(),
    );
    return reply.code(202).send({ jobId });
  });
}
