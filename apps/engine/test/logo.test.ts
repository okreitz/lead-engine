import { SESSION_COOKIE } from '@le/shared';
import { describe, expect, it } from 'vitest';
import { sniffImageType } from '../src/api/routes/workspaces.ts';
import { clientFor, setupClient } from './helpers.ts';

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`;

describe('workspace logo', () => {
  it('stores a PNG, serves it with safe headers and reports its version in /auth/me', async () => {
    const c = await setupClient();
    expect((await c.get('/api/v1/auth/me')).body.workspace.logoUpdatedAt).toBeNull();
    expect((await c.get('/api/v1/workspace/logo')).status).toBe(404);

    const put = await c.send('PUT', '/api/v1/workspace/logo', { dataUrl: pngUrl });
    expect(put.status).toBe(200);
    const me = await c.get('/api/v1/auth/me');
    expect(me.body.workspace.logoUpdatedAt).toBe(put.body.logoUpdatedAt);

    const res = await c.app.inject({
      method: 'GET',
      url: '/api/v1/workspace/logo',
      cookies: { [SESSION_COOKIE]: c.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.rawPayload.equals(PNG)).toBe(true);

    expect((await c.send('DELETE', '/api/v1/workspace/logo')).status).toBe(200);
    expect((await c.get('/api/v1/workspace/logo')).status).toBe(404);
  });

  it('refuses SVG, mislabelled files and oversized images', async () => {
    const c = await setupClient();
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
    expect((await c.send('PUT', '/api/v1/workspace/logo', { dataUrl: svg })).status).toBe(400);
    const fakePng = `data:image/png;base64,${Buffer.from('<html>not an image</html>').toString('base64')}`;
    expect((await c.send('PUT', '/api/v1/workspace/logo', { dataUrl: fakePng })).status).toBe(400);
    const asJpeg = `data:image/jpeg;base64,${PNG.toString('base64')}`;
    expect((await c.send('PUT', '/api/v1/workspace/logo', { dataUrl: asJpeg })).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
    const bigUrl = `data:image/png;base64,${big.toString('base64')}`;
    expect((await c.send('PUT', '/api/v1/workspace/logo', { dataUrl: bigUrl })).status).toBe(400);
  });

  it('only owners change the logo, and members see their own workspace logo', async () => {
    const owner = await setupClient();
    await owner.send('POST', '/api/v1/workspace/members', {
      email: 'member@example.com',
      password: 'member password 123',
    });
    const login = await owner.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.com', password: 'member password 123' },
    });
    const member = clientFor(
      owner.app,
      owner.ctx,
      login.cookies.find((x) => x.name === SESSION_COOKIE)!.value,
      login.json().csrfToken,
    );
    expect((await member.send('PUT', '/api/v1/workspace/logo', { dataUrl: pngUrl })).status).toBe(
      403,
    );
    await owner.send('PUT', '/api/v1/workspace/logo', { dataUrl: pngUrl });
    expect((await member.get('/api/v1/workspace/logo')).status).toBe(200);
    expect((await member.send('DELETE', '/api/v1/workspace/logo')).status).toBe(403);
  });

  it('does not serve one workspace logo to another workspace', async () => {
    const c = await setupClient();
    await c.send('PUT', '/api/v1/workspace/logo', { dataUrl: pngUrl });
    const created = await c.send('POST', '/api/v1/workspaces', { name: 'Other' });
    expect(created.status).toBe(201);
    expect((await c.get('/api/v1/workspace/logo')).status).toBe(404);
    expect((await c.get('/api/v1/auth/me')).body.workspace.logoUpdatedAt).toBeNull();
  });

  it('sniffs PNG, JPEG and WebP by their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
  });
});
