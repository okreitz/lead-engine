import type { AppContext } from '../api/context.ts';
import { Crawler } from '../crawler/crawler.ts';
import { offerDraftHandler } from '../offer/draft.ts';
import { emailFindHandler, peopleFindHandler, queuePeopleForRun } from '../people/jobs.ts';
import { personaFitHandler, setOnRunAccounts } from '../persona/run.ts';
import { universeImportHandler } from '../universe/import.ts';
import type { JobHandler } from './queue.ts';

/** Job types and their handlers. Streams register theirs here in later phases. */
export function jobHandlers(ctx: AppContext): Record<string, JobHandler> {
  let crawler: Crawler | null = null;
  const getCrawler = () => (ctx.crawler ??= crawler ??= new Crawler());
  setOnRunAccounts(queuePeopleForRun);
  return {
    'offer.draft': offerDraftHandler(getCrawler),
    'universe.import': universeImportHandler(),
    'persona.fit': personaFitHandler(getCrawler),
    'people.find': peopleFindHandler(getCrawler),
    'email.find': emailFindHandler(),
  };
}
