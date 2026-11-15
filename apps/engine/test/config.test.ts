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

  it('treats empty variables from compose (`${VAR:-}`) as unset', () => {
    const config = loadConfig({
      LE_SEC_USER_AGENT: '',
      LE_COLLECTOR_URL: '',
      LE_IPINFO_TOKEN: '',
      LE_LOG_LEVEL: '',
    });
    expect(config.secUserAgent).toBeNull();
    expect(config.logLevel).toBe('info');
    expect(config.collector).toMatchObject({
      publicUrl: 'http://127.0.0.1:4511',
      ipinfoToken: null,
      clientIpHeader: 'x-real-ip',
      geoDownload: true,
    });
  });

  it('reads the collector settings', () => {
    const config = loadConfig({
      LE_HOST: '0.0.0.0',
      LE_COLLECTOR_URL: 'https://collect.example.com/',
      LE_DB_PATH: '/data/le.db',
    });
    expect(config.collector.publicUrl).toBe('https://collect.example.com');
    expect(config.collector.geoDir).toBe('/data/geo');
  });
});
