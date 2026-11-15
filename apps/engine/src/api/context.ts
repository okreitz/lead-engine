import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { Crawler } from '../crawler/crawler.ts';
import type { LlmAdapter } from '../llm/types.ts';
import type { HttpFetch } from '../people/http.ts';
import type { TechDetector } from '../persona/tech.ts';
import type { DownloadFetch } from '../universe/files.ts';

/** Everything route handlers and jobs need. Tests build one with fakes. */
export interface AppContext {
  db: Db;
  config: Config;
  now: () => number;
  /** Forces one LLM adapter (tests use `fakeLlm`). */
  llm?: LlmAdapter;
  /** Crawler override (tests use a fake fetch). */
  crawler?: Crawler;
  /** Dataset download override (tests serve fixture files). */
  download?: DownloadFetch;
  /** Technographics override (tests use a fake httpx). */
  tech?: TechDetector;
  /** HTTP for fixed API hosts (Icypeas, SEC, ATS boards, Reacher); tests use a fake. */
  http?: HttpFetch;
  /** Waits between provider polls (tests skip them). */
  sleep?: (ms: number) => Promise<void>;
}
