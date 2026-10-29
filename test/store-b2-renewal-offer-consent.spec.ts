/**
 * STORE-B2 (App Store guideline 4.5.4; STORE-AUDIT-S B2): the plan renewal OFFERS (the Day 1 and Day 7 app
 * notifications after a plan ends) go only to a person who said yes in the app, and Mute all stops them.
 * Everyone starts at no: no preferences row, or a row without the yes, gets no offer. A later no stops an
 * offer at enqueue and again at send time. The Day 0 notice that the plan ended keeps its rule
 * (plan_renewal_push; a money notice, so Mute all does not stop it). Only storage is stubbed: the real
 * enqueue gate (NotificationsService.sendPush), the real worker re-check (PushDeliveryService) and the real
 * sweep step (PlanRenewalService) run.
 */
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PlanRenewal } from '@prisma/client';
import { PlanRenewalService } from '../src/checkout/plan-renewal/plan-renewal.service';
import { UpdateNotificationPreferencesDto } from '../src/notifications/notifications.dto';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { ExpoPushClient, PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { muteAllStops, pushAllowedByPreferences } from '../src/notifications/push/push-preferences';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

// The sequence is running and the person is in New York (the database reads behind both live in
// test/rls/plan-renewal-rls.spec.ts); everything else is real.
jest.mock('../src/checkout/plan-renewal/plan-renewal.state', () => ({
  ...jest.requireActual('../src/checkout/plan-renewal/plan-renewal.state'),
  planRenewalBlock: jest.fn(async () => null),
  planRenewalPushStillDue: jest.fn(async () => true),
}));
jest.mock('../src/notifications/recipient-timezone', () => ({
  ...jest.requireActual('../src/notifications/recipient-timezone'),
  resolveRecipientTimeZone: jest.fn(async () => 'America/New_York'),
}));

const PLAN_RENEWAL = NotificationKind.PLAN_RENEWAL;
/** The context the sweep gives a Day 1 or Day 7 offer (push-preferences.ts RENEWAL_OFFER). */
const OFFER = { renewalOffer: true } as const;
const YES = new Date('2026-05-30T15:00:00Z');
const TOKEN = 'ExponentPushToken[storeb2storeb2storeb2]';
const NY_AFTERNOON = new Date('2026-06-02T18:00:00Z'); // 14:00 in New York: outside quiet hours

function pushWorld() {
  const clock = { at: NY_AFTERNOON };
  const w = pushOutboxWorld({ now: () => clock.at });
  const db = {
    ...w.db,
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: object }) => ({ id: 'n-push', ...a.data })),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const client = stub<ExpoPushClient>({
    send: jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` }))),
    getReceipts: jest.fn(async () => ({})),
  });
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), client);
  delivery.autoDrain = false;
  const svc = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  return { ...w, delivery, svc, client };
}

/** A preferences PATCH body as the route receives it (the field is new in STORE-B2). */
const patch = (body: object) => body as unknown as UpdateNotificationPreferencesDto;

/** A plan renewal push; `null` context is the Day 0 notice. */
const offerPush = (user: string, context: object | null = OFFER) => ({
  user_id: user,
  kind: PLAN_RENEWAL,
  body: 'Your plan has ended.',
  deep_link: 'tgp://home',
  dedupe_key: `plan_renewal:r-${user}:${context ? 1 : 0}`,
  ...(context ? { context } : {}),
});

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('STORE-B2: the gate rule (enqueue and send time share it)', () => {
  it('an offer needs the yes: no row, a row without it, a cleared yes or a non-time value is no', () => {
    expect(pushAllowedByPreferences(null, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(pushAllowedByPreferences(undefined, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(pushAllowedByPreferences({}, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(pushAllowedByPreferences({ plan_renewal_push: true }, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(pushAllowedByPreferences({ plan_renewal_offers_opt_in_at: null }, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(pushAllowedByPreferences({ plan_renewal_offers_opt_in_at: true }, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(pushAllowedByPreferences({ plan_renewal_offers_opt_in_at: YES }, PLAN_RENEWAL, OFFER)).toBe(true);
    // The yes is the offers' own switch: an old "plan renewal reminders" off does not undo a later yes.
    expect(
      pushAllowedByPreferences({ plan_renewal_push: false, plan_renewal_offers_opt_in_at: YES }, PLAN_RENEWAL, OFFER),
    ).toBe(true);
  });

  it('Mute all stops an offer even after the yes (an offer is not a money notice)', () => {
    const mutedYes = { muted: true, plan_renewal_offers_opt_in_at: YES };
    expect(pushAllowedByPreferences(mutedYes, PLAN_RENEWAL, OFFER)).toBe(false);
    expect(muteAllStops(mutedYes, PLAN_RENEWAL, 'push', OFFER)).toBe(true);
    expect(muteAllStops(mutedYes, PLAN_RENEWAL, 'email', OFFER)).toBe(true);
    expect(muteAllStops(mutedYes, PLAN_RENEWAL, 'inapp', OFFER)).toBe(false);
  });

  it('the Day 0 notice (no offer context) keeps its rule: its switch stops it, Mute all does not', () => {
    expect(pushAllowedByPreferences(null, PLAN_RENEWAL)).toBe(true);
    expect(pushAllowedByPreferences({}, PLAN_RENEWAL)).toBe(true);
    expect(pushAllowedByPreferences({ plan_renewal_push: false }, PLAN_RENEWAL)).toBe(false);
    expect(pushAllowedByPreferences({ muted: true }, PLAN_RENEWAL)).toBe(true);
    expect(muteAllStops({ muted: true }, PLAN_RENEWAL, 'push')).toBe(false);
  });

  it('every other kind is unchanged by the yes or its absence', () => {
    for (const kind of [NotificationKind.MESSAGE_RECEIVED, NotificationKind.TRIAL_ENDING, NotificationKind.WORKOUT_REMINDER]) {
      expect([kind, pushAllowedByPreferences({}, kind), pushAllowedByPreferences({ muted: true }, kind)]).toEqual([
        kind,
        true,
        kind === NotificationKind.TRIAL_ENDING,
      ]);
    }
  });
});

describe('STORE-B2: enqueue (NotificationsService.sendPush)', () => {
  it('never said yes: no Day 1 or Day 7 offer is queued (no row, and a saved row of defaults)', async () => {
    const w = pushWorld();
    w.tokens.none = TOKEN;
    w.tokens.saved = TOKEN;
    w.prefs.saved = { plan_renewal_push: true, muted: false };
    expect(await w.svc.sendPush(offerPush('none'))).toBeNull();
    expect(await w.svc.sendPush(offerPush('saved'))).toBeNull();
    expect(w.rows).toHaveLength(0);
  });

  it('Mute all: no offer is queued even after the yes', async () => {
    const w = pushWorld();
    w.tokens.m = TOKEN;
    w.prefs.m = { muted: true, plan_renewal_offers_opt_in_at: YES };
    expect(await w.svc.sendPush(offerPush('m'))).toBeNull();
    expect(w.rows).toHaveLength(0);
  });

  it('said yes: the offer is queued with its offer context stored on the row', async () => {
    const w = pushWorld();
    w.tokens.y = TOKEN;
    w.prefs.y = { plan_renewal_offers_opt_in_at: YES };
    expect(await w.svc.sendPush(offerPush('y'))).not.toBeNull();
    expect(w.rows.map((r) => [r.kind, r.context])).toEqual([[PLAN_RENEWAL, OFFER]]);
  });

  it('the Day 0 notice is queued as before: no row, and Mute all on', async () => {
    const w = pushWorld();
    w.tokens.a = TOKEN;
    w.tokens.b = TOKEN;
    w.prefs.b = { muted: true };
    expect(await w.svc.sendPush(offerPush('a', null))).not.toBeNull();
    expect(await w.svc.sendPush(offerPush('b', null))).not.toBeNull();
    // No offer context on either row (the outbox fake stores an absent context as undefined).
    expect(w.rows.map((r) => r.context ?? null)).toEqual([null, null]);
  });
});

describe('STORE-B2: send time (the worker re-reads the yes)', () => {
  async function queuedOffer() {
    const w = pushWorld();
    w.tokens.p = TOKEN;
    w.prefs.p = { plan_renewal_offers_opt_in_at: YES };
    expect(await w.svc.sendPush(offerPush('p'))).not.toBeNull();
    return w;
  }

  it('the yes still stands: the offer is sent', async () => {
    const w = await queuedOffer();
    await w.delivery.drain();
    expect(w.rows.map((r) => [r.status, r.result_code])).toEqual([['sent', 'sent']]);
  });

  it('a later no (the switch turned off) drops the waiting offer', async () => {
    const w = await queuedOffer();
    w.prefs.p = { plan_renewal_offers_opt_in_at: null };
    await w.delivery.drain();
    expect(w.rows.map((r) => [r.status, r.result_code])).toEqual([['dropped', 'preference-off']]);
  });

  it('Mute all turned on drops the waiting offer', async () => {
    const w = await queuedOffer();
    w.prefs.p = { plan_renewal_offers_opt_in_at: YES, muted: true };
    await w.delivery.drain();
    expect(w.rows.map((r) => [r.status, r.result_code])).toEqual([['dropped', 'preference-off']]);
  });

  it('the Day 0 notice still passes Mute all at send time', async () => {
    const w = pushWorld();
    w.tokens.d = TOKEN;
    expect(await w.svc.sendPush(offerPush('d', null))).not.toBeNull();
    w.prefs.d = { muted: true };
    await w.delivery.drain();
    expect(w.rows.map((r) => [r.status, r.result_code])).toEqual([['sent', 'sent']]);
  });
});

describe('STORE-B2: the sweep marks Day 1 and Day 7 as offers, Day 0 as the notice', () => {
  const DAY = 24 * 60 * 60 * 1000;
  async function step(daysAgo: number, pushedStep: number) {
    const sendPush = jest.fn(async () => null);
    const tx = { planRenewal: { updateMany: jest.fn(async () => ({ count: 1 })) } };
    const prisma = {
      planRenewal: { updateMany: jest.fn(async () => ({ count: 0 })) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new PlanRenewalService(
      stub<ConstructorParameters<typeof PlanRenewalService>[0]>(prisma),
      stub<NotificationsService>({ sendPush }),
    );
    const row = stub<PlanRenewal>({
      id: 'r1',
      client_user_id: 'c1',
      coach_user_id: 'k1',
      status: 'active',
      pushed_step: pushedStep,
      ended_at: new Date(NY_AFTERNOON.getTime() - daysAgo * DAY - 2 * 60 * 60 * 1000), // 12:00 New York
    });
    const advance = (service as unknown as { advance: (r: PlanRenewal, now: Date) => Promise<string> }).advance;
    expect(await advance.call(service, row, NY_AFTERNOON)).toBe('pushed');
    return sendPush.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
  }

  it.each([
    [0, -1, undefined],
    [1, 0, OFFER],
    [7, 1, OFFER],
  ])('Day %i', async (day, pushedStep, context) => {
    const [push, ...more] = await step(day, pushedStep);
    expect(more).toEqual([]);
    expect(push).toMatchObject({ kind: PLAN_RENEWAL, dedupe_key: `plan_renewal:r1:${day}` });
    expect(push.context).toEqual(context);
  });
});

describe('STORE-B2: the in-app yes (PATCH /notifications/preferences plan_renewal_offers)', () => {
  function prefsWorld(existing: Record<string, unknown> | null) {
    let stored = existing;
    const prisma = {
      notificationPreferences: {
        findUnique: jest.fn(async () => stored),
        update: jest.fn(async (a: { data: Record<string, unknown> }) => (stored = { ...stored, ...a.data })),
        create: jest.fn(async (a: { data: Record<string, unknown> }) => (stored = { ...a.data })),
      },
    };
    const svc = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma));
    return { svc, prisma, get: () => stored };
  }

  it('everyone starts at no: the defaults have no yes, and the Day 0 switch stays on', async () => {
    const { svc } = prefsWorld(null);
    expect(await svc.getPreferences('u')).toMatchObject({ plan_renewal_offers_opt_in_at: null, plan_renewal_push: true });
  });

  it('yes stores the time of the yes; yes again keeps the first time; no clears it', async () => {
    const w = prefsWorld(null);
    await w.svc.updatePreferences('u', patch({ plan_renewal_offers: true }));
    const first = w.get()?.plan_renewal_offers_opt_in_at;
    expect(first).toBeInstanceOf(Date);
    w.prisma.notificationPreferences.update.mockClear();
    await w.svc.updatePreferences('u', patch({ plan_renewal_offers: true }));
    expect(w.get()?.plan_renewal_offers_opt_in_at).toBe(first);
    await w.svc.updatePreferences('u', patch({ plan_renewal_offers: false }));
    expect(w.get()?.plan_renewal_offers_opt_in_at).toBeNull();
  });

  it('a PATCH without it leaves the yes alone, and the yes never changes plan_renewal_push', async () => {
    const w = prefsWorld({ user_id: 'u', plan_renewal_push: false, plan_renewal_offers_opt_in_at: YES });
    await w.svc.updatePreferences('u', patch({ message_push: false }));
    expect(w.get()).toMatchObject({ plan_renewal_offers_opt_in_at: YES, plan_renewal_push: false });
    await w.svc.updatePreferences('u', patch({ plan_renewal_offers: false }));
    expect(w.get()).toMatchObject({ plan_renewal_offers_opt_in_at: null, plan_renewal_push: false });
    const writes = w.prisma.notificationPreferences.update.mock.calls.map((c) => Object.keys(c[0].data));
    expect(writes).toEqual([['message_push'], ['plan_renewal_offers_opt_in_at']]);
  });

  it('the body field is a boolean the route accepts (whitelist and forbidNonWhitelisted)', async () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    const ok = plainToInstance(UpdateNotificationPreferencesDto, { plan_renewal_offers: true });
    expect(await validate(ok, opts)).toEqual([]);
    const bad = plainToInstance(UpdateNotificationPreferencesDto, { plan_renewal_offers: 'yes' });
    expect((await validate(bad, opts)).map((e) => e.property)).toEqual(['plan_renewal_offers']);
    const stored = plainToInstance(UpdateNotificationPreferencesDto, { plan_renewal_offers_opt_in_at: new Date().toISOString() });
    expect((await validate(stored, opts)).map((e) => e.property)).toEqual(['plan_renewal_offers_opt_in_at']);
  });
});
