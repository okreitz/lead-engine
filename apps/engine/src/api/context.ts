import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';

/** Everything route handlers and jobs need. Tests build one with fakes. */
export interface AppContext {
  db: Db;
  config: Config;
  now: () => number;
}
