/**
 * Minimal RFC 4180 CSV parser and writer (no dependency). The writer guards against
 * spreadsheet formula injection by prefixing cells that start with = + - @ tab or CR.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      if (ch === '\r' && src[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** Parses with a header row into objects keyed by normalised header (lower case, `_`). */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
  return rows.map((r) => Object.fromEntries(keys.map((k, idx) => [k, (r[idx] ?? '').trim()])));
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return (
    [
      columns.map(cell).join(','),
      ...rows.map((r) => columns.map((c) => cell(r[c])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
