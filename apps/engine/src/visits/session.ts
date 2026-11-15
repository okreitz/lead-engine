/**
 * `sessionHash` = HMAC-SHA256(daily salt, site + IP + user agent) (SPEC §5.2 "Stored data").
 * The salt is random per UTC day and stored only for that day: when the day changes, the old
 * salt is deleted, so yesterday's hashes can't be recomputed or linked to today's.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { dailySalts } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class SessionHasher {
  private day: string | null = null;
  private salt: Buffer | null = null;

  constructor(private readonly db: Db) {}

  private saltFor(day: string): Buffer {
    if (this.day === day && this.salt) return this.salt;
    const row = this.db.select().from(dailySalts).where(eq(dailySalts.day, day)).get();
    let salt: string;
    if (row) salt = row.salt;
    else {
      salt = randomBytes(32).toString('base64');
      this.db.insert(dailySalts).values({ day, salt }).onConflictDoNothing().run();
      salt = this.db.select().from(dailySalts).where(eq(dailySalts.day, day)).get()!.salt;
    }
    this.db.delete(dailySalts).where(ne(dailySalts.day, day)).run();
    this.day = day;
    this.salt = Buffer.from(salt, 'base64');
    return this.salt;
  }

  hash(siteId: string, ip: string, userAgent: string, now: number): string {
    return createHmac('sha256', this.saltFor(utcDay(now)))
      .update(`${siteId}\n${ip}\n${userAgent}`)
      .digest('hex')
      .slice(0, 32);
  }
}
