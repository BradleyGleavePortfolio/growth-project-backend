import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

// S-SCHED-5: single-runner lease for scheduling sweeps that must not run on
// more than one Fly machine at a time (the request-expiry sweep). Same rule
// as the S-FEE CronLease (backend #627), on its own table so the two PRs do
// not collide: one row per job in "SchedulingJobLease", acquired by a single
// conditional statement so two machines racing for the same expired lease
// cannot both win.
//   1. UPDATE ... WHERE name = $job AND lease_until < now (take over an
//      expired or released lease). Under READ COMMITTED the second UPDATE
//      re-checks the WHERE after the first commits and matches zero rows.
//   2. If no row exists yet, INSERT; the primary key makes a concurrent
//      second INSERT fail with P2002, which is reported as "held".
// The lease expires on its own (ttl), so a crashed machine never blocks the
// job for longer than one ttl. Session advisory locks are not used: they are
// unsafe behind the Supabase transaction pooler.

export type LeaseOutcome = { acquired: true; until: Date } | { acquired: false };

@Injectable()
export class SchedulingJobLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  async tryAcquire(
    name: string,
    holder: string,
    ttlMs: number,
    now: Date = new Date(),
  ): Promise<LeaseOutcome> {
    const until = new Date(now.getTime() + ttlMs);
    const taken = await this.prisma.schedulingJobLease.updateMany({
      where: { name, lease_until: { lt: now } },
      data: { holder, lease_until: until, acquired_at: now },
    });
    if (taken.count === 1) return { acquired: true, until };
    try {
      await this.prisma.schedulingJobLease.create({
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
    await this.prisma.schedulingJobLease.updateMany({
      where: { name, holder },
      data: { lease_until: now },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
