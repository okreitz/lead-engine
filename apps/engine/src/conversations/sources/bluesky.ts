/**
 * Bluesky through Jetstream v2 (docs/providers.md "Bluesky Jetstream", checked 2026-11-16) with
 * the official client `@bsky/jetstream` (MIT OR Apache-2.0). One connection per engine, not per
 * workspace: `app.bsky.feed.post` commits only, about 30–50 posts/s, matched locally against
 * every workspace's intent phrases. Only matches are stored. Deletion events remove a stored post
 * (Bluesky developer guidelines). The connection is open only while some workspace has an
 * approved offer with the Bluesky source on, and the client is loaded only then.
 */
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../api/context.ts';
import { conversationSources, engineState, workspaces } from '../../db/schema.ts';
import { maskSecrets } from '../../log-mask.ts';
import { approvedOffers } from '../../offer/approved.ts';
import { compileOffers, matchText, type CompiledPhrase } from '../prefilter.ts';
import { deleteBySourceId, ingestThreads } from '../store.ts';
import type { RawThread } from '../types.ts';

export const JETSTREAM_URL = 'https://jetstream.us-east.bsky.network';
const CURSOR_KEY = 'bluesky.jetstream.cursor';
/** A saved cursor older than this is not replayed: start live instead. */
const CURSOR_MAX_AGE_MS = 60 * 60_000;
/** Most matches stored per workspace per day, so a too-broad phrase can't flood scoring. */
export const BLUESKY_MATCHES_PER_DAY = 300;

/** The raw v2 event the client yields with `raw: true` (only the fields we read). */
export interface JetstreamEvent {
  did?: unknown;
  seq?: unknown;
  kind?: unknown;
  commit?: {
    operation?: unknown;
    collection?: unknown;
    rkey?: unknown;
    record?: { text?: unknown; createdAt?: unknown; langs?: unknown } | null;
  };
}

export type ParsedJetstream =
  { type: 'create'; thread: RawThread; langs: string[] } | { type: 'delete'; uri: string } | null;

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,200}$/;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

export function parseJetstreamEvent(evt: JetstreamEvent, now: number): ParsedJetstream {
  const c = evt.commit;
  if (evt.kind !== 'commit' || !c || c.collection !== 'app.bsky.feed.post') return null;
  const did = typeof evt.did === 'string' ? evt.did : '';
  const rkey = typeof c.rkey === 'string' ? c.rkey : '';
  if (!DID.test(did) || !RKEY.test(rkey)) return null;
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
  if (c.operation === 'delete') return { type: 'delete', uri };
  if (c.operation !== 'create') return null;
  const text = typeof c.record?.text === 'string' ? c.record.text : '';
  if (!text.trim()) return null;
  const created = typeof c.record?.createdAt === 'string' ? Date.parse(c.record.createdAt) : NaN;
  const langs = Array.isArray(c.record?.langs)
    ? c.record.langs.filter((l): l is string => typeof l === 'string')
    : [];
  const firstLine = text.split('\n')[0]!.trim();
  return {
    type: 'create',
    langs,
    thread: {
      source: 'bluesky',
      externalId: uri,
      url: `https://bsky.app/profile/${did}/post/${rkey}`,
      title: firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine,
      text,
      // The DID, not a handle: we never resolve who is behind an account.
      author: did,
      postedAt: Number.isFinite(created) && created <= now ? created : now,
    },
  };
}

/** English or untagged posts only (the inbox and the scorer are English). */
export function isEnglish(langs: string[]): boolean {
  return langs.length === 0 || langs.some((l) => l.toLowerCase().startsWith('en'));
}

interface Matcher {
  workspaceId: string;
  compiled: CompiledPhrase[];
  day: string;
  stored: number;
}

/** Yields raw Jetstream events until `signal` aborts. Tests pass a fake. */
export type JetstreamConnect = (opts: {
  signal: AbortSignal;
  cursor: number | undefined;
  onSeq: (seq: number) => void;
  onError: (err: Error) => void;
}) => AsyncIterable<JetstreamEvent>;

export function officialJetstream(url = JETSTREAM_URL): JetstreamConnect {
  return async function* ({ signal, cursor, onError }) {
    // Loaded on first use, so an engine without Bluesky never pays for the client.
    const { Jetstream } = await import('@bsky/jetstream');
    const js = new Jetstream(url);
    let saved = cursor;
    const store = {
      load: async () => saved,
      save: async (seq: number) => {
        saved = seq;
      },
    };
    yield* js.live({
      collections: ['app.bsky.feed.post'],
      kinds: ['commit'],
      raw: true,
      cursor: store,
      signal,
      onError,
    }) as AsyncIterable<JetstreamEvent>;
  };
}

export interface BlueskyStatus {
  connected: boolean;
  workspaces: number;
  events: number;
  matched: number;
  lastEventAt: number | null;
  lastError: string | null;
}

/** The single Jetstream consumer. `refresh()` (every minute) opens or closes it. */
export class BlueskyStream {
  private matchers: Matcher[] = [];
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private seq: number | null = null;
  private seqSavedAt = 0;
  private readonly stats: BlueskyStatus = {
    connected: false,
    workspaces: 0,
    events: 0,
    matched: 0,
    lastEventAt: null,
    lastError: null,
  };

  constructor(
    private readonly ctx: AppContext,
    private readonly connect: JetstreamConnect = officialJetstream(),
    private readonly opts: { enabled: boolean } = { enabled: true },
  ) {}

  status(): BlueskyStatus {
    return { ...this.stats, workspaces: this.matchers.length };
  }

  /** Rebuilds the matchers from approved offers; connects or disconnects as needed. */
  refresh(): void {
    const { db } = this.ctx;
    const today = new Date(this.ctx.now()).toISOString().slice(0, 10);
    const next: Matcher[] = [];
    if (this.opts.enabled) {
      for (const ws of db.select({ id: workspaces.id }).from(workspaces).all()) {
        const row = db
          .select({ enabled: conversationSources.enabled })
          .from(conversationSources)
          .where(
            and(
              eq(conversationSources.workspaceId, ws.id),
              eq(conversationSources.source, 'bluesky'),
            ),
          )
          .get();
        if (row && !row.enabled) continue;
        const offers = approvedOffers(db, ws.id);
        if (!offers.length) continue;
        const prev = this.matchers.find((m) => m.workspaceId === ws.id);
        next.push({
          workspaceId: ws.id,
          compiled: compileOffers(offers),
          day: today,
          stored: prev && prev.day === today ? prev.stored : 0,
        });
      }
    }
    this.matchers = next;
    if (next.length && !this.running) this.open();
    if (!next.length && this.running) this.close();
  }

  private open(): void {
    const abort = new AbortController();
    this.abort = abort;
    const savedRow = this.ctx.db
      .select()
      .from(engineState)
      .where(eq(engineState.key, CURSOR_KEY))
      .get();
    const saved = savedRow?.value as { seq?: number } | undefined;
    const cursor =
      savedRow &&
      typeof saved?.seq === 'number' &&
      savedRow.updatedAt > this.ctx.now() - CURSOR_MAX_AGE_MS
        ? saved.seq
        : undefined;
    this.stats.connected = true;
    this.running = (async () => {
      try {
        for await (const evt of this.connect({
          signal: abort.signal,
          cursor,
          onSeq: (s) => (this.seq = s),
          onError: (err) => (this.stats.lastError = maskSecrets(err.message).slice(0, 200)),
        })) {
          this.handle(evt);
          if (abort.signal.aborted) break;
        }
      } catch (err) {
        if (!abort.signal.aborted)
          this.stats.lastError = maskSecrets((err as Error).message).slice(0, 200);
      } finally {
        this.saveCursor(true);
        this.stats.connected = false;
        this.running = null;
        this.abort = null;
      }
    })();
  }

  private close(): void {
    this.abort?.abort();
  }

  async stop(): Promise<void> {
    this.matchers = [];
    this.close();
    await this.running;
  }

  /** Handles one event; exported behaviour is tested through a fake connection. */
  handle(evt: JetstreamEvent): void {
    const now = this.ctx.now();
    this.stats.events++;
    this.stats.lastEventAt = now;
    if (typeof evt.seq === 'number') this.seq = evt.seq;
    this.saveCursor(false);
    const parsed = parseJetstreamEvent(evt, now);
    if (!parsed) return;
    if (parsed.type === 'delete') {
      deleteBySourceId(this.ctx.db, 'bluesky', parsed.uri);
      return;
    }
    if (!isEnglish(parsed.langs)) return;
    const text = parsed.thread.text;
    const lowered = text.toLowerCase();
    const today = new Date(now).toISOString().slice(0, 10);
    for (const m of this.matchers) {
      if (m.day !== today) {
        m.day = today;
        m.stored = 0;
      }
      if (m.stored >= BLUESKY_MATCHES_PER_DAY) continue;
      if (!matchText(m.compiled, text, lowered)) continue;
      const r = ingestThreads(this.ctx.db, m.workspaceId, m.compiled, [parsed.thread], now);
      if (r.inserted) {
        m.stored++;
        this.stats.matched++;
      }
    }
  }

  private saveCursor(force: boolean): void {
    const now = this.ctx.now();
    if (this.seq === null || (!force && now - this.seqSavedAt < 30_000)) return;
    this.seqSavedAt = now;
    this.ctx.db
      .insert(engineState)
      .values({ key: CURSOR_KEY, value: { seq: this.seq }, updatedAt: now })
      .onConflictDoUpdate({
        target: engineState.key,
        set: { value: { seq: this.seq }, updatedAt: now },
      })
      .run();
  }
}

/** The Bluesky adapter's `stream()` (SPEC §5.3): one consumer for the whole engine. */
export const blueskySource = {
  id: 'bluesky' as const,
  stream: (ctx: AppContext, connect?: JetstreamConnect, opts?: { enabled: boolean }) =>
    new BlueskyStream(ctx, connect, opts),
};
