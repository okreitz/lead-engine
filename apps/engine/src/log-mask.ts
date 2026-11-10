/**
 * Masks anything that looks like a key or token before it reaches logs, job errors or API
 * responses (SPEC §10 "Logs mask anything that looks like a key or token").
 */
const PATTERNS: RegExp[] = [
  /\b(sk-ant-[A-Za-z0-9_-]{8,})/g, // Anthropic keys
  /\b(le_(?:sess|tok)_[A-Za-z0-9_-]{8,})/g, // our own session and API tokens
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|token|secret|password|authorization|x-api-key)["']?\s*[:=]\s*["']?)[^\s"'&,;]{4,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g, // long opaque strings (hex/base64 keys)
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: string) =>
      typeof prefix === 'string' && /[:=\s]$/.test(prefix) ? `${prefix}***` : '***',
    );
  }
  return out;
}

/** Pino redaction paths for the engine logger. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.key',
  '*.apiKey',
  '*.token',
];
