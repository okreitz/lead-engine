/**
 * Offer profile drafting (SPEC §4.1): fetch the homepage plus up to 5 key pages, then ask
 * the LLM for a schema-validated draft. Runs as a job so budget stops make it wait.
 */
import { offerDraftLlmSchema, type ReviewField } from '@le/shared';
import { and, eq } from 'drizzle-orm';
import { Crawler, CrawlError, type CrawledPage } from '../crawler/crawler.ts';
import { selectKeyPages } from '../crawler/extract.ts';
import { offers, offerVersions } from '../db/schema.ts';
import { LlmOutputError, runLlm } from '../llm/index.ts';
import { ProviderCallError } from '../providers/errors.ts';
import { buildPrompt, type DataBlock } from '../llm/prompt.ts';
import { PermanentJobError, type JobHandler } from '../jobs/queue.ts';

export const OFFER_SYSTEM = `You write B2B offer profiles for a US lead-generation tool.
From a company's website text, describe what it sells and to whom:
- name: the product or company name.
- summary: 2-4 plain sentences on what it sells, for whom, and the outcome.
- valueProps: 3-6 short value propositions, using the site's claims only.
- competitors: likely competing products or companies (include ones the user named).
- icp: the ideal US customer companies. industries in plain words; naics as 2-6 digit codes;
  employeeRange like "11-50" or "51-500"; revenueRange or null; states as two-letter US codes
  (empty list = all states); techUses/techAvoids as technology names; mustHave and exclude as
  short firmographic criteria.
- personas: 2-5 buyer personas with title, seniority, department, pains and titleKeywords.
- intentPhrases: 25-35 phrases people write in public posts when they need this offer.
  kind is seeking ("looking for a tool to …"), alternative ("alternative to X"), pain (a
  problem statement) or recommendation ("recommend a …"). Add negative keywords that filter
  out false positives (jobs, students, self-promotion, unrelated meanings).
- rationale: for each field above, one sentence on why you chose it, citing the page it came
  from (field names: name, summary, valueProps, competitors, icp.industries, icp.naics,
  icp.employeeRange, icp.revenueRange, icp.states, icp.techUses, icp.techAvoids, icp.mustHave,
  icp.exclude, personas, intentPhrases).
Base everything on the website text and the user's notes. Do not invent customers or numbers.`;

export const MAX_KEY_PAGES = 5;
export const PAGE_CHARS = 8_000;

export function buildOfferPrompt(
  websiteUrl: string,
  pages: CrawledPage[],
  input: { notes?: string; competitors?: string[] } = {},
): string {
  const blocks: DataBlock[] = pages.map((p, i) => ({
    label: i === 0 ? 'homepage' : `page ${i}`,
    source: p.url,
    text: [p.title, p.description, p.text].filter(Boolean).join('\n\n'),
    maxChars: PAGE_CHARS,
  }));
  if (input.notes) blocks.push({ label: 'user notes', text: input.notes, maxChars: 4_000 });
  if (input.competitors?.length) {
    blocks.push({
      label: 'competitors named by the user',
      text: input.competitors.join('\n'),
      maxChars: 2_000,
    });
  }
  return buildPrompt(`Write the offer profile for ${websiteUrl} from the pages below.`, blocks);
}

/** Homepage first, then up to 5 key pages; pages that fail are skipped. */
export async function crawlOfferSite(crawler: Crawler, websiteUrl: string): Promise<CrawledPage[]> {
  const home = await crawler.fetchPage(websiteUrl);
  const pages = [home];
  for (const url of selectKeyPages(home.url, home.links, MAX_KEY_PAGES)) {
    try {
      pages.push(await crawler.fetchPage(url));
    } catch (err) {
      if (!(err instanceof CrawlError)) throw err;
    }
  }
  return pages;
}

export function offerDraftHandler(getCrawler: () => Crawler): JobHandler {
  return async ({ ctx, job }) => {
    const versionId = String(job.payload.offerVersionId);
    const row = ctx.db
      .select({ version: offerVersions, offer: offers })
      .from(offerVersions)
      .innerJoin(offers, eq(offers.id, offerVersions.offerId))
      .where(and(eq(offerVersions.id, versionId), eq(offerVersions.workspaceId, job.workspaceId)))
      .get();
    if (!row) throw new PermanentJobError('offer version not found');
    if (row.version.status !== 'drafting') return { skipped: row.version.status };

    const fail = (message: string) => {
      ctx.db
        .update(offerVersions)
        .set({ status: 'failed', error: message, updatedAt: ctx.now() })
        .where(eq(offerVersions.id, versionId))
        .run();
      return new PermanentJobError(message);
    };

    let pages: CrawledPage[];
    try {
      pages = await crawlOfferSite(getCrawler(), row.offer.websiteUrl);
    } catch (err) {
      if (err instanceof CrawlError) throw fail(`could not fetch ${err.url}: ${err.message}`);
      throw err;
    }
    const input = row.version.input ?? {};
    const lastAttempt = job.attempts >= job.maxAttempts;
    let draft;
    try {
      draft = await runLlm(ctx, {
        workspaceId: job.workspaceId,
        stream: 'personas',
        jobId: job.id,
        system: OFFER_SYSTEM,
        prompt: buildOfferPrompt(row.offer.websiteUrl, pages, input),
        schema: offerDraftLlmSchema,
        maxOutputTokens: 6_000,
        // Retries after invalid output ask again instead of re-reading a cached answer.
        refresh: job.attempts > 1,
        ledgerEntity: { type: 'offer_version', id: versionId },
      });
    } catch (err) {
      // Budget stops propagate (the job waits). Model failures end the draft on the last try.
      const permanent = err instanceof ProviderCallError && !err.retryable;
      if (
        (err instanceof LlmOutputError || err instanceof ProviderCallError) &&
        (permanent || lastAttempt)
      ) {
        throw fail(`the model could not produce a valid draft: ${err.message}`);
      }
      throw err;
    }
    const { rationale, ...data } = draft;
    const why: Partial<Record<ReviewField, string>> = {};
    for (const r of rationale) why[r.field] = r.why;
    const now = ctx.now();
    ctx.db
      .update(offerVersions)
      .set({
        status: 'draft',
        data,
        rationale: why,
        // An empty review means every field still needs a decision before approval.
        review: {},
        error: null,
        pages: pages.map((p) => ({ url: p.url, title: p.title })),
        updatedAt: now,
      })
      .where(eq(offerVersions.id, versionId))
      .run();
    ctx.db
      .update(offers)
      .set({ name: row.offer.name || data.name, updatedAt: now })
      .where(eq(offers.id, row.offer.id))
      .run();
    return { pages: pages.length };
  };
}
