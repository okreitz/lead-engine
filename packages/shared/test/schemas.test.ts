import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_BODY_LIMIT_BYTES,
  PORTS,
  collectVisitSchema,
  healthSchema,
} from '../src/index.ts';

describe('constants', () => {
  it('uses the ports from the spec', () => {
    expect(PORTS).toEqual({ web: 4500, engine: 4501, collector: 4511 });
    expect(COLLECTOR_BODY_LIMIT_BYTES).toBe(2048);
  });
});

describe('collectVisitSchema', () => {
  const valid = { siteKey: 'site_12345678', path: '/pricing', at: 1_700_000_000_000 };

  it('accepts a minimal visit', () => {
    expect(collectVisitSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unknown fields', () => {
    expect(collectVisitSchema.safeParse({ ...valid, ip: '1.2.3.4' }).success).toBe(false);
  });

  it('rejects an over-long path', () => {
    expect(collectVisitSchema.safeParse({ ...valid, path: '/'.repeat(600) }).success).toBe(false);
  });
});

describe('healthSchema', () => {
  it('parses a health response', () => {
    expect(healthSchema.parse({ status: 'ok', service: 'engine', version: '0.0.0' }).service).toBe(
      'engine',
    );
  });
});
