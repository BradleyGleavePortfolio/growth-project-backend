import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// S-FEE — single-runner lease for scheduled jobs that must not run on more
// than one Fly machine at a time (the settlement / payout sweep).
//
// The codebase has no advisory-lock helper, and session advisory locks are
// unsafe behind the Supabase pooler, so the lease is one row per job in
// "CronLease". Acquisition is a single conditional statement, so two
// machines racing for the same expired lease cannot both win:
//   1. UPDATE ... WHERE name = $job AND lease_until < now()  (take over an
//      expired or released lease). Under READ COMMITTED the second UPDATE
//      re-checks the WHERE after the first commits and matches zero rows.
//   2. If no row exists yet, INSERT; the primary key makes a concurrent
//      second INSERT fail with P2002, which is reported as "held".
// The lease expires on its own (ttl), so a crashed machine never blocks the
// job for longer than one ttl.

export type LeaseOutcome = { acquired: true; until: Date } | { acquired: false };

@Injectable()
export class CronLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  async tryAcquire(
    name: string,
    holder: string,
    ttlMs: number,
    now: Date = new Date(),
  ): Promise<LeaseOutcome> {
    const until = new Date(now.getTime() + ttlMs);
    const taken = await this.prisma.cronLease.updateMany({
      where: { name, lease_until: { lt: now } },
      data: { holder, lease_until: until, acquired_at: now },
    });
    if (taken.count === 1) return { acquired: true, until };
    try {
      await this.prisma.cronLease.create({
        data: { name, holder, lease_until: until, acquired_at: now },
      });
      return { acquired: true, until };
    } catch (err) {
      if (isUniqueViolation(err)) return { acquired: false };
      throw err;
    }
  }

  /** Release early; only the current holder can release. */
  async release(name: string, holder: string, now: Date = new Date()): Promise<void> {
    await this.prisma.cronLease.updateMany({
      where: { name, holder },
      data: { lease_until: now },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
