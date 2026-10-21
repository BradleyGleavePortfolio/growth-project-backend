/**
 * RENEWAL-BE: the plan-renewal cadence, the end-date rule, the push wiring
 * (kind, lock-screen line, the client's switch) and the flag gate on every
 * route. The database behaviour (who gets a sequence, each step once per
 * channel, the stop rules, row security) is test/rls/plan-renewal-rls.spec.ts.
 */
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckoutController } from '../src/checkout/checkout.controller';
import type { CheckoutService } from '../src/checkout/checkout.service';
import {
  isPlanRenewalEnabled,
  PLAN_RENEWAL_DAY_MS,
  PLAN_RENEWAL_STEPS,
  planRenewalPopupStepAt,
  planRenewalStepFor,
} from '../src/checkout/plan-renewal/plan-renewal.cadence';
import {
  PlanRenewalAckDto,
  PlanRenewalController,
  PlanRenewalSettingsDto,
} from '../src/checkout/plan-renewal/plan-renewal.controller';
import { planEndedAt, type PlanRenewalService } from '../src/checkout/plan-renewal/plan-renewal.service';
import { NO_RENEWAL } from '../src/checkout/plan-renewal/plan-renewal.state';
import { NotificationKind } from '../src/notifications/notification-kind';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { notificationPrefsPrefix, pushAllowedByPreferences } from '../src/notifications/push/push-preferences';
import { pushTapData } from '../src/notifications/notifications.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { stub } from './utils/trial-fakes';

const day = (n: number) => n * PLAN_RENEWAL_DAY_MS;
const req = (id: string) => stub<AuthedRequest>({ user: { id, role: 'student' } });
const withFlag = async (value: string | undefined, fn: () => Promise<void> | void) => {
  const before = process.env.FEATURE_PLAN_RENEWAL;
  if (value === undefined) delete process.env.FEATURE_PLAN_RENEWAL;
  else process.env.FEATURE_PLAN_RENEWAL = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.FEATURE_PLAN_RENEWAL;
    else process.env.FEATURE_PLAN_RENEWAL = before;
  }
};

describe('RENEWAL-BE cadence', () => {
  it('is Day 0, 1, 3, 7: pop-ups on 0, 3, 7, a coach message on 0 and 7, an app notification every step', () => {
    expect(PLAN_RENEWAL_STEPS.map((s) => [s.day, s.popup, s.push, s.message])).toEqual([
      [0, true, true, true],
      [1, false, true, false],
      [3, true, true, false],
      [7, true, true, true],
    ]);
  });

  it('the latest due step for the time since the plan ended; nothing before Day 0 and nothing new after Day 7', () => {
    expect(planRenewalStepFor(-1)).toBe(-1);
    expect([0, day(1) - 1, day(1), day(3) - 1, day(3), day(7) - 1, day(7), day(30)].map(planRenewalStepFor))
      .toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('the pop-up due at a step is the latest pop-up step at or before it (Day 1 keeps Day 0)', () => {
    expect([-1, 0, 1, 2, 3].map(planRenewalPopupStepAt)).toEqual([-1, 0, 0, 2, 3]);
  });

  it('the flag is on only for "true"', () => {
    expect(['true', 'TRUE', 'false', '1', ''].map((v) => isPlanRenewalEnabled({ FEATURE_PLAN_RENEWAL: v })))
      .toEqual([true, true, false, false, false]);
    expect(isPlanRenewalEnabled({})).toBe(false);
  });
});

describe('RENEWAL-BE end date', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const at = (iso: string | null) => (iso ? new Date(iso) : null);
  const p = (billing_type: string, access: string | null, canceled: string | null, periodEnd: string | null) => ({
    id: 'p', client_user_id: 'c', coach_user_id: 'k', billing_type,
    access_expires_at: at(access), canceled_at: at(canceled), current_period_end: at(periodEnd),
  });

  it('a package ends on its last day; a subscription cancelled at period end ends at the period end', () => {
    expect(planEndedAt(p('one_time', '2026-10-20T09:00:00Z', null, null), now)).toEqual(at('2026-10-20T09:00:00Z'));
    expect(planEndedAt(p('recurring', null, '2026-10-01T10:00:00Z', '2026-10-19T10:00:00Z'), now))
      .toEqual(at('2026-10-19T10:00:00Z'));
  });

  it('a subscription cancelled at once ends when it was cancelled, even with a period end still ahead', () => {
    expect(planEndedAt(p('recurring', null, '2026-10-20T08:00:00Z', '2026-11-05T08:00:00Z'), now))
      .toEqual(at('2026-10-20T08:00:00Z'));
    expect(planEndedAt(p('recurring', null, null, null), now)).toBeNull();
  });
});

describe('RENEWAL-BE app notification', () => {
  it('kind plan_renewal: fixed lock-screen line (no names), opens Home through the deep link', () => {
    expect(NotificationKind.PLAN_RENEWAL).toBe('plan_renewal');
    expect(lockScreenCopy(NotificationKind.PLAN_RENEWAL, 'Sam Coach wrote something private', null)).toEqual({
      title: 'Your plan',
      body: 'Your plan has ended. Open the app to see your options.',
    });
    expect(pushTapData(NotificationKind.PLAN_RENEWAL, 'tgp://home', undefined)).toEqual({
      actionScreen: 'NotificationCenter',
      deepLink: 'tgp://home',
    });
  });

  it('quiet hours: a renewal push due at 23:00 New York waits for 08:00 there; it is never urgent', () => {
    const late = new Date('2026-10-22T03:00:00Z'); // 23:00 EDT
    expect(quietHoursFor({ kind: NotificationKind.PLAN_RENEWAL, timeZone: 'America/New_York', now: late })).toEqual({
      deliverAt: new Date('2026-10-22T12:00:00Z'), deferred: true, reason: 'quiet_hours',
    });
    expect(quietHoursFor({ kind: NotificationKind.PLAN_RENEWAL, timeZone: 'Asia/Tokyo', now: late }).deferred).toBe(false);
  });

  it('the client\'s "plan renewal reminders" switch (default on) and the global mute both stop it', () => {
    expect(notificationPrefsPrefix(NotificationKind.PLAN_RENEWAL)).toBe('plan_renewal');
    expect(pushAllowedByPreferences({ plan_renewal_push: true }, NotificationKind.PLAN_RENEWAL)).toBe(true);
    expect(pushAllowedByPreferences({}, NotificationKind.PLAN_RENEWAL)).toBe(true);
    expect(pushAllowedByPreferences({ plan_renewal_push: false }, NotificationKind.PLAN_RENEWAL)).toBe(false);
    expect(pushAllowedByPreferences({ plan_renewal_push: true, muted: true }, NotificationKind.PLAN_RENEWAL)).toBe(false);
    // Turning renewal reminders off leaves every other kind alone.
    expect(pushAllowedByPreferences({ plan_renewal_push: false }, NotificationKind.MESSAGE_RECEIVED)).toBe(true);
  });
});

describe('RENEWAL-BE routes and the flag', () => {
  const service = {
    ackPopup: jest.fn(async () => ({ renewal: NO_RENEWAL })),
    coachSettings: jest.fn(async () => ({ messages_enabled: true })),
    setCoachSettings: jest.fn(async (_id: string, on: boolean) => ({ messages_enabled: on })),
  };
  const routes = new PlanRenewalController(stub<PlanRenewalService>(service));
  const checkout = {
    hasActiveEntitlement: jest.fn(async () => false),
    planRenewal: jest.fn(async () => ({ ...NO_RENEWAL, state: 'revoked', coach: { id: 'k', first_name: 'Sam' } })),
  };
  const entitlement = new CheckoutController(stub<CheckoutService>(checkout));
  beforeEach(() => jest.clearAllMocks());

  it('flag off: every renewal route is 404 PLAN_RENEWAL_OFF and the entitlement answer is exactly as before', async () => {
    await withFlag(undefined, async () => {
      for (const call of [() => routes.ack(req('c'), { step: 0 }), () => routes.settings(req('k')),
        () => routes.setSettings(req('k'), { messages_enabled: false })]) {
        let thrown: unknown;
        try {
          await call();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(NotFoundException);
        expect((thrown as NotFoundException).getResponse()).toMatchObject({ code: 'PLAN_RENEWAL_OFF' });
      }
      expect(await entitlement.checkEntitlement(req('c'))).toEqual({ active: false, entitlement_active: false });
      expect(service.ackPopup).not.toHaveBeenCalled();
      expect(service.setCoachSettings).not.toHaveBeenCalled();
      expect(checkout.planRenewal).not.toHaveBeenCalled();
    });
  });

  it('flag on: the routes reach the service with the caller\'s own id; the entitlement answer adds the renewal block', async () => {
    await withFlag('true', async () => {
      await routes.ack(req('c'), { step: 3 });
      expect(service.ackPopup).toHaveBeenCalledWith('c', 3);
      expect(await routes.setSettings(req('k'), { messages_enabled: false })).toEqual({ messages_enabled: false });
      expect(service.setCoachSettings).toHaveBeenCalledWith('k', false);
      expect(await entitlement.checkEntitlement(req('c'), undefined, 'k')).toEqual({
        active: false,
        entitlement_active: false,
        renewal: { ...NO_RENEWAL, state: 'revoked', coach: { id: 'k', first_name: 'Sam' } },
      });
      expect(checkout.planRenewal).toHaveBeenCalledWith('c', 'k');
    });
  });

  it('request shapes: the ack step is an integer; the coach switch is a boolean', async () => {
    const errors = async (cls: new () => object, plain: object) =>
      (await validate(plainToInstance(cls, plain))).map((e) => e.property);
    expect(await errors(PlanRenewalAckDto, { step: 3 })).toEqual([]);
    expect(await errors(PlanRenewalAckDto, { step: '3' })).toEqual(['step']);
    expect(await errors(PlanRenewalAckDto, {})).toEqual(['step']);
    expect(await errors(PlanRenewalSettingsDto, { messages_enabled: false })).toEqual([]);
    expect(await errors(PlanRenewalSettingsDto, { messages_enabled: 'no' })).toEqual(['messages_enabled']);
  });
});
