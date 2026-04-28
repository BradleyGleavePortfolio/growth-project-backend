import { GdprScrubService } from '../src/users/gdpr-scrub.service';
import { AuditAction } from '../src/audit/audit.service';
import { DELETION_GRACE_PERIOD_DAYS } from '../src/users/account.service';

// PII-scrub worker tests. The worker is the second half of the GDPR
// delete lifecycle and writes `deleted_at`/zeroes out identifying
// columns. These tests pin:
//
//   - Cutoff arithmetic: a user 29 days into the grace window is NOT a
//     candidate; one 30+ days in IS.
//   - Dry-run never writes.
//   - Real run tombstones email + name + phone + supabase_id, sets
//     `deleted_at` AND `archived_at`, and writes exactly one
//     `user.account_deleted` audit row per scrubbed user with the
//     original email captured in metadata.
//   - One bad user does not poison the rest of the batch.

const DAY_MS = 24 * 60 * 60 * 1000;

function buildPrisma(seedUsers: any[]) {
  const state: { users: any[]; profiles: Record<string, any> } = {
    users: seedUsers.map((u) => ({ ...u })),
    profiles: {},
  };

  const userTable = {
    findMany: jest.fn(async ({ where, take, orderBy }: any) => {
      let rows = state.users.filter((u) => {
        if (u.deleted_at) return false;
        if (!u.deletion_scheduled_at) return false;
        const cutoff = where?.deletion_scheduled_at?.lte;
        if (cutoff && u.deletion_scheduled_at > cutoff) return false;
        return true;
      });
      if (orderBy?.deletion_scheduled_at === 'asc') {
        rows.sort(
          (a, b) =>
            a.deletion_scheduled_at.getTime() -
            b.deletion_scheduled_at.getTime(),
        );
      }
      return rows.slice(0, take ?? rows.length).map((u) => ({
        id: u.id,
        email: u.email,
        deletion_scheduled_at: u.deletion_scheduled_at,
      }));
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const idx = state.users.findIndex((u) => u.id === where.id);
      if (idx < 0) throw new Error(`user not found ${where.id}`);
      Object.assign(state.users[idx], data);
      return state.users[idx];
    }),
  };

  const userProfile = {
    updateMany: jest.fn(async ({ where, data }: any) => {
      const profile = state.profiles[where.user_id];
      if (profile) Object.assign(profile, data);
      return { count: profile ? 1 : 0 };
    }),
  };

  const notificationPreferences = {
    updateMany: jest.fn(async () => ({ count: 0 })),
  };

  const $transaction = jest.fn(async (cb: any) =>
    cb({ user: userTable, userProfile, notificationPreferences }),
  );

  return {
    state,
    user: userTable,
    userProfile,
    notificationPreferences,
    $transaction,
  };
}

function buildAudit() {
  return { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any;
}

describe('GdprScrubService', () => {
  const NOW = new Date('2026-04-28T12:00:00.000Z');
  const TWENTY_NINE_DAYS_AGO = new Date(NOW.getTime() - 29 * DAY_MS);
  const THIRTY_ONE_DAYS_AGO = new Date(NOW.getTime() - 31 * DAY_MS);
  const FORTY_DAYS_AGO = new Date(NOW.getTime() - 40 * DAY_MS);

  const baseUsers = () => [
    {
      id: 'u-fresh',
      email: 'fresh@example.test',
      name: 'Fresh User',
      phone: '555-0001',
      supabase_id: 'sup-fresh',
      deletion_scheduled_at: TWENTY_NINE_DAYS_AGO,
      deleted_at: null,
      archived_at: null,
    },
    {
      id: 'u-ripe',
      email: 'ripe@example.test',
      name: 'Ripe User',
      phone: '555-0002',
      supabase_id: 'sup-ripe',
      deletion_scheduled_at: THIRTY_ONE_DAYS_AGO,
      deleted_at: null,
      archived_at: null,
    },
    {
      id: 'u-old',
      email: 'old@example.test',
      name: 'Old User',
      phone: '555-0003',
      supabase_id: 'sup-old',
      deletion_scheduled_at: FORTY_DAYS_AGO,
      deleted_at: null,
      archived_at: null,
    },
    {
      id: 'u-already-scrubbed',
      email: 'deleted-prev@scrub.invalid',
      name: 'Deleted user',
      phone: null,
      supabase_id: 'deleted-prev',
      deletion_scheduled_at: FORTY_DAYS_AGO,
      deleted_at: new Date(NOW.getTime() - 10 * DAY_MS),
      archived_at: new Date(NOW.getTime() - 10 * DAY_MS),
    },
    {
      id: 'u-not-scheduled',
      email: 'active@example.test',
      name: 'Active User',
      phone: '555-0004',
      supabase_id: 'sup-active',
      deletion_scheduled_at: null,
      deleted_at: null,
      archived_at: null,
    },
  ];

  it('selects only users past the 30-day cutoff (oldest first), skipping fresh and already-scrubbed', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const svc = new GdprScrubService(prisma, buildAudit());
    const candidates = await svc.findCandidates(NOW, 100);
    expect(candidates.map((c) => c.user_id)).toEqual(['u-old', 'u-ripe']);
    // Verifies the cutoff math is exactly grace-period days, not "29.x".
    expect(candidates[0].scheduled_for_purge_at.getTime()).toBe(
      candidates[0].deletion_scheduled_at.getTime() +
        DELETION_GRACE_PERIOD_DAYS * DAY_MS,
    );
  });

  it('dry-run reports candidates without writing or auditing', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const audit = buildAudit();
    const svc = new GdprScrubService(prisma, audit);
    const report = await svc.run({ dryRun: true, now: NOW });
    expect(report.dry_run).toBe(true);
    expect(report.scrubbed).toBe(0);
    expect(report.considered).toBe(2);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('real run tombstones PII and writes one audit row per scrubbed user', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const audit = buildAudit();
    const svc = new GdprScrubService(prisma, audit);

    const report = await svc.run({ dryRun: false, now: NOW });
    expect(report.dry_run).toBe(false);
    expect(report.scrubbed).toBe(2);
    expect(report.errors).toEqual([]);

    const scrubbedRipe = prisma.state.users.find((u: any) => u.id === 'u-ripe');
    expect(scrubbedRipe.email).toBe('deleted-u-ripe@scrub.invalid');
    expect(scrubbedRipe.name).toBe('Deleted user');
    expect(scrubbedRipe.phone).toBeNull();
    expect(scrubbedRipe.supabase_id).toBe('deleted-u-ripe');
    expect(scrubbedRipe.archived_at).toEqual(NOW);
    expect(scrubbedRipe.deleted_at).toEqual(NOW);

    // Fresh user untouched.
    const fresh = prisma.state.users.find((u: any) => u.id === 'u-fresh');
    expect(fresh.email).toBe('fresh@example.test');
    expect(fresh.deleted_at).toBeNull();

    // One audit row per scrubbed user, action and metadata pinned.
    expect(audit.write).toHaveBeenCalledTimes(2);
    const calls = audit.write.mock.calls.map((c: any[]) => c[0]);
    expect(calls.every((c: any) => c.action === AuditAction.USER_ACCOUNT_DELETED)).toBe(true);
    expect(calls.every((c: any) => c.metadata.scope === 'gdpr_scrub_worker')).toBe(true);
    // Original email captured in metadata for forensic traceability —
    // operators can map a tombstoned id back to the legal request.
    expect(
      calls.find((c: any) => c.targetUserId === 'u-ripe').metadata
        .original_email_snapshot,
    ).toBe('ripe@example.test');
  });

  it('attributes cron-driven runs to actor=null + actorRole=system', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const audit = buildAudit();
    const svc = new GdprScrubService(prisma, audit);
    await svc.run({ dryRun: false, now: NOW });
    const first = audit.write.mock.calls[0][0];
    expect(first.actorId).toBeNull();
    expect(first.actorRole).toBe('system');
  });

  it('attributes operator-triggered runs to the OWNER who invoked them', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const audit = buildAudit();
    const svc = new GdprScrubService(prisma, audit);
    await svc.run({
      dryRun: false,
      now: NOW,
      actorUserId: 'owner-1',
      actorEmail: 'owner@example.test',
    });
    const first = audit.write.mock.calls[0][0];
    expect(first.actorId).toBe('owner-1');
    expect(first.actorRole).toBe('owner');
    expect(first.actorEmail).toBe('owner@example.test');
  });

  it('records per-user errors without short-circuiting the batch', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const audit = buildAudit();
    // Make the first scrub fail with a transaction error; the second
    // still runs to completion. Mirrors the real-world case where one
    // user has a stray FK that needs operator intervention.
    let firstSeen = false;
    prisma.$transaction.mockImplementation(async (cb: any) => {
      if (!firstSeen) {
        firstSeen = true;
        throw new Error('simulated tx failure for first candidate');
      }
      return cb({
        user: prisma.user,
        userProfile: prisma.userProfile,
        notificationPreferences: prisma.notificationPreferences,
      });
    });
    const svc = new GdprScrubService(prisma, audit);
    const report = await svc.run({ dryRun: false, now: NOW });
    expect(report.considered).toBe(2);
    expect(report.scrubbed).toBe(1);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0].user_id).toBe('u-old');
    // Only the surviving candidate gets an audit row.
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  it('clamps batch limit to [1, 1000]', async () => {
    const prisma: any = buildPrisma(baseUsers());
    const svc = new GdprScrubService(prisma, buildAudit());
    await svc.run({ dryRun: true, now: NOW, limit: -5 });
    expect(prisma.user.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    await svc.run({ dryRun: true, now: NOW, limit: 99999 });
    expect(prisma.user.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1000 }),
    );
  });
});
