import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { LlmAdapter } from '../llm/types.ts';

/** Everything route handlers and jobs need. Tests build one with fakes. */
export interface AppContext {
  db: Db;
  config: Config;
  now: () => number;
  /** Forces one LLM adapter (tests use `fakeLlm`). */
  llm?: LlmAdapter;
}
