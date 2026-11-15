/**
 * Streaming record readers for dataset files. They read text chunks and yield one record at a
 * time, so memory stays flat however large the file is (CLAUDE.md memory budget).
 * - CSV with a header row; the delimiter (`,` `|` or tab) is taken from the header line.
 *   Quoted fields may contain delimiters, doubled quotes and newlines.
 * - JSON lines (one object per line).
 * - `jsonArrayRows`: rows of a `{ "fields": [...], "data": [[...], ...] }` document
 *   (SEC EDGAR's company_tickers_exchange.json), parsed row by row.
 */

export type RawRecord = Record<string, unknown>;

/** Yields header-keyed records (keys lower-cased) from CSV or JSON-lines text. */
export async function* readRecords(chunks: AsyncIterable<string>): AsyncGenerator<RawRecord> {
  const it = chunks[Symbol.asyncIterator]();
  let first = '';
  // Peek far enough to see the first line.
  while (!first.includes('\n')) {
    const n = await it.next();
    if (n.done) break;
    first += n.value;
  }
  const rest: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => {
      let sentFirst = false;
      return {
        next: async () => {
          if (!sentFirst) {
            sentFirst = true;
            return { done: false, value: first };
          }
          return it.next();
        },
      };
    },
  };
  const start = first.replace(/^\uFEFF/, '').trimStart();
  if (start.startsWith('{')) {
    yield* jsonLines(rest);
    return;
  }
  const headerLine = start.split('\n')[0] ?? '';
  const delimiter = detectDelimiter(headerLine);
  let header: string[] | null = null;
  for await (const fields of csvRows(rest, delimiter)) {
    if (!header) {
      header = fields.map((h) =>
        h
          .replace(/^\uFEFF/, '')
          .trim()
          .toLowerCase(),
      );
      continue;
    }
    if (fields.length === 1 && fields[0] === '') continue; // blank line
    const rec: RawRecord = {};
    for (let i = 0; i < header.length; i++) rec[header[i]!] = fields[i] ?? '';
    yield rec;
  }
}

export function detectDelimiter(line: string): string {
  const counts = [',', '|', '\t'].map((d) => [d, line.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 1 ? counts[0]![0] : ',';
}

/** RFC 4180-style CSV rows from chunks; tolerant of \r\n and stray quotes mid-field. */
export async function* csvRows(
  chunks: AsyncIterable<string>,
  delimiter = ',',
): AsyncGenerator<string[]> {
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let quotePending = false; // saw a quote inside a quoted field; next char decides
  let any = false;
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      any = true;
      if (inQuotes) {
        if (quotePending) {
          quotePending = false;
          if (c === '"') {
            field += '"';
            continue;
          }
          inQuotes = false; // closing quote; fall through to handle c normally
        } else if (c === '"') {
          quotePending = true;
          continue;
        } else {
          field += c;
          continue;
        }
      }
      if (c === '"' && field === '') inQuotes = true;
      else if (c === delimiter) {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
        yield row;
        row = [];
        field = '';
        any = false;
      } else field += c;
    }
  }
  if (quotePending) inQuotes = false;
  if (any || field || row.length) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    yield row;
  }
}

async function* lines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}

/** JSON lines; unparsable lines yield `{ __invalid: true }` so they are counted, not fatal. */
async function* jsonLines(chunks: AsyncIterable<string>): AsyncGenerator<RawRecord> {
  for await (const line of lines(chunks)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      yield v && typeof v === 'object' && !Array.isArray(v)
        ? (v as RawRecord)
        : { __invalid: true };
    } catch {
      yield { __invalid: true };
    }
  }
}

/**
 * Rows of `{ "fields": [..], "data": [[..], ..] }` as field-keyed records, scanning the text
 * once. Only one row is held in memory at a time.
 */
export async function* jsonArrayRows(chunks: AsyncIterable<string>): AsyncGenerator<RawRecord> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastKey = '';
  let token = ''; // current string token at depth 1 (a key candidate)
  let capture: 'fields' | 'row' | null = null;
  let captured = '';
  let captureDepth = 0;
  let inData = false;
  let fields: string[] = [];
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (capture) captured += c;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        else if (depth === 1 && !capture) token += c;
        continue;
      }
      if (c === '"') {
        inString = true;
        if (depth === 1 && !capture) token = '';
        continue;
      }
      if (c === ':' && depth === 1) {
        lastKey = token;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        if (depth === 2 && lastKey === 'fields' && !capture) {
          capture = 'fields';
          captured = c;
          captureDepth = 2;
        } else if (depth === 2 && lastKey === 'data') {
          inData = true;
        } else if (depth === 3 && inData && !capture) {
          capture = 'row';
          captured = c;
          captureDepth = 3;
        }
        continue;
      }
      if (c === ']' || c === '}') {
        if (capture && depth === captureDepth) {
          const value = JSON.parse(captured) as unknown[];
          if (capture === 'fields') fields = value.map(String);
          else {
            const rec: RawRecord = {};
            value.forEach((v, j) => (rec[fields[j] ?? String(j)] = v));
            yield rec;
          }
          capture = null;
          captured = '';
        }
        if (depth === 2 && inData) inData = false;
        depth--;
      }
    }
  }
}
