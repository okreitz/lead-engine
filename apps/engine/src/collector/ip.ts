/**
 * IP helpers for the collector. Every address is handled as a 128-bit value (IPv4 as the
 * IPv4-mapped ::ffff:a.b.c.d), so prefixes of both families compare as 32-digit hex strings.
 */
import { isIP } from 'node:net';

const V4_MAPPED = 0xffff00000000n;

/** Normalises an address: strips an IPv6 zone and unwraps IPv4-mapped IPv6. Null if invalid. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

function v4ToBig(ip: string): bigint {
  return ip.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function v6ToBig(ip: string): bigint {
  let s = ip;
  // Trailing dotted IPv4 (e.g. ::ffff:1.2.3.4 or 64:ff9b::1.2.3.4).
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = v4ToBig(dotted[1]!);
    s = `${s.slice(0, -dotted[1]!.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups =
    tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

/** The address as a 128-bit integer (IPv4 mapped into ::ffff:0:0/96). */
export function ipToBig(ip: string): bigint {
  return isIP(ip) === 4 ? V4_MAPPED | v4ToBig(ip) : v6ToBig(ip);
}

export function bigToHex(n: bigint): string {
  return n.toString(16).padStart(32, '0');
}

export function ipHex(ip: string): string {
  return bigToHex(ipToBig(ip));
}

function bigToIp(n: bigint, v4: boolean): string {
  if (v4) {
    const x = Number(n & 0xffffffffn);
    return [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // Compress the longest run of zero groups.
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best[1]! && j - i > 1) best = [i, j - i];
    i = j;
  }
  if (best[0]! < 0) return groups.join(':');
  const [i, len] = best as [number, number];
  return `${groups.slice(0, i).join(':')}::${groups.slice(i + len).join(':')}`;
}

export interface Prefix {
  /** CIDR in the address's own family, e.g. 203.0.113.0/24 or 2001:db8::/48. */
  cidr: string;
  /** 32-digit hex bounds over the 128-bit space. */
  start: string;
  end: string;
  /** Length in 128-bit terms (IPv4 /24 → 120). */
  len128: number;
}

/** The prefix of `len` bits (in the address's own family) that contains `ip`. */
export function prefixOf(ip: string, len: number): Prefix {
  const v4 = isIP(ip) === 4;
  const bits = v4 ? 32 : 128;
  const l = Math.max(0, Math.min(bits, len));
  const len128 = v4 ? 96 + l : l;
  const n = ipToBig(ip);
  const hostBits = BigInt(128 - len128);
  const mask = ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
  const start = n & mask;
  const end = start | ((1n << hostBits) - 1n);
  return { cidr: `${bigToIp(start, v4)}/${l}`, start: bigToHex(start), end: bigToHex(end), len128 };
}

/** Parses ipapi.is ranges like "107.174.138.128 - 107.174.138.255", or a CIDR. */
export function parseRange(
  range: string | null | undefined,
): { start: bigint; end: bigint } | null {
  if (!range) return null;
  const dash = range.split(/\s+-\s+/);
  if (dash.length === 2) {
    const a = normalizeIp(dash[0]);
    const b = normalizeIp(dash[1]);
    if (!a || !b) return null;
    return { start: ipToBig(a), end: ipToBig(b) };
  }
  const m = /^(.+)\/(\d+)$/.exec(range.trim());
  const ip = m ? normalizeIp(m[1]) : null;
  if (!m || !ip) return null;
  const p = prefixOf(ip, Number(m[2]));
  return { start: BigInt(`0x${p.start}`), end: BigInt(`0x${p.end}`) };
}

/**
 * The prefix we map a company to: a /24 (IPv6 /48) by default, narrowed to fit inside the
 * company's own registered network when that is smaller, so neighbours are never included.
 */
export function companyPrefix(ip: string, network?: string | null): Prefix {
  const v4 = isIP(ip) === 4;
  const base = v4 ? 24 : 48;
  const max = v4 ? 32 : 128;
  const range = parseRange(network);
  let len = base;
  if (range) {
    while (len < max) {
      const p = prefixOf(ip, len);
      if (BigInt(`0x${p.start}`) >= range.start && BigInt(`0x${p.end}`) <= range.end) break;
      len++;
    }
  }
  return prefixOf(ip, len);
}

/** The single address as a prefix (IPv4 /32, IPv6 /64: one subscriber). */
export function hostPrefix(ip: string): Prefix {
  return prefixOf(ip, isIP(ip) === 4 ? 32 : 64);
}

const NON_PUBLIC_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];
const NON_PUBLIC_V6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
];

function inPrefix(ip: string, base: string, len: number): boolean {
  if (isIP(ip) !== isIP(base)) return false;
  const p = prefixOf(base, len);
  const h = ipHex(ip);
  return h >= p.start && h <= p.end;
}

/** Private, loopback, CGNAT, link-local, documentation, multicast and reserved ranges. */
export function isPrivateOrReserved(ip: string): boolean {
  const list = isIP(ip) === 4 ? NON_PUBLIC_V4 : NON_PUBLIC_V6;
  return list.some(([b, l]) => inPrefix(ip, b, l));
}

/** Peers allowed to set the client-IP header: loopback and private (Docker network) only. */
export function isProxyPeer(ip: string): boolean {
  const list: [string, number][] =
    isIP(ip) === 4
      ? [
          ['127.0.0.0', 8],
          ['10.0.0.0', 8],
          ['172.16.0.0', 12],
          ['192.168.0.0', 16],
        ]
      : [
          ['::1', 128],
          ['fc00::', 7],
        ];
  return list.some(([b, l]) => inPrefix(ip, b, l));
}
