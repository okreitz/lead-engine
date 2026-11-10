import { hash, verify } from '@node-rs/argon2';

// argon2id with the OWASP-recommended minimum (m=19 MiB, t=2, p=1); the library default
// algorithm is argon2id, set explicitly so a library change can't weaken it.
const OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A real hash to verify against when the user doesn't exist, so timing doesn't reveal it. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password-placeholder');
  await verifyPassword(await dummyHash, password);
}
