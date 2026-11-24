/**
 * The approved offers of a workspace. A workspace can sell several offers (funnels), e.g. a
 * consulting business and a product; each offer has at most one approved version at a time.
 * Streams use every approved offer: conversations search all their intent phrases, and each
 * thread, site, persona run and account is tied to one offer and scored against its ICP.
 */
import { offerProfileSchema, type OfferProfile } from '@le/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { offers, offerVersions } from '../db/schema.ts';

export interface ApprovedOffer {
  /** The approved offer version's id (persona runs reference the version). */
  id: string;
  offerId: string;
  name: string;
  profile: OfferProfile;
  approvedAt: number;
}

/** Every offer's approved version, most recently approved first. */
export function approvedOffers(tx: Tx, workspaceId: string): ApprovedOffer[] {
  const rows = tx
    .select({
      id: offerVersions.id,
      offerId: offerVersions.offerId,
      data: offerVersions.data,
      approvedAt: offerVersions.approvedAt,
      name: offers.name,
    })
    .from(offerVersions)
    .innerJoin(offers, eq(offers.id, offerVersions.offerId))
    .where(and(eq(offerVersions.workspaceId, workspaceId), eq(offerVersions.status, 'approved')))
    .orderBy(desc(offerVersions.approvedAt))
    .all();
  const out: ApprovedOffer[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.offerId)) continue;
    const parsed = offerProfileSchema.safeParse(r.data);
    if (!parsed.success) continue;
    seen.add(r.offerId);
    out.push({
      id: r.id,
      offerId: r.offerId,
      name: r.name || parsed.data.name,
      profile: parsed.data,
      approvedAt: r.approvedAt ?? 0,
    });
  }
  return out;
}

/**
 * One approved offer: the given offer's, or (without an id) the most recently approved one.
 * A given offer that isn't approved (or belongs to another workspace) gives null.
 */
export function approvedOffer(
  tx: Tx,
  workspaceId: string,
  offerId?: string | null,
): ApprovedOffer | null {
  const all = approvedOffers(tx, workspaceId);
  if (offerId) return all.find((o) => o.offerId === offerId) ?? null;
  return all[0] ?? null;
}

/** The offer an account, thread or site should use: its own when approved, else the default. */
export function offerFor(
  tx: Tx,
  workspaceId: string,
  offerId: string | null | undefined,
): ApprovedOffer | null {
  return (
    (offerId ? approvedOffer(tx, workspaceId, offerId) : null) ?? approvedOffer(tx, workspaceId)
  );
}
