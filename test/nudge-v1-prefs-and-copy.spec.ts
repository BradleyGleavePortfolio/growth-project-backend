/**
 * Nudge v1 — preferences integration + copy tone tests.
 *
 * 1. The four new opt-out flags surface through getPreferences defaults.
 * 2. updatePreferences accepts the new flags and persists each one.
 * 3. nudgeCopyFor() never emits guilt vocabulary or exclamation marks.
 */

import { NotificationsService } from '../src/notifications/notifications.service';
import { nudgeCopyFor } from '../src/notifications/nudges/copy';
import { NudgeTriggerType } from '../src/notifications/nudges/nudge.types';

// ── Prisma mock — same shape as notification-prefs.spec.ts ──
const storedPrefs = new Map<string, Record<string, unknown>>();

const mockPrisma = {
  notificationPreferences: {
    findUnique: jest.fn(({ where }: any) =>
      Promise.resolve(storedPrefs.get(where.user_id) ?? null),
    ),
    update: jest.fn(({ where, data }: any) => {
      const existing = storedPrefs.get(where.user_id) ?? {};
      const updated = { ...existing, ...data };
      storedPrefs.set(where.user_id, updated);
      return Promise.resolve(updated);
    }),
    create: jest.fn(({ data }: any) => {
      storedPrefs.set(data.user_id as string, { ...data });
      return Promise.resolve(data);
    }),
  },
  notification: {
    create: jest.fn().mockResolvedValue({ id: 'n-1' }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
} as any;

let svc: NotificationsService;
beforeEach(() => {
  storedPrefs.clear();
  jest.clearAllMocks();
  svc = new NotificationsService(mockPrisma);
});

describe('NotificationsService — Nudge v1 preference defaults', () => {
  it('returns the four new opt-out flags in defaults', async () => {
    const prefs = (await svc.getPreferences('new-user')) as Record<
      string,
      unknown
    >;
    expect(prefs.nudge_missed_checkin_inapp).toBe(true);
    expect(prefs.nudge_practice_paused_inapp).toBe(true);
    expect(prefs.nudge_onboarding_abandoned_inapp).toBe(true);
    expect(prefs.nudge_inactive_inapp).toBe(true);
    // Missed-checkin email defaults OFF (spec: low-tier transactional email).
    expect(prefs.nudge_missed_checkin_email).toBe(false);
    // Onboarding-abandoned email defaults ON (we want the user to come back).
    expect(prefs.nudge_onboarding_abandoned_email).toBe(true);
  });

  it('accepts each new flag through updatePreferences', async () => {
    await svc.updatePreferences('u1', {
      nudge_missed_checkin_inapp: false,
      nudge_practice_paused_push: false,
      nudge_onboarding_abandoned_email: false,
      nudge_inactive_inapp: false,
    });
    const row = storedPrefs.get('u1') as Record<string, unknown>;
    expect(row.nudge_missed_checkin_inapp).toBe(false);
    expect(row.nudge_practice_paused_push).toBe(false);
    expect(row.nudge_onboarding_abandoned_email).toBe(false);
    expect(row.nudge_inactive_inapp).toBe(false);
  });

  it('preserves unrelated flags on a partial nudge update', async () => {
    storedPrefs.set('u1', {
      user_id: 'u1',
      milestone_push: true,
      digest_email: true,
      nudge_missed_checkin_inapp: true,
    });
    await svc.updatePreferences('u1', { nudge_missed_checkin_inapp: false });
    const row = storedPrefs.get('u1') as Record<string, unknown>;
    expect(row.nudge_missed_checkin_inapp).toBe(false);
    expect(row.milestone_push).toBe(true);
    expect(row.digest_email).toBe(true);
  });

  it('createNotification respects nudge per-trigger opt-out via _kindToPrefsPrefix', async () => {
    storedPrefs.set('u1', {
      user_id: 'u1',
      muted: false,
      // Schema column for the streak_broken trigger is named
      // 'nudge_practice_paused_inapp' (doctrine: no 'streak_' substring
      // in schema.prisma). _kindToPrefsPrefix routes the kind there.
      nudge_practice_paused_inapp: false,
    });
    const res = await svc.createNotification({
      user_id: 'u1',
      kind: 'nudge_streak_broken' as any,
      body: 'test',
      channel: 'inapp',
    });
    expect(res).toBeNull();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });
});

describe('nudgeCopyFor — tone discipline', () => {
  const triggers: NudgeTriggerType[] = [
    NudgeTriggerType.MISSED_CHECKIN,
    NudgeTriggerType.STREAK_BROKEN,
    NudgeTriggerType.ONBOARDING_ABANDONED,
    NudgeTriggerType.INACTIVE,
  ];

  it('produces copy for every trigger', () => {
    for (const t of triggers) {
      const c = nudgeCopyFor(t, { first_name: 'Jane' });
      expect(c.body.length).toBeGreaterThan(0);
      expect(c.body.length).toBeLessThanOrEqual(160);
      expect(c.pushTitle.length).toBeGreaterThan(0);
      expect(c.deepLink.startsWith('tgp://')).toBe(true);
    }
  });

  it('never uses exclamation marks (calm-tone rule)', () => {
    for (const t of triggers) {
      const c = nudgeCopyFor(t, { first_name: 'Jane' });
      expect(c.body).not.toMatch(/!/);
      expect(c.pushTitle).not.toMatch(/!/);
    }
  });

  it('never uses guilt vocabulary', () => {
    // Forbidden vocabulary list. "missed" appears in the trigger NAME but
    // must not appear in user-facing copy (we say "quiet" instead).
    const forbidden = /\b(missed|forgot|gone|broke your|lost your|abandon)\b/i;
    for (const t of triggers) {
      const c = nudgeCopyFor(t, { first_name: 'Jane' });
      expect(c.body).not.toMatch(forbidden);
      expect(c.pushTitle).not.toMatch(forbidden);
    }
  });

  it('never reveals a streak number', () => {
    const numbery = /\b\d+[- ]?(day|days|week|weeks)\b/i;
    for (const t of triggers) {
      const c = nudgeCopyFor(t, { first_name: 'Jane' });
      expect(c.body).not.toMatch(numbery);
    }
  });

  it('renders gracefully without a first name', () => {
    for (const t of triggers) {
      const c = nudgeCopyFor(t);
      expect(c.body).not.toMatch(/Hi ,/); // no stray comma after greeting
      expect(c.body).not.toMatch(/, your/i); // no orphan "name, your" — name was missing
    }
  });
});
