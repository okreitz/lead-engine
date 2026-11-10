/**
 * AES-256-GCM encryption for workspace provider keys (SPEC §2, CLAUDE.md "Secrets").
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). The additional authenticated data binds
 * each ciphertext to its workspace and provider, so a row copied to another workspace or
 * provider fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class MasterKeyMissingError extends Error {
  override name = 'MasterKeyMissingError';
  constructor() {
    super('LE_MASTER_KEY is not set; provider keys cannot be stored or read');
  }
}

function aad(workspaceId: string, provider: string): Buffer {
  return Buffer.from(`${workspaceId}:${provider}`, 'utf8');
}

export function encryptSecret(
  masterKey: Buffer | null,
  workspaceId: string,
  provider: string,
  plaintext: string,
): string {
  if (!masterKey) throw new MasterKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(aad(workspaceId, provider));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(
  masterKey: Buffer | null,
  workspaceId: string,
  provider: string,
  encoded: string,
): string {
  if (!masterKey) throw new MasterKeyMissingError();
  const [version, iv, tag, ct] = encoded.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error('unrecognised secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64url'));
  decipher.setAAD(aad(workspaceId, provider));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
