import type { AppContext } from '../api/context.ts';
import { Crawler } from '../crawler/crawler.ts';
import { offerDraftHandler } from '../offer/draft.ts';
import type { JobHandler } from './queue.ts';

/** Job types and their handlers. Streams register theirs here in later phases. */
export function jobHandlers(ctx: AppContext): Record<string, JobHandler> {
  let crawler: Crawler | null = null;
  const getCrawler = () => (ctx.crawler ??= crawler ??= new Crawler());
  return {
    'offer.draft': offerDraftHandler(getCrawler),
  };
}
