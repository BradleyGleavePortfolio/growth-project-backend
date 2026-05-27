/**
 * Nudge v1 — NudgeEngine gate tests.
 *
 * Asserts the five gates fire in order and that exactly one terminal
 * NudgeLog row is written per process() call.
 */

import { NudgeEngineService } from '../src/notifications/nudges/nudge-engine.service';
import {
  NudgeCandidate,
  NudgeStatus,
  NudgeTriggerType,
} from '../src/notifications/nudges/nudge.types';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

interface FakeLogRow {
  id: string;
  user_id: string;
  trigger_type: string;
  signal_key: string;
  status: string;
  channels: string[];
  attempted_at: Date;
  sent_at: Date | null;
  deferred_until: Date | null;
  cap_bucket: Date | null;
}

function makeFakePrisma(prefs: Record<string, unknown> = {}) {
  const logs: FakeLogRow[] = [];
  let nextId = 1;
  return {
    logs,
    prisma: {
      nudgeLog: {
        create: jest.fn(async ({ data, select }: any) => {
          const dup = logs.find(
            (l) =>
              l.user_id === data.user_id &&
              l.trigger_type === data.trigger_type &&
              l.signal_key === data.signal_key,
          );
          if (dup) {
            const err: any = new PrismaClientKnownRequestError(
              'duplicate',
              { code: 'P2002', clientVersion: 'x' } as any,
            );
            throw err;
          }
          const row: FakeLogRow = {
            id: `log-${nextId++}`,
            user_id: data.user_id,
            trigger_type: data.trigger_type,
            signal_key: data.signal_key,
            status: data.status,
            channels: [],
            attempted_at: data.attempted_at ?? new Date(),
            sent_at: null,
            deferred_until: null,
            cap_bucket: null,
          };
          logs.push(row);
          return select?.id ? { id: row.id } : row;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = logs.find((l) => l.id === where.id);
          if (!row) throw new Error(`row ${where.id} missing`);
          // Enforce the @@unique([user_id, cap_bucket]) constraint: if
          // this update would set cap_bucket to a value another row
          // already holds for the same user, raise P2002 — same way the
          // real DB would. NULL is treated as distinct (PG default).
          if (data.cap_bucket != null) {
            const collision = logs.find(
              (l) =>
                l.id !== row.id &&
                l.user_id === row.user_id &&
                l.cap_bucket != null &&
                l.cap_bucket.getTime() === (data.cap_bucket as Date).getTime(),
            );
            if (collision) {
              const err: any = new PrismaClientKnownRequestError(
                'cap_bucket duplicate',
                { code: 'P2002', clientVersion: 'x' } as any,
              );
              throw err;
            }
          }
          Object.assign(row, data);
          return row;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          return (
            logs.find(
              (l) =>
                l.user_id === where.user_id &&
                l.status === where.status &&
                l.sent_at != null &&
                where.sent_at?.gte != null &&
                l.sent_at >= where.sent_at.gte &&
                (where.id?.not ? l.id !== where.id.not : true),
            ) ?? null
          );
        }),
        findMany: jest.fn(async () => []),
      },
      user: {
        findUnique: jest.fn(async () => ({
          email: 'jane@example.com',
          name: 'Jane Doe',
          expo_push_token: null,
        })),
      },
      notification: {
        create: jest.fn(async ({ data }: any) => ({ id: 'n-1', ...data })),
      },
      notificationPreferences: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(),
        update: jest.fn(),
      },
    },
    prefs,
  };
}

function fakeNotifications(prefs: Record<string, unknown>) {
  return {
    getPreferences: jest.fn(async () => prefs),
    createNotification: jest.fn(async (input: any) => ({ id: 'n-1', ...input })),
    pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
  };
}

const defaultPrefs = {
  muted: false,
  timezone: 'America/Los_Angeles',
  nudge_missed_checkin_inapp: true,
  nudge_missed_checkin_push: true,
  nudge_missed_checkin_email: false,
  // Streak-broken trigger maps to 'practice_paused' columns per the schema doctrine.
  nudge_practice_paused_inapp: true,
  nudge_practice_paused_push: true,
  nudge_practice_paused_email: false,
  nudge_onboarding_abandoned_inapp: true,
  nudge_onboarding_abandoned_push: true,
  nudge_onboarding_abandoned_email: true,
  nudge_inactive_inapp: true,
  nudge_inactive_push: true,
  nudge_inactive_email: true,
};

// Force "now" into a known mid-day local instant in LA so the quiet-hours
// gate does not interfere unless a test explicitly targets it.
// 2026-05-08 18:00:00 UTC = 11am LA local (PDT, UTC-7). Safely inside 8am–9pm.
const NOON_LA_UTC = new Date('2026-05-08T18:00:00Z');

function baseCandidate(
  overrides: Partial<NudgeCandidate> = {},
): NudgeCandidate {
  return {
    user_id: 'user-1',
    trigger_type: NudgeTriggerType.MISSED_CHECKIN,
    signal_key: 'missed_checkin:2026-05-08',
    context: { first_name: 'Jane' },
    ...overrides,
  };
}

describe('NudgeEngineService — five gates', () => {
  it('delivers to inapp + push when prefs allow (sent)', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const out = await svc.process(baseCandidate(), NOON_LA_UTC);

    expect(out.status).toBe(NudgeStatus.SENT);
    expect(out.channels.sort()).toEqual(['inapp', 'push']);
    expect(notifs.createNotification).toHaveBeenCalledTimes(1);
    expect(notifs.pushToUser).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('sent');
    expect(logs[0].sent_at).toBeTruthy();
  });

  it('suppresses when global mute is on', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs, muted: true });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const out = await svc.process(baseCandidate(), NOON_LA_UTC);

    expect(out.status).toBe(NudgeStatus.SUPPRESSED_MUTED);
    expect(out.channels).toEqual([]);
    expect(notifs.createNotification).not.toHaveBeenCalled();
    expect(notifs.pushToUser).not.toHaveBeenCalled();
    expect(logs[0].status).toBe('suppressed_muted');
  });

  it('suppresses when per-trigger opt-out flips all channels off', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({
      ...defaultPrefs,
      nudge_missed_checkin_inapp: false,
      nudge_missed_checkin_push: false,
      nudge_missed_checkin_email: false,
    });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const out = await svc.process(baseCandidate(), NOON_LA_UTC);

    expect(out.status).toBe(NudgeStatus.SUPPRESSED_OPT_OUT);
    expect(notifs.createNotification).not.toHaveBeenCalled();
    expect(logs[0].status).toBe('suppressed_opt_out');
  });

  it('opt-out is independent per trigger', async () => {
    const { prisma } = makeFakePrisma();
    // Streak-broken muted; missed-checkin still on.
    const notifs = fakeNotifications({
      ...defaultPrefs,
      nudge_practice_paused_inapp: false,
      nudge_practice_paused_push: false,
      nudge_practice_paused_email: false,
    });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const a = await svc.process(
      baseCandidate({
        trigger_type: NudgeTriggerType.MISSED_CHECKIN,
        signal_key: 'missed_checkin:a',
      }),
      NOON_LA_UTC,
    );
    // Second candidate would normally be capped, but cap is across triggers;
    // we test cap separately. Here we just want to assert opt-out independence:
    // use a different user.
    const b = await svc.process(
      {
        user_id: 'user-2',
        trigger_type: NudgeTriggerType.STREAK_BROKEN,
        signal_key: 'streak_broken:a',
      },
      NOON_LA_UTC,
    );

    expect(a.status).toBe(NudgeStatus.SENT);
    expect(b.status).toBe(NudgeStatus.SUPPRESSED_OPT_OUT);
  });

  it('48h frequency cap suppresses a second nudge across trigger types', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    // First send: missed_checkin → sent.
    const first = await svc.process(
      baseCandidate({
        trigger_type: NudgeTriggerType.MISSED_CHECKIN,
        signal_key: 'missed_checkin:day1',
      }),
      NOON_LA_UTC,
    );
    expect(first.status).toBe(NudgeStatus.SENT);

    // Second candidate, different trigger, 1h later → cap.
    const oneHourLater = new Date(NOON_LA_UTC.getTime() + 60 * 60 * 1000);
    const second = await svc.process(
      {
        user_id: 'user-1',
        trigger_type: NudgeTriggerType.STREAK_BROKEN,
        signal_key: 'streak_broken:day1',
      },
      oneHourLater,
    );
    expect(second.status).toBe(NudgeStatus.SUPPRESSED_CAP);

    // Third candidate, 49h later → window expired → sends again.
    const past48h = new Date(NOON_LA_UTC.getTime() + 49 * 60 * 60 * 1000);
    const third = await svc.process(
      {
        user_id: 'user-1',
        trigger_type: NudgeTriggerType.INACTIVE,
        signal_key: 'inactive:day3',
      },
      past48h,
    );
    expect(third.status).toBe(NudgeStatus.SENT);

    // Three log rows: sent / suppressed_cap / sent.
    expect(logs.map((l) => l.status)).toEqual([
      'sent',
      'suppressed_cap',
      'sent',
    ]);
  });

  it('quiet hours defer the candidate instead of dropping it', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    // 2026-05-08 06:00 UTC = 11pm prior day LA (PDT, UTC-7). Inside quiet hours.
    const quietUtc = new Date('2026-05-08T06:00:00Z');
    const out = await svc.process(baseCandidate(), quietUtc);

    expect(out.status).toBe(NudgeStatus.DEFERRED);
    expect(out.deferred_until).toBeTruthy();
    // 8am local PDT = 15:00 UTC same date.
    expect(out.deferred_until!.toISOString()).toBe('2026-05-08T15:00:00.000Z');
    expect(notifs.createNotification).not.toHaveBeenCalled();
    expect(logs[0].status).toBe('deferred');
    expect(logs[0].deferred_until).toBeTruthy();
  });

  it('quiet hours at 3am local rolls forward to same-day 8am', async () => {
    const { prisma } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    // 2026-05-08 10:00 UTC = 3am LA same date. Defer to today 8am local
    // = 15:00 UTC.
    const earlyMorningUtc = new Date('2026-05-08T10:00:00Z');
    const out = await svc.process(baseCandidate(), earlyMorningUtc);

    expect(out.status).toBe(NudgeStatus.DEFERRED);
    expect(out.deferred_until!.toISOString()).toBe('2026-05-08T15:00:00.000Z');
  });

  it('idempotency: duplicate signal_key returns suppressed_dedupe and writes no second row', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const candidate = baseCandidate();
    const first = await svc.process(candidate, NOON_LA_UTC);
    expect(first.status).toBe(NudgeStatus.SENT);

    const second = await svc.process(candidate, NOON_LA_UTC);
    expect(second.status).toBe(NudgeStatus.SUPPRESSED_DEDUPE);
    expect(logs).toHaveLength(1);
  });

  it('writes exactly one NudgeLog row per process() — no silent drops', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs, muted: true });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    await svc.process(baseCandidate(), NOON_LA_UTC);
    await svc.process(baseCandidate({ signal_key: 'b' }), NOON_LA_UTC);
    await svc.process(baseCandidate({ signal_key: 'c' }), NOON_LA_UTC);

    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.status === 'suppressed_muted')).toBe(true);
  });

  it('per-channel toggle: email-only opt-out still permits inapp + push', async () => {
    const { prisma } = makeFakePrisma();
    const notifs = fakeNotifications({
      ...defaultPrefs,
      nudge_onboarding_abandoned_email: false,
    });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const out = await svc.process(
      {
        user_id: 'u',
        trigger_type: NudgeTriggerType.ONBOARDING_ABANDONED,
        signal_key: 'onb:1',
      },
      NOON_LA_UTC,
    );

    expect(out.status).toBe(NudgeStatus.SENT);
    expect(out.channels.sort()).toEqual(['inapp', 'push']);
  });

  // ─── P1-2 refix: atomic cap reservation ──────────────────────────────────
  // The pre-refix read-side cap could let two concurrent triggers slip
  // through because both could observe "no sent row yet" before either
  // wrote. The unique (user_id, cap_bucket) index forces serialization
  // at the DB — exactly one delivery, one suppressed_cap.
  it('concurrent triggers for the same user collide on cap_bucket: exactly one sent + one suppressed_cap', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    // Fire two different-trigger candidates concurrently. Both pass the
    // dedupe, mute, opt-out and read-side cap gates; only one wins the
    // atomic cap_bucket reservation.
    const results = await Promise.all([
      svc.process(
        {
          user_id: 'user-1',
          trigger_type: NudgeTriggerType.MISSED_CHECKIN,
          signal_key: 'missed_checkin:concurrent',
        },
        NOON_LA_UTC,
      ),
      svc.process(
        {
          user_id: 'user-1',
          trigger_type: NudgeTriggerType.STREAK_BROKEN,
          signal_key: 'streak_broken:concurrent',
        },
        NOON_LA_UTC,
      ),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([NudgeStatus.SENT, NudgeStatus.SUPPRESSED_CAP].sort());

    // Both NudgeLog rows exist; one carries a non-null cap_bucket, the
    // other has cap_bucket=null (DB rejected the reservation).
    expect(logs).toHaveLength(2);
    const withBucket = logs.filter((l) => l.cap_bucket != null);
    expect(withBucket).toHaveLength(1);
    expect(withBucket[0].status).toBe('sent');
    const withoutBucket = logs.filter((l) => l.cap_bucket == null);
    expect(withoutBucket[0].status).toBe('suppressed_cap');
  });

  it('cap_bucket is NOT reserved for non-sent terminals (mute / opt-out / dedupe / defer)', async () => {
    // A muted user's row should leave cap_bucket null so a future
    // un-mute does not see a phantom "cap held" state.
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs, muted: true });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    await svc.process(baseCandidate(), NOON_LA_UTC);
    expect(logs[0].status).toBe('suppressed_muted');
    expect(logs[0].cap_bucket).toBeNull();
  });

  // ─── P2-4 refix: reprocessDeferred + processExisting coverage ────────────
  it('reprocessDeferred re-runs a quiet-hours-deferred row through the gates and delivers when window opens', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    // First pass at 3am local LA: deferred to 8am.
    const earlyMorning = new Date('2026-05-08T10:00:00Z');
    const deferred = await svc.process(baseCandidate(), earlyMorning);
    expect(deferred.status).toBe(NudgeStatus.DEFERRED);
    expect(deferred.deferred_until!.toISOString()).toBe('2026-05-08T15:00:00.000Z');

    // Wire up findMany so reprocessDeferred can see the row.
    (prisma as any).nudgeLog.findMany = jest.fn(async ({ where }: any) => {
      const due = logs.filter(
        (l) =>
          l.status === where.status &&
          l.deferred_until != null &&
          where.deferred_until?.lte != null &&
          l.deferred_until <= where.deferred_until.lte,
      );
      return due.map((l) => ({
        id: l.id,
        user_id: l.user_id,
        trigger_type: l.trigger_type,
        signal_key: l.signal_key,
      }));
    });

    // Run at 8:01am local LA — deferred_until has elapsed.
    const eightOhOne = new Date('2026-05-08T15:01:00Z');
    const count = await svc.reprocessDeferred(eightOhOne);
    expect(count).toBe(1);

    // The row that was deferred is now SENT and holds the cap bucket.
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('sent');
    expect(logs[0].cap_bucket).not.toBeNull();
  });

  it('reprocessDeferred skips a deferred row when its trigger has since been opted out', async () => {
    const { prisma, logs } = makeFakePrisma();
    // First defer the row under nudge-friendly prefs.
    let currentPrefs: Record<string, unknown> = { ...defaultPrefs };
    const notifs = {
      getPreferences: jest.fn(async () => currentPrefs),
      createNotification: jest.fn(async (input: any) => ({ id: 'n', ...input })),
      pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
    };
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const earlyMorning = new Date('2026-05-08T10:00:00Z');
    const deferred = await svc.process(baseCandidate(), earlyMorning);
    expect(deferred.status).toBe(NudgeStatus.DEFERRED);

    // User opts out of missed_checkin between the defer and the reprocess.
    currentPrefs = {
      ...defaultPrefs,
      nudge_missed_checkin_email: false,
      nudge_missed_checkin_push: false,
      nudge_missed_checkin_inapp: false,
    };

    (prisma as any).nudgeLog.findMany = jest.fn(async ({ where }: any) => {
      const due = logs.filter(
        (l) =>
          l.status === where.status &&
          l.deferred_until != null &&
          where.deferred_until?.lte != null &&
          l.deferred_until <= where.deferred_until.lte,
      );
      return due.map((l) => ({
        id: l.id,
        user_id: l.user_id,
        trigger_type: l.trigger_type,
        signal_key: l.signal_key,
      }));
    });

    const eightOhOne = new Date('2026-05-08T15:01:00Z');
    const count = await svc.reprocessDeferred(eightOhOne);
    expect(count).toBe(1);

    // Row finalises as suppressed_opt_out, no cap_bucket reserved.
    expect(logs[0].status).toBe('suppressed_opt_out');
    expect(logs[0].cap_bucket).toBeNull();
  });

  it('reprocessDeferred is idempotent: a re-run after success is a no-op', async () => {
    const { prisma, logs } = makeFakePrisma();
    const notifs = fakeNotifications({ ...defaultPrefs });
    const svc = new NudgeEngineService(prisma as any, notifs as any);

    const earlyMorning = new Date('2026-05-08T10:00:00Z');
    await svc.process(baseCandidate(), earlyMorning);

    (prisma as any).nudgeLog.findMany = jest.fn(async ({ where }: any) =>
      logs
        .filter(
          (l) =>
            l.status === where.status &&
            l.deferred_until != null &&
            where.deferred_until?.lte != null &&
            l.deferred_until <= where.deferred_until.lte,
        )
        .map((l) => ({
          id: l.id,
          user_id: l.user_id,
          trigger_type: l.trigger_type,
          signal_key: l.signal_key,
        })),
    );

    const eightOhOne = new Date('2026-05-08T15:01:00Z');
    expect(await svc.reprocessDeferred(eightOhOne)).toBe(1);
    // Row is now status='sent' — not 'deferred'. Second call finds nothing.
    expect(await svc.reprocessDeferred(eightOhOne)).toBe(0);
  });
});
