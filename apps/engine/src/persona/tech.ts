/**
 * Optional technographics (SPEC §5.1 step 3): `httpx -td` over homepages through the command
 * registry. Only homepages the crawler already fetched (robots.txt allowed) are passed, at a
 * low rate with our User-Agent. Without the binary the step is skipped cleanly. No Chromium.
 */
import { runCommand } from '../commands.ts';
import { USER_AGENT } from '../crawler/crawler.ts';

export interface TechDetector {
  /** Null when the detector can't run here, with the reason. */
  unavailable(): Promise<string | null>;
  /** Technologies per input URL. */
  detect(urls: string[]): Promise<Map<string, string[]>>;
}

export const HTTPX_ARGS = [
  '-silent',
  '-json',
  '-td',
  '-duc',
  '-nc',
  '-timeout',
  '10',
  '-rl',
  '2',
  '-t',
  '2',
  '-H',
  `User-Agent: ${USER_AGENT}`,
] as const;

/** Parses httpx JSON lines: `input` is the target we sent, `tech` is omitted when empty. */
export function parseHttpxOutput(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const row = JSON.parse(t) as { input?: unknown; tech?: unknown };
      if (typeof row.input !== 'string') continue;
      const tech = Array.isArray(row.tech)
        ? row.tech.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 80))
        : [];
      out.set(row.input, [...new Set(tech)].slice(0, 50));
    } catch {
      // ignore partial lines
    }
  }
  return out;
}

export function httpxDetector(): TechDetector {
  let availability: Promise<string | null> | null = null;
  return {
    unavailable() {
      availability ??= runCommand('httpx', ['-version'])
        .then((r) =>
          r.exitCode === 0 && /version/i.test(r.stdout + r.stderr)
            ? null
            : 'httpx (projectdiscovery) is not installed in the engine container',
        )
        .catch(() => 'httpx (projectdiscovery) is not installed in the engine container');
      return availability;
    },
    async detect(urls) {
      if (!urls.length) return new Map();
      const r = await runCommand('httpx', [...HTTPX_ARGS], { input: urls.join('\n') });
      return parseHttpxOutput(r.stdout);
    },
  };
}
