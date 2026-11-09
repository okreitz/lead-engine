import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('binds to loopback on the spec ports by default', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.enginePort).toBe(4501);
    expect(config.collectorPort).toBe(4511);
    expect(path.isAbsolute(config.dbPath)).toBe(true);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      LE_HOST: '0.0.0.0',
      LE_ENGINE_PORT: '5001',
      LE_DB_PATH: '/data/le.db',
    });
    expect(config).toMatchObject({ host: '0.0.0.0', enginePort: 5001, dbPath: '/data/le.db' });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ LE_COLLECTOR_PORT: '99999' })).toThrow();
  });
});
