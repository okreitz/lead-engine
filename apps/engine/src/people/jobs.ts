/**
 * Stream 3 people and email jobs (SPEC §5.1 steps 5–7):
 * - `people.find` {accountId, emails?}: team/about/leadership pages → LLM extraction and
 *   persona match → EDGAR officers for public companies → contacts with a source per field;
 *   the domain's email pattern from published addresses; ATS hiring signals.
 * - `email.find` {accountId, contactIds?}: the email waterfall per contact, in slices.
 * No people-search vendor is used (no Icypeas Find People, no LinkedIn data).
 */
import { needsCostConfirm, type OfferProfile } from '@le/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { Crawler, CrawlError, type CrawledPage } from '../crawler/crawler.ts';
import { findAccount } from '../crm/accounts.ts';
import { createContact, CrmErrorGuard } from './contacts.ts';
import { rescoreAccount } from '../crm/scoring.ts';
import type { Tx } from '../db/client.ts';
import { companies, contacts, fieldSources, signals, workspaces } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { ContinueJob, enqueue, PermanentJobError, type JobHandler } from '../jobs/queue.ts';
import { llmAdapterFor, runLlm } from '../llm/index.ts';
import { estimateCallUsd } from '../llm/pricing.ts';
import { UNTRUSTED_RULES } from '../llm/prompt.ts';
import { approvedOffer } from '../persona/run.ts';
import { budgetStatus } from '../providers/budget.ts';
import { ICYPEAS_CREDIT_USD, SEARCH_CREDITS, VERIFY_CREDITS } from '../providers/icypeas.ts';
import { ProviderAuthError, ProviderCallError } from '../providers/errors.ts';
import { ReacherThrottled } from '../providers/reacher.ts';
import { findSuppression } from '../suppression.ts';
import { discoverPages } from './discover.ts';
import { edgarOfficers } from './edgar.ts';
import { emailProviders, findEmail } from './email.ts';
import {
  buildPeoplePrompt,
  PAGE_CHARS,
  PEOPLE_MAX_OUTPUT,
  PEOPLE_SYSTEM,
  peopleLlmSchema,
  seniorityOf,
  validatePeople,
  matchPersona,
} from './extract.ts';
import { detectBoards, fetchJobs, matchingJobs } from './hiring.ts';
import { defaultHttp } from './http.ts';
import { emailsOnPage, learnPattern, publishedFor, splitName, type PatternId } from './names.ts';

export const EMAIL_LIMITS = { sliceMs: 20_000, maxContacts: 10 };
const HIRING_TTL_MS = 60 * 86_400_000;
const MAX_PEOPLE_PAGES = 3;

const squashName = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

function model(ctx: AppContext, workspaceId: string) {
  const adapter = llmAdapterFor(ctx, workspaceId);
  const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  return { adapter, model: ws?.settings.llmModel ?? adapter.defaultModel };
}

/** Upper bound of one "Find people": the extraction call over the maximum page text. */
export function peopleEstimateUsd(ctx: AppContext, workspaceId: string, offer: OfferProfile) {
  const m = model(ctx, workspaceId);
  const fake = Array.from({ length: MAX_PEOPLE_PAGES + 1 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: '',
    description: '',
    text: 'x'.repeat(PAGE_CHARS),
    links: [],
    status: 200,
  }));
  return {
    usd: estimateCallUsd(
      m.model,
      `${PEOPLE_SYSTEM}\n\n${UNTRUSTED_RULES}`,
      buildPeoplePrompt(offer, fake),
      PEOPLE_MAX_OUTPUT,
    ),
    provider: m.adapter.name,
    model: m.model,
  };
}

/** Upper bound per contact: three verifications plus one found email. */
export function emailPerContactUsd(ctx: AppContext, workspaceId: string) {
  const p = emailProviders(ctx, workspaceId);
  const verify = p.verifierName === 'icypeas' ? 3 * VERIFY_CREDITS * ICYPEAS_CREDIT_USD : 0;
  const find = p.finder ? SEARCH_CREDITS * ICYPEAS_CREDIT_USD : 0;
  return { usd: verify + find, verifier: p.verifierName, finder: p.finder ? 'icypeas' : null };
}

/** Contacts the email step would work on: no address yet, or one not yet verified. */
export function emailTargets(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  contactIds?: string[],
) {
  const rows = tx
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.accountId, accountId),
        eq(contacts.status, 'active'),
        or(
          isNull(contacts.email),
          isNull(contacts.emailStatus),
          eq(contacts.emailStatus, 'unknown'),
        ),
        ...(contactIds?.length ? [inArray(contacts.id, contactIds)] : []),
      ),
    )
    .all();
  // Persona matches first, then the rest.
  return rows
    .sort(
      (a, b) =>
        Number(!a.personaMatch) - Number(!b.personaMatch) || a.fullName.localeCompare(b.fullName),
    )
    .slice(0, EMAIL_LIMITS.maxContacts);
}

export function estimates(ctx: AppContext, workspaceId: string, accountId: string) {
  const offer = approvedOffer(ctx.db, workspaceId);
  const budget = budgetStatus(ctx.db, workspaceId, ctx.now());
  const people = offer ? peopleEstimateUsd(ctx, workspaceId, offer.profile) : null;
  const per = emailPerContactUsd(ctx, workspaceId);
  const targets = emailTargets(ctx.db, workspaceId, accountId).length;
  const emailUsd = per.usd * targets;
  return {
    remainingUsd: budget.remainingUsd,
    people: people && {
      usd: Number(people.usd.toFixed(4)),
      provider: people.provider,
      model: people.model,
      confirm: needsCostConfirm(people.usd, budget.remainingUsd),
    },
    email: {
      contacts: targets,
      usd: Number(emailUsd.toFixed(4)),
      perContactUsd: Number(per.usd.toFixed(4)),
      provider: [per.verifier, per.finder].filter(Boolean).join(' + ') || 'none',
      verifier: per.verifier,
      finder: per.finder,
      confirm: needsCostConfirm(emailUsd, budget.remainingUsd),
    },
  };
}

function addSource(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  field: string,
  source: string,
  url: string | null,
  confidence: number,
  now: number,
) {
  tx.insert(fieldSources)
    .values({
      id: newId('fs'),
      workspaceId,
      entity: 'contact',
      entityId: contactId,
      field,
      source,
      url,
      fetchedAt: now,
      confidence,
    })
    .run();
}

export function peopleFindHandler(getCrawler: () => Crawler): JobHandler {
  return async ({ ctx, job }) => {
    const accountId = String(job.payload.accountId);
    const row = findAccount(ctx.db, job.workspaceId, accountId);
    if (!row) throw new PermanentJobError('account not found');
    const { company } = row;
    const offer = approvedOffer(ctx.db, job.workspaceId);
    if (!offer) throw new PermanentJobError('approve an offer profile first');
    const crawler = getCrawler();
    const http = ctx.http ?? defaultHttp;
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // 1. Pages
    let found;
    try {
      found = await discoverPages(crawler, company.domain);
    } catch (err) {
      if (err instanceof CrawlError)
        throw new PermanentJobError(`homepage not fetched: ${err.message}`);
      throw err;
    }
    const pages: CrawledPage[] = found.pages.length ? found.pages : [found.home];

    // 2. LLM extraction (people pages only; the homepage when there are none)
    const llm = await runLlm(ctx, {
      workspaceId: job.workspaceId,
      stream: 'personas',
      jobId: job.id,
      system: PEOPLE_SYSTEM,
      prompt: buildPeoplePrompt(offer.profile, pages),
      schema: peopleLlmSchema,
      maxOutputTokens: PEOPLE_MAX_OUTPUT,
      ledgerEntity: { type: 'account', id: accountId },
    });
    const people = validatePeople(llm.people, pages, offer.profile.personas);

    // 3. EDGAR officers for public companies
    const officers =
      company.cik && ctx.config.secUserAgent
        ? await edgarOfficers({
            cik: company.cik,
            userAgent: ctx.config.secUserAgent,
            http,
            sleep,
          }).catch(() => [])
        : [];

    // 4. Published addresses and the domain pattern
    const allPages = [found.home, ...found.pages, ...(found.careers ? [found.careers] : [])];
    const published = [
      ...new Set(allPages.flatMap((p) => emailsOnPage(p.text, p.links, company.domain))),
    ];
    const names = [...people.map((p) => p.name), ...officers.map((o) => o.name)];
    const learned = learnPattern(published, names);
    const now = ctx.now();

    // 5. Contacts
    const existing = new Set(
      ctx.db
        .select({ n: contacts.fullName })
        .from(contacts)
        .where(eq(contacts.accountId, accountId))
        .all()
        .map((c) => squashName(c.n)),
    );
    let created = 0;
    const persona = (title: string | null) =>
      title ? matchPersona(title, offer.profile.personas) : null;
    const candidates = [
      ...people.map((p) => ({ ...p, source: 'website', confidence: 0.8 })),
      ...officers.map((o) => {
        const pm = persona(o.title);
        return {
          name: o.name,
          title: o.title,
          sourceUrl: o.url,
          persona: pm,
          personaBy: pm ? ('keywords' as const) : null,
          source: 'sec-edgar',
          confidence: 0.95,
        };
      }),
    ];
    ctx.db.transaction((tx) => {
      for (const p of candidates) {
        const key = squashName(p.name);
        if (existing.has(key)) continue;
        existing.add(key);
        const parts = splitName(p.name);
        let email = parts ? publishedFor(published, parts) : null;
        if (email && findSuppression(tx, job.workspaceId, { emails: [email] })) email = null;
        const id = CrmErrorGuard(() =>
          createContact(
            tx,
            job.workspaceId,
            accountId,
            { fullName: p.name, title: p.title, email, emailStatus: email ? 'unknown' : null },
            { source: p.source, url: p.sourceUrl, confidence: p.confidence },
            now,
          ),
        );
        if (!id) continue;
        created++;
        const dept = p.persona
          ? (offer.profile.personas.find((x) => x.title === p.persona)?.department ?? null)
          : null;
        const seniority = p.title ? seniorityOf(p.title) : null;
        tx.update(contacts)
          .set({ personaMatch: p.persona, seniority, department: dept })
          .where(eq(contacts.id, id))
          .run();
        if (p.persona)
          addSource(
            tx,
            job.workspaceId,
            id,
            'personaMatch',
            p.personaBy === 'llm' ? 'llm-persona-match' : 'title-keywords',
            null,
            p.personaBy === 'llm' ? 0.7 : 0.8,
            now,
          );
        if (seniority)
          addSource(tx, job.workspaceId, id, 'seniority', 'title-rules', null, 0.7, now);
        if (dept) addSource(tx, job.workspaceId, id, 'department', 'persona', null, 0.6, now);
      }
      if (learned) {
        tx.update(companies)
          .set({
            emailPattern: learned.pattern,
            emailPatternExamples: learned.examples,
            updatedAt: now,
          })
          .where(eq(companies.id, company.id))
          .run();
      }
    });

    // 6. Hiring signals from public ATS job boards linked on the site
    let hiring = 0;
    const boards = detectBoards(allPages.flatMap((p) => p.links));
    for (const board of boards) {
      const jobs = await fetchJobs(http, board).catch(() => []);
      for (const j of matchingJobs(jobs, offer.profile)) {
        const dup = ctx.db
          .select({ id: signals.id })
          .from(signals)
          .where(
            and(
              eq(signals.accountId, accountId),
              eq(signals.kind, 'hiring'),
              eq(signals.evidenceUrl, j.url),
            ),
          )
          .get();
        if (dup) continue;
        ctx.db
          .insert(signals)
          .values({
            id: newId('sig'),
            workspaceId: job.workspaceId,
            accountId,
            stream: 'personas',
            kind: 'hiring',
            weight: 3,
            occurredAt: Math.min(j.postedAt ?? now, now),
            payload: { title: j.title, ats: board.ats, location: j.location, persona: j.persona },
            evidenceUrl: j.url,
            expiresAt: now + HIRING_TTL_MS,
          })
          .run();
        hiring++;
      }
    }
    ctx.db.transaction((tx) => rescoreAccount(tx, job.workspaceId, accountId, ctx.now()));

    if (job.payload.emails) {
      enqueue(
        ctx.db,
        {
          workspaceId: job.workspaceId,
          type: 'email.find',
          payload: { accountId },
          maxAttempts: 5,
        },
        ctx.now(),
      );
    }
    return {
      pages: pages.map((p) => p.url),
      people: people.length,
      officers: officers.length,
      contactsCreated: created,
      pattern: learned?.pattern ?? null,
      hiring,
    };
  };
}

export function emailFindHandler(): JobHandler {
  return async ({ ctx, job }) => {
    const accountId = String(job.payload.accountId);
    const row = findAccount(ctx.db, job.workspaceId, accountId);
    if (!row) throw new PermanentJobError('account not found');
    const progress = (job.result as { done?: string[]; found?: number } | null) ?? {};
    const done = new Set(progress.done ?? []);
    let foundCount = progress.found ?? 0;
    const ids = Array.isArray(job.payload.contactIds)
      ? (job.payload.contactIds as string[])
      : undefined;
    const targets = emailTargets(ctx.db, job.workspaceId, accountId, ids).filter(
      (c) => !done.has(c.id),
    );
    const providers = emailProviders(ctx, job.workspaceId);
    const deadline = ctx.now() + EMAIL_LIMITS.sliceMs;
    const pattern = row.company.emailPattern as PatternId | null;
    for (const c of targets) {
      if (ctx.now() >= deadline) return new ContinueJob(0, { done: [...done], found: foundCount });
      let res;
      try {
        res = await findEmail(ctx, providers, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          contactId: c.id,
          fullName: c.fullName,
          domain: row.company.domain,
          existing: c.email,
          pattern,
        });
      } catch (err) {
        if (err instanceof ReacherThrottled)
          return new ContinueJob(err.waitMs, { done: [...done], found: foundCount });
        if (err instanceof ProviderAuthError) throw new PermanentJobError(err.message);
        if (err instanceof ProviderCallError && !err.retryable) {
          done.add(c.id); // this contact only (e.g. bad input); the others go on
          continue;
        }
        throw err;
      }
      done.add(c.id);
      if (!res.email || !res.status) continue;
      if (findSuppression(ctx.db, job.workspaceId, { emails: [res.email] })) continue;
      const now = ctx.now();
      const email = res.email;
      const status = res.status;
      ctx.db.transaction((tx) => {
        tx.update(contacts)
          .set({ email, emailDomain: email.split('@')[1]!, emailStatus: status, updatedAt: now })
          .where(eq(contacts.id, c.id))
          .run();
        if (email !== c.email)
          addSource(tx, job.workspaceId, c.id, 'email', res.source, null, res.confidence, now);
        addSource(tx, job.workspaceId, c.id, 'emailStatus', res.source, null, res.confidence, now);
      });
      foundCount++;
    }
    return { contacts: done.size, withEmail: foundCount };
  };
}

/** Called when a persona run finishes with `people` on: people + emails for its new accounts. */
export function queuePeopleForRun(ctx: AppContext, workspaceId: string, runId: string): void {
  const rows = ctx.db.all<{ account_id: string }>(
    sql`SELECT DISTINCT account_id FROM persona_candidates WHERE run_id = ${runId} AND account_id IS NOT NULL`,
  );
  for (const r of rows)
    enqueue(
      ctx.db,
      { workspaceId, type: 'people.find', payload: { accountId: r.account_id, emails: true } },
      ctx.now(),
    );
}
