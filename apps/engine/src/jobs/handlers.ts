import type { JobHandler } from './queue.ts';

/** Job types and their handlers. Streams and the offer profile register theirs here. */
export function jobHandlers(): Record<string, JobHandler> {
  return {};
}
