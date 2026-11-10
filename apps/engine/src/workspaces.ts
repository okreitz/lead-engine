import { DEFAULT_MONTHLY_BUDGET_USD, DEFAULT_STAGES } from '@le/shared';
import { eq } from 'drizzle-orm';
import type { Tx } from './db/client.ts';
import { memberships, workspaces, type WorkspaceSettings } from './db/schema.ts';
import { newId, slugify } from './ids.ts';

/** Creates a workspace with the caller as owner. Run inside a transaction. */
export function createWorkspace(
  tx: Tx,
  input: { name: string; ownerUserId: string; now: number },
): string {
  const id = newId('ws');
  const base = slugify(input.name);
  let slug = base;
  for (let i = 2; tx.select().from(workspaces).where(eq(workspaces.slug, slug)).get(); i++) {
    slug = `${base}-${i}`;
  }
  const settings: WorkspaceSettings = { stages: [...DEFAULT_STAGES] };
  tx.insert(workspaces)
    .values({
      id,
      name: input.name,
      slug,
      allowedCountries: ['US'],
      monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
      settings,
      createdAt: input.now,
    })
    .run();
  tx.insert(memberships)
    .values({ userId: input.ownerUserId, workspaceId: id, role: 'owner' })
    .run();
  return id;
}

export function getWorkspace(tx: Tx, id: string) {
  const ws = tx.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new Error(`workspace ${id} not found`);
  return ws;
}

/** Pipeline stages for a workspace, defaulting to SPEC §6. */
export function stagesOf(settings: WorkspaceSettings): string[] {
  return settings.stages?.length ? settings.stages : [...DEFAULT_STAGES];
}
