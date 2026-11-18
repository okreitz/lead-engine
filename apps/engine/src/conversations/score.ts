/**
 * Stream 2 pipeline step 3 (SPEC §5.3): the LLM scores each pending thread through the provider
 * layer (budget, cache, ledger), with no tools and zod-validated output. The post, and the
 * workspace's feedback examples, are untrusted text and go only inside `<untrusted_data>`
 * blocks. `companyMentioned` is kept only when the name really appears in the post.
 */
import { BUYING_STAGES, INBOX_MIN_INTENT, THREAD_LABELS, type OfferProfile } from '@le/shared';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../api/context.ts';
import { workspaces, threads } from '../db/schema.ts';
import { ContinueJob, PermanentJobError, type JobHandler } from '../jobs/queue.ts';
import { LlmOutputError, runLlm } from '../llm/index.ts';
import { buildPrompt, type DataBlock } from '../llm/prompt.ts';
import { offerBrief } from '../persona/fit.ts';
import { approvedOffers } from '../offer/approved.ts';
import { ProviderCallError } from '../providers/errors.ts';
import { feedbackExamples, type FeedbackExample } from './store.ts';

export const SCORE_TEXT_CHARS = 2_500;
export const SCORE_MAX_OUTPUT = 700;
export const DEFAULT_DAILY_SCORING_CAP = 300;
const SLICE = { batch: 10, ms: 20_000 };

export const SCORE_SYSTEM = `You triage public forum posts for a B2B seller. For one post, decide whether the
author is looking for what the seller offers. Return:
- intent: 0 unrelated or no need; 1 related topic but no need; 2 a real need the offer could meet
  (a question, a pain, or asking for alternatives); 3 actively looking to buy, switch or get
  recommendations now.
- label: buy_intent, alternative (wants a replacement for a named product), pain (complains about a
  problem the offer solves), question (asks how to do something the offer helps with), or none.
- pain: the problem in at most 15 words, or null.
- stage: problem_aware, researching, evaluating, ready_to_buy, using_competitor or unknown.
- persona: the poster's likely role in at most 6 words (e.g. "agency founder"), or null. Never
  guess a name or identity.
- companyMentioned: only if the author explicitly names the company they work for or own, as
  {name, domain or null}; otherwise null. Never infer it from usernames, links or style.
- replyAngle: a short, helpful, honest reply draft (max 80 words) a person could post. Answer the
  question first, mention the offer only where it truly fits, and disclose the affiliation
  ("I work on …"). No links unless essential, no hype.
- selfPromo: true if the post itself promotes the author's own product or service.
- reason: one sentence (max 25 words) explaining the intent score.
Score from the post only. Feedback examples show what this seller found relevant or not.`;

export const threadScoreSchema = z.object({
  intent: z.number().int().min(0).max(3),
  label: z.enum(THREAD_LABELS),
  pain: z.string().trim().max(200).nullable(),
  stage: z.enum(BUYING_STAGES),
  persona: z.string().trim().max(80).nullable(),
  companyMentioned: z
    .object({
      name: z.string().trim().min(1).max(120),
      domain: z.string().trim().max(253).nullable(),
    })
    .nullable(),
  replyAngle: z.string().trim().max(1200),
  selfPromo: z.boolean(),
  reason: z.string().trim().max(300),
});
export type ThreadScore = z.infer<typeof threadScoreSchema>;

export interface ScorablePost {
  source: string;
  url: string;
  title: string;
  excerpt: string;
  matchedPhrase: string;
}

/** Trusted task text (offer, matched phrase) first, then the post and examples as data. */
export function buildScorePrompt(
  offer: OfferProfile,
  post: ScorablePost,
  examples: FeedbackExample[],
): string {
  const blocks: DataBlock[] = [];
  if (examples.length) {
    blocks.push({
      label: 'feedback examples',
      text: examples
        .map(
          (e, i) =>
            `Example ${i + 1} (${e.verdict === 'good' ? 'RELEVANT' : 'NOT RELEVANT'}): ${e.title}\n${e.excerpt}`,
        )
        .join('\n\n'),
      maxChars: 3_000,
    });
  }
  blocks.push({
    label: 'post',
    source: post.url,
    text: `${post.title}\n\n${post.excerpt}`,
    maxChars: SCORE_TEXT_CHARS,
  });
  return buildPrompt(
    `${offerBrief(offer)}\nCompetitors: ${offer.competitors.join(', ') || '—'}\n\n` +
      `The post below (source: ${post.source}) matched the intent phrase "${post.matchedPhrase}". ` +
      `Score it.${examples.length ? ' Use the feedback examples as guidance for what counts as relevant.' : ''}`,
    blocks,
  );
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/** The mention only if the post text names it (SPEC §5.3: only if the poster names it). */
export function verifiedMention(
  mention: ThreadScore['companyMentioned'],
  postText: string,
): ThreadScore['companyMentioned'] {
  if (!mention) return null;
  const text = squash(postText);
  const name = squash(mention.name).trim();
  if (name.length < 2 || !text.includes(name)) return null;
  const domain =
    mention.domain
      ?.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '') ?? null;
  return { name: mention.name.trim(), domain: domain && text.includes(domain) ? domain : null };
}

function dayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function scoredToday(ctx: AppContext, workspaceId: string): number {
  return (
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(threads)
      .where(and(eq(threads.workspaceId, workspaceId), gte(threads.scoredAt, dayStart(ctx.now()))))
      .get()?.n ?? 0
  );
}

export function dailyScoringCap(ctx: AppContext, workspaceId: string): number {
  const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  return ws?.settings.conversations?.dailyScoringCap ?? DEFAULT_DAILY_SCORING_CAP;
}

/** Scores one thread and stores the result. Budget errors propagate (the job waits). */
export async function scoreThread(
  ctx: AppContext,
  workspaceId: string,
  threadId: string,
  offer: OfferProfile,
  jobId?: string,
): Promise<ThreadScore | null> {
  const t = ctx.db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (!t || t.workspaceId !== workspaceId) return null;
  const examples = feedbackExamples(ctx.db, workspaceId, 3, t.offerId);
  const prompt = buildScorePrompt(offer, t, examples);
  let out: ThreadScore;
  try {
    out = await runLlm(ctx, {
      workspaceId,
      stream: 'conversations',
      ...(jobId ? { jobId } : {}),
      system: SCORE_SYSTEM,
      prompt,
      schema: threadScoreSchema,
      maxOutputTokens: SCORE_MAX_OUTPUT,
      ledgerEntity: { type: 'thread', id: t.id },
    });
  } catch (err) {
    if (err instanceof LlmOutputError || (err instanceof ProviderCallError && !err.retryable)) {
      ctx.db
        .update(threads)
        .set({
          scoreStatus: 'failed',
          scoreError: err.message.slice(0, 300),
          updatedAt: ctx.now(),
        })
        .where(eq(threads.id, t.id))
        .run();
      return null;
    }
    throw err;
  }
  const now = ctx.now();
  ctx.db
    .update(threads)
    .set({
      scoreStatus: 'scored',
      intent: out.intent,
      label: out.label,
      pain: out.pain,
      stage: out.stage,
      persona: out.persona,
      suggestedReply: out.replyAngle,
      companyMentioned: verifiedMention(out.companyMentioned, `${t.title}\n${t.excerpt}`),
      selfPromo: out.selfPromo,
      scoreReason: out.reason,
      scoreError: null,
      scoredAt: now,
      updatedAt: now,
    })
    .where(eq(threads.id, t.id))
    .run();
  return out;
}

/** `conversations.score`: scores pending threads in slices, up to the daily cap. */
export function threadScoreHandler(): JobHandler {
  return async ({ ctx, job }) => {
    const offers = approvedOffers(ctx.db, job.workspaceId);
    if (!offers.length) throw new PermanentJobError('no approved offer profile');
    // Each thread is scored against the offer whose phrase matched it.
    const offerOf = (offerId: string | null) =>
      offers.find((o) => o.offerId === offerId) ?? offers[0]!;
    const started = ctx.now();
    let scored = 0;
    let inbox = 0;
    for (;;) {
      const left = dailyScoringCap(ctx, job.workspaceId) - scoredToday(ctx, job.workspaceId);
      if (left <= 0) return { scored, inbox, capped: true };
      const batch = ctx.db
        .select({ id: threads.id, offerId: threads.offerId })
        .from(threads)
        .where(and(eq(threads.workspaceId, job.workspaceId), eq(threads.scoreStatus, 'pending')))
        .orderBy(asc(threads.createdAt))
        .limit(Math.min(SLICE.batch, left))
        .all();
      if (!batch.length) return { scored, inbox };
      for (const { id, offerId } of batch) {
        const r = await scoreThread(ctx, job.workspaceId, id, offerOf(offerId).profile, job.id);
        if (r) {
          scored++;
          if (r.intent >= INBOX_MIN_INTENT) inbox++;
        }
      }
      if (ctx.now() - started > SLICE.ms) return new ContinueJob(0, { scored, inbox });
    }
  };
}
