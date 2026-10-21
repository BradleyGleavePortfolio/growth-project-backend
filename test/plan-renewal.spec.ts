/**
 * RENEWAL-BE: the plan-renewal cadence (owner #RENEWAL-PUSH, OPERATOR RULING
 * 6327651587: Day 0, 1 and 7, local days), the plan-end rule, the
 * push wiring (kind, lock-screen line, button category, the client's switch)
 * and the flag gate. The database behaviour (who gets a sequence, the latest
 * plan only, each step's push once, the stop rules, row security) is
 * test/rls/plan-renewal-rls.spec.ts.
 */
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckoutController } from '../src/checkout/checkout.controller';
import type { CheckoutService } from '../src/checkout/checkout.service';
import {
  houseCoachUserId,
  isPlanRenewalEnabled,
  PLAN_RENEWAL_BANNER_DAYS,
  PLAN_RENEWAL_LAST_DAY,
  PLAN_RENEWAL_STEP_DAYS,
  planRenewalDay,
} from '../src/checkout/plan-renewal/plan-renewal.cadence';
import { PlanRenewalAckDto, PlanRenewalController } from '../src/checkout/plan-renewal/plan-renewal.controller';
import type { PlanRenewalService } from '../src/checkout/plan-renewal/plan-renewal.service';
import { NO_RENEWAL, planEndedAt } from '../src/checkout/plan-renewal/plan-renewal.state';
import { ENV_RULES } from '../src/common/env-validation';
import { NotificationKind } from '../src/notifications/notification-kind';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { pushCategoryFor } from '../src/notifications/push/push-channels';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { notificationPrefsPrefix, pushAllowedByPreferences } from '../src/notifications/push/push-preferences';
import { pushTapData } from '../src/notifications/notifications.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { stub } from './utils/trial-fakes';

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

describe('RENEWAL-BE cadence (owner #RENEWAL-PUSH)', () => {
  it('Day 0, Day 1 and Day 7: a notification and a pop-up each, the buttons on Day 7; the Home banner for 30 days', () => {
    expect([PLAN_RENEWAL_STEP_DAYS, PLAN_RENEWAL_LAST_DAY, PLAN_RENEWAL_BANNER_DAYS]).toEqual([[0, 1, 7], 7, 30]);
  });

  it('days are the client\'s local calendar days: Day 0 is the day the plan ends there', () => {
    const ended = new Date('2026-10-21T06:30:00Z'); // 23:30 on Oct 20 in Los Angeles, 15:30 on Oct 21 in Tokyo
    const la = 'America/Los_Angeles';
    expect(planRenewalDay(ended, new Date('2026-10-21T06:45:00Z'), la)).toBe(0);
    expect(planRenewalDay(ended, new Date('2026-10-21T07:05:00Z'), la)).toBe(1); // 00:05 Oct 21 there: Day 1
    expect(planRenewalDay(ended, new Date('2026-10-28T07:05:00Z'), la)).toBe(8);
    expect(planRenewalDay(ended, new Date('2026-10-27T08:00:00Z'), la)).toBe(7);
    expect(planRenewalDay(ended, new Date('2026-10-21T14:00:00Z'), 'Asia/Tokyo')).toBe(0); // 23:00 Oct 21 there
    // No usable zone known: UTC days.
    expect(planRenewalDay(ended, new Date('2026-10-21T23:59:00Z'), null)).toBe(0);
    expect(planRenewalDay(ended, new Date('2026-10-22T00:01:00Z'), null)).toBe(1);
  });

  it('the flag is on only for "true"; HOUSE_COACH_USER_ID unset or blank offers no house coach', () => {
    expect(['true', 'TRUE', 'false', '1', ''].map((v) => isPlanRenewalEnabled({ FEATURE_PLAN_RENEWAL: v })))
      .toEqual([true, true, false, false, false]);
    expect(isPlanRenewalEnabled({})).toBe(false);
    const id = '6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
    expect([houseCoachUserId({}), houseCoachUserId({ HOUSE_COACH_USER_ID: '  ' }), houseCoachUserId({ HOUSE_COACH_USER_ID: id })])
      .toEqual([null, null, id]);
    const rule = ENV_RULES.find((r) => r.name === 'HOUSE_COACH_USER_ID');
    // An inventory rule adds no validator (no boot change); an id that is not a live coach offers nothing.
    expect([rule?.tier, rule?.values, rule?.validate]).toEqual(['optional', undefined, undefined]);
  });
});

describe('RENEWAL-BE plan-end rule (LS B2: never read off the clock)', () => {
  const at = (iso: string | null) => (iso ? new Date(iso) : null);
  const p = (billing_type: string, access: string | null, canceled: string | null, periodEnd: string | null, atPeriodEnd = false) => ({
    billing_type, access_expires_at: at(access), canceled_at: at(canceled), current_period_end: at(periodEnd),
    cancel_at_period_end: atPeriodEnd,
  });

  it('a package ends on its last day; a subscription cancelled at period end ends at the period end', () => {
    expect(planEndedAt(p('one_time', '2026-10-20T09:00:00Z', null, null))).toEqual(at('2026-10-20T09:00:00Z'));
    expect(planEndedAt(p('recurring', null, '2026-10-01T10:00:00Z', '2026-10-19T10:00:00Z', true)))
      .toEqual(at('2026-10-19T10:00:00Z'));
  });

  it('a subscription cancelled at once keeps the cancel as its end, whatever its old period end was', () => {
    // Cancelled at once on Oct 1 with an unused period to Oct 20: the end is Oct 1, before and after Oct 20.
    expect(planEndedAt(p('recurring', null, '2026-10-01T08:00:00Z', '2026-10-20T08:00:00Z'))).toEqual(at('2026-10-01T08:00:00Z'));
    expect(planEndedAt(p('recurring', null, '2026-10-20T08:00:00Z', '2026-11-05T08:00:00Z'))).toEqual(at('2026-10-20T08:00:00Z'));
    expect(planEndedAt(p('recurring', null, null, '2026-11-05T08:00:00Z'))).toBeNull(); // still running
  });
});

describe('RENEWAL-BE app notifications', () => {
  it('kind plan_renewal: fixed lock-screen line (no names), tap opens Home, which opens the renewal page', () => {
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

  it('the two buttons: the push names its category; no other kind does', () => {
    expect(pushCategoryFor(NotificationKind.PLAN_RENEWAL, { categoryId: 'PLAN_RENEWAL', coach_id: 'k' }))
      .toEqual({ categoryId: 'PLAN_RENEWAL' });
    expect(pushCategoryFor(NotificationKind.PLAN_RENEWAL, { categoryId: 'PLAN_RENEWAL_COACH' })).toEqual({ categoryId: 'PLAN_RENEWAL_COACH' });
    expect(pushCategoryFor(NotificationKind.PLAN_RENEWAL, {})).toEqual({});
    expect(pushCategoryFor(NotificationKind.MESSAGE_RECEIVED, { categoryId: 'PLAN_RENEWAL' })).toEqual({});
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

describe('RENEWAL-BE route and the flag', () => {
  const service = { ackPopup: jest.fn(async () => ({ renewal: NO_RENEWAL })) };
  const routes = new PlanRenewalController(stub<PlanRenewalService>(service));
  const revoked = { ...NO_RENEWAL, state: 'revoked', coach: { id: 'k', first_name: 'Sam' } };
  const checkout = { hasActiveEntitlement: jest.fn(async () => false), planRenewal: jest.fn(async () => revoked) };
  const entitlement = new CheckoutController(stub<CheckoutService>(checkout));
  beforeEach(() => jest.clearAllMocks());

  it('flag off: the ack is 404 PLAN_RENEWAL_OFF and the entitlement answer is exactly as before', async () => {
    await withFlag(undefined, async () => {
      let thrown: unknown;
      try {
        await routes.ack(req('c'), { step: 0 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).getResponse()).toMatchObject({ code: 'PLAN_RENEWAL_OFF' });
      expect(await entitlement.checkEntitlement(req('c'))).toEqual({ active: false, entitlement_active: false });
      expect([service.ackPopup, checkout.planRenewal].map((f) => f.mock.calls.length)).toEqual([0, 0]);
    });
  });

  it('flag on: the ack reaches the service with the caller\'s own id; the entitlement answer adds the renewal block', async () => {
    await withFlag('true', async () => {
      await routes.ack(req('c'), { step: 1 });
      expect(service.ackPopup).toHaveBeenCalledWith('c', 1);
      expect(await entitlement.checkEntitlement(req('c'), undefined, 'k')).toEqual({
        active: false,
        entitlement_active: false,
        renewal: revoked,
      });
      expect(checkout.planRenewal).toHaveBeenCalledWith('c', 'k');
    });
  });

  it('request shape: the ack step is an integer', async () => {
    const errors = async (plain: object) => (await validate(plainToInstance(PlanRenewalAckDto, plain))).map((e) => e.property);
    expect([await errors({ step: 1 }), await errors({ step: '1' }), await errors({})]).toEqual([[], ['step'], ['step']]);
  });
});
