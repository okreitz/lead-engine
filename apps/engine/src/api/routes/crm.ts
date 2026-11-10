import {
  activityBodySchema,
  contactBodySchema,
  createAccountBodySchema,
  CSV_ENTITIES,
  dealBodySchema,
  nextStepBodySchema,
  stageBodySchema,
  suppressionBodySchema,
  updateAccountBodySchema,
} from '@le/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import {
  accountDetail,
  createAccount,
  CrmError,
  listAccounts,
  pipeline,
  requireAccount,
  setAccountStage,
} from '../../crm/accounts.ts';
import { exportCsv, importCsv } from '../../crm/csv-io.ts';
import { rescoreAccount, rescoreWorkspace } from '../../crm/scoring.ts';
import {
  addNextStep,
  addSuppression,
  createContact,
  createDeal,
  listContacts,
  listSuppressions,
  logActivity,
  requireContact,
  setNextStepDone,
  updateContact,
  updateDeal,
} from '../../crm/records.ts';
import {
  accounts,
  activities,
  companies,
  contacts,
  deals,
  fieldSources,
  nextSteps,
  suppressions,
} from '../../db/schema.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, workspaceOf } from '../http.ts';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Turns CRM domain errors into HTTP errors. */
function crm<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CrmError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
}

export function registerCrmRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addContentTypeParser(
    ['text/csv', 'text/plain'],
    { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // ---- accounts
  app.get('/api/v1/accounts', { config: { token: 'read' } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    const q = parse(
      z.object({
        q: z.string().max(200).optional(),
        stage: z.string().max(40).optional(),
        stream: z.enum(['visits', 'conversations', 'personas', 'manual']).optional(),
        minFit: z.coerce.number().min(0).max(100).optional(),
        minIntent: z.coerce.number().min(0).max(100).optional(),
        status: z.enum(['active', 'archived']).optional(),
        sort: z.enum(['priority', 'fit', 'intent', 'updated', 'name']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      request.query,
    );
    return listAccounts(ctx.db, workspaceId, q);
  });

  app.post('/api/v1/accounts', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(createAccountBodySchema, request.body);
    const res = crm(() =>
      ctx.db.transaction((tx) => {
        const r = createAccount(
          tx,
          workspaceId,
          { ...body, ownerUserId: userId },
          'manual',
          ctx.now(),
        );
        if (r.created) rescoreAccount(tx, workspaceId, r.id, ctx.now());
        return r;
      }),
    );
    return reply.code(res.created ? 201 : 200).send(res);
  });

  app.get('/api/v1/accounts/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    return crm(() => accountDetail(ctx.db, workspaceId, id));
  });

  app.patch('/api/v1/accounts/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(updateAccountBodySchema, request.body);
    const now = ctx.now();
    crm(() =>
      ctx.db.transaction((tx) => {
        const { company } = requireAccount(tx, workspaceId, id);
        const { status, ownerUserId, ...companyFields } = body;
        tx.update(accounts)
          .set({
            ...(status ? { status } : {}),
            ...(ownerUserId !== undefined ? { ownerUserId } : {}),
            updatedAt: now,
          })
          .where(eq(accounts.id, id))
          .run();
        if (Object.keys(companyFields).length) {
          tx.update(companies)
            .set({ ...companyFields, updatedAt: now })
            .where(eq(companies.id, company.id))
            .run();
        }
      }),
    );
    return { ok: true };
  });

  app.delete('/api/v1/accounts/:id', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    crm(() => {
      const { company } = requireAccount(ctx.db, workspaceId, id);
      ctx.db.delete(accounts).where(eq(accounts.id, id)).run();
      audit(
        ctx.db,
        {
          workspaceId,
          userId,
          action: 'account.delete',
          target: `account:${id}`,
          details: { domain: company.domain },
        },
        ctx.now(),
      );
    });
    return { ok: true };
  });

  app.patch('/api/v1/accounts/:id/stage', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const { stage } = parse(stageBodySchema, request.body);
    const changed = crm(() =>
      ctx.db.transaction((tx) => setAccountStage(tx, workspaceId, id, stage, userId, ctx.now())),
    );
    return { ok: true, changed };
  });

  app.post('/api/v1/accounts/:id/rescore', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    crm(() => requireAccount(ctx.db, workspaceId, id));
    ctx.db.transaction((tx) => rescoreAccount(tx, workspaceId, id, ctx.now()));
    return { ok: true };
  });

  app.get('/api/v1/pipeline', { config: { token: 'read' } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    return pipeline(ctx.db, workspaceId);
  });

  // ---- contacts
  app.get('/api/v1/contacts', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const q = parse(z.object({ q: z.string().max(200).optional() }), request.query);
    return listContacts(ctx.db, workspaceId, { q: q.q });
  });

  app.post('/api/v1/accounts/:id/contacts', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(contactBodySchema, request.body);
    const contactId = crm(() =>
      ctx.db.transaction((tx) =>
        createContact(tx, workspaceId, id, body, { source: 'manual' }, ctx.now()),
      ),
    );
    return reply.code(201).send({ id: contactId });
  });

  app.get('/api/v1/contacts/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const contact = crm(() => requireContact(ctx.db, workspaceId, id));
    const { company } = crm(() => requireAccount(ctx.db, workspaceId, contact.accountId));
    const sources = ctx.db
      .select()
      .from(fieldSources)
      .where(and(eq(fieldSources.entity, 'contact'), eq(fieldSources.entityId, id)))
      .all();
    const acts = ctx.db
      .select()
      .from(activities)
      .where(eq(activities.contactId, id))
      .orderBy(desc(activities.at))
      .all();
    return {
      contact,
      company: { name: company.name, domain: company.domain },
      fieldSources: sources,
      activities: acts,
    };
  });

  app.patch('/api/v1/contacts/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(contactBodySchema.partial(), request.body);
    crm(() => ctx.db.transaction((tx) => updateContact(tx, workspaceId, id, body, ctx.now())));
    return { ok: true };
  });

  app.delete('/api/v1/contacts/:id', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    crm(() => requireContact(ctx.db, workspaceId, id));
    ctx.db.delete(contacts).where(eq(contacts.id, id)).run();
    audit(
      ctx.db,
      { workspaceId, userId, action: 'contact.delete', target: `contact:${id}` },
      ctx.now(),
    );
    return { ok: true };
  });

  // ---- deals
  app.post('/api/v1/accounts/:id/deals', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(dealBodySchema, request.body);
    const dealId = crm(() =>
      ctx.db.transaction((tx) => createDeal(tx, workspaceId, id, body, ctx.now())),
    );
    return reply.code(201).send({ id: dealId });
  });

  app.patch('/api/v1/deals/:id', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(dealBodySchema.partial(), request.body);
    crm(() => ctx.db.transaction((tx) => updateDeal(tx, workspaceId, id, body, userId, ctx.now())));
    return { ok: true };
  });

  app.delete('/api/v1/deals/:id', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const res = ctx.db
      .delete(deals)
      .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId)))
      .run();
    if (!res.changes) throw new HttpError(404, 'not_found');
    audit(ctx.db, { workspaceId, userId, action: 'deal.delete', target: `deal:${id}` }, ctx.now());
    return { ok: true };
  });

  // ---- activities and next steps
  app.post('/api/v1/accounts/:id/activities', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(activityBodySchema, request.body);
    const actId = crm(() =>
      ctx.db.transaction((tx) =>
        logActivity(tx, workspaceId, { ...body, accountId: id }, userId, ctx.now()),
      ),
    );
    return reply.code(201).send({ id: actId });
  });

  app.post('/api/v1/accounts/:id/next-steps', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(nextStepBodySchema, request.body);
    const nsId = crm(() => addNextStep(ctx.db, workspaceId, id, body, ctx.now()));
    return reply.code(201).send({ id: nsId });
  });

  app.patch('/api/v1/next-steps/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const { done } = parse(z.object({ done: z.boolean() }).strict(), request.body);
    crm(() => setNextStepDone(ctx.db, workspaceId, id, done, ctx.now()));
    return { ok: true };
  });

  app.delete('/api/v1/next-steps/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    ctx.db
      .delete(nextSteps)
      .where(and(eq(nextSteps.id, id), eq(nextSteps.workspaceId, workspaceId)))
      .run();
    return { ok: true };
  });

  // ---- suppression list
  app.get('/api/v1/suppressions', async (request) => {
    const { workspaceId } = workspaceOf(request);
    return listSuppressions(ctx.db, workspaceId).map((s) => ({
      ...s,
      global: s.workspaceId === null,
    }));
  });

  app.post('/api/v1/suppressions', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(suppressionBodySchema, request.body);
    const res = crm(() => addSuppression(ctx.db, workspaceId, body, userId, ctx.now()));
    if (res.created) {
      audit(
        ctx.db,
        {
          workspaceId,
          userId,
          action: 'suppression.add',
          target: `${body.kind}:${body.value.toLowerCase()}`,
          details: { reason: body.reason },
        },
        ctx.now(),
      );
    }
    return reply.code(res.created ? 201 : 200).send(res);
  });

  /** One-click opt-out from a contact row (SPEC §9). */
  app.post('/api/v1/contacts/:id/suppress', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const contact = crm(() => requireContact(ctx.db, workspaceId, id));
    if (!contact.email)
      throw new HttpError(400, 'no_email', 'this contact has no email to suppress');
    crm(() =>
      addSuppression(
        ctx.db,
        workspaceId,
        { kind: 'email', value: contact.email!, reason: 'opt-out' },
        userId,
        ctx.now(),
      ),
    );
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'suppression.add',
        target: `email:${contact.email}`,
        details: { reason: 'opt-out', contact: id },
      },
      ctx.now(),
    );
    return { ok: true };
  });

  app.delete('/api/v1/suppressions/:id', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const row = ctx.db
      .select()
      .from(suppressions)
      .where(and(eq(suppressions.id, id), eq(suppressions.workspaceId, workspaceId)))
      .get();
    if (!row)
      throw new HttpError(
        404,
        'not_found',
        'not found (global entries are managed by the instance operator)',
      );
    ctx.db.delete(suppressions).where(eq(suppressions.id, id)).run();
    audit(
      ctx.db,
      { workspaceId, userId, action: 'suppression.remove', target: `${row.kind}:${row.value}` },
      ctx.now(),
    );
    return { ok: true };
  });

  // ---- CSV
  const entityParam = z.object({ entity: z.enum(CSV_ENTITIES) });

  app.post('/api/v1/import/:entity', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { entity } = parse(entityParam, request.params);
    if (typeof request.body !== 'string')
      throw new HttpError(415, 'csv_expected', 'send the CSV as text/csv');
    const text = request.body;
    const report = crm(() => importCsv(ctx.db, workspaceId, entity, text, ctx.now()));
    if (entity === 'accounts' && report.created)
      ctx.db.transaction((tx) => rescoreWorkspace(tx, workspaceId, ctx.now()));
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'import',
        target: entity,
        details: {
          created: report.created,
          existing: report.existing,
          skipped: report.skipped.length,
        },
      },
      ctx.now(),
    );
    return report;
  });

  app.get('/api/v1/export/:entity', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { entity } = parse(
      z.object({ entity: z.string().regex(/^(accounts|contacts|deals)\.csv$/) }),
      request.params,
    );
    const name = entity.replace('.csv', '') as (typeof CSV_ENTITIES)[number];
    const { csv, rows } = exportCsv(ctx.db, workspaceId, name);
    audit(
      ctx.db,
      { workspaceId, userId, action: 'export', target: name, details: { rows } },
      ctx.now(),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });
}
