import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../src/api/server.ts';
import { buildCollector } from '../src/collector/server.ts';
import { makeCtx } from './helpers.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function track<T extends FastifyInstance>(app: T): T {
  apps.push(app);
  return app;
}

describe('engine api', () => {
  it('answers the health check', async () => {
    const api = track(buildApi(makeCtx(), { logLevel: 'silent' }));
    const res = await api.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'engine' });
  });

  it('does not serve collector routes', async () => {
    const api = track(buildApi(makeCtx(), { logLevel: 'silent' }));
    const res = await api.inject({ method: 'POST', url: '/collect/v', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('collector stub', () => {
  const visit = { siteKey: 'site_12345678', path: '/pricing', at: 1_700_000_000_000 };

  it('answers its own health check', async () => {
    const collector = track(buildCollector({ logLevel: 'silent' }));
    const res = await collector.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toMatchObject({ status: 'ok', service: 'collector' });
  });

  it('rejects bodies over 2 KB', async () => {
    const collector = track(buildCollector({ logLevel: 'silent' }));
    const res = await collector.inject({
      method: 'POST',
      url: '/collect/v',
      payload: { ...visit, path: 'x'.repeat(3000) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('rejects invalid bodies', async () => {
    const collector = track(buildCollector({ logLevel: 'silent' }));
    const res = await collector.inject({
      method: 'POST',
      url: '/collect/v',
      payload: { path: '/' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid body but stores nothing yet', async () => {
    const collector = track(buildCollector({ logLevel: 'silent' }));
    const res = await collector.inject({ method: 'POST', url: '/collect/v', payload: visit });
    expect(res.statusCode).toBe(501);
  });

  it('does not serve the authenticated api', async () => {
    const collector = track(buildCollector({ logLevel: 'silent' }));
    const res = await collector.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(404);
  });
});
