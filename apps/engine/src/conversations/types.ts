import type { OfferProfile, ThreadSource } from '@le/shared';
import type { AppContext } from '../api/context.ts';

export type IntentPhrase = OfferProfile['intentPhrases'][number];

/** One post as a source adapter returns it, before the prefilter. Text is plain and untrusted. */
export interface RawThread {
  source: ThreadSource;
  /** The source's own id: HN objectID, Stack Exchange question_id, at:// URI, issue URL, … */
  externalId: string;
  url: string;
  title: string;
  /** Plain text the prefilter and the LLM see (Reddit: the search snippet only). */
  text: string;
  /** Public handle as shown on the source; never linked to a person. Null for Reddit. */
  author: string | null;
  postedAt: number;
  /** Display details (site, tags, repository), never personal data. */
  meta?: Record<string, unknown>;
}

export interface PollInput {
  ctx: AppContext;
  workspaceId: string;
  phrases: IntentPhrase[];
  /** The source's saved cursor (per-phrase timestamps, rotation index, …). */
  cursor: Record<string, unknown>;
  jobId?: string;
  /** Stop starting new requests after this time; the job continues in a later slice. */
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  settings: { stackexchangeSites: string[] };
}

export interface PollOutput {
  items: RawThread[];
  cursor: Record<string, unknown>;
  /** False when the run stopped at the deadline and has phrases left for the next slice. */
  done: boolean;
  /** Requests made, for the source status line. */
  calls: number;
}

/** A polling source (SPEC §5.3: each adapter has `poll()` or `stream()`). */
export interface PollingSource {
  id: Exclude<ThreadSource, 'bluesky'>;
  poll(input: PollInput): Promise<PollOutput>;
}
