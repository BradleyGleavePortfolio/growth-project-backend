/**
 * HELD-ROW-WORDS-BE (agent 203): the held-for-refund notice a coach lists says what happened to the money in that
 * checkout, names itself, and is stored whole. A paid hold (a PaymentIntent, pi_) keeps W1 word for word under the
 * title "Refund needed" (W2); a held web trial (a SetupIntent, seti_: the card was saved and nothing was charged,
 * guest-trial-intent.ts) reads W4 under "Free trial not started" (W3). Every word is approved (operator, #203-E15).
 *
 * The row is written by the real GuestCheckoutService.holdForRefund through the real createNotification and read back
 * by the real listNotifications over rows filtered the way Postgres reads the where (test/utils/notification-where.ts),
 * as test/notifications/money-row-inbox.spec.ts does. Words and payload values are literals on purpose: this file
 * must compile, and cases 1 to 3 must fail, at backend main 359a85eb.
 */
import { NotFoundException } from '@nestjs/common';
import { GuestCheckoutService } from '../../src/storefront/guest-checkout.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { InboxBlockRule } from '../../src/notifications/inbox-block-rule';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { SchedulingAccessService } from '../../src/scheduling/scheduling-access.service';
import * as spaces from '../../src/community/space-safety-alerts';
import * as blockPair from '../../src/messaging/block-pair';
import { whereMatches } from '../utils/notification-where';

type Row = Record<string, unknown>;
const stub = <T>(v: unknown): T => v as T;
const OWNER = '0a5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b70';
const COACH = '1c5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b72';
const COACH_2 = '1d5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b73';
const ROLES: Record<string, string> = { [OWNER]: 'owner', [COACH]: 'coach', [COACH_2]: 'coach' };

// W1, unchanged from main (guest-checkout.service.ts:2373 at 359a85eb), and W4.
const PAID_BODY = (pkg: string) =>
  `A buyer paid for ${pkg}, but their account already has another coach, so nothing was delivered. The payment needs a refund.`;
const TRIAL_BODY = (pkg: string) =>
  `A buyer tried to start a free trial of ${pkg}, but their account already has another coach, so the trial was not started and nothing was charged.`;
const PAID_TITLE = 'Refund needed';
const TRIAL_TITLE = 'Free trial not started';

/** A package name of exactly n characters (the server accepts up to 120, packages.dto.ts:5, :100). */
const nameOf = (n: number) => `Strength ${'x'.repeat(n)}`.slice(0, n);

function world(opts: { coachAlertInApp?: false; moved?: number } = {}) {
  const rows: Row[] = [];
  const pick = (where: unknown) => rows.filter((r) => whereMatches(r, where));
  const db = {
    notification: {
      create: jest.fn(async (a: { data: Row }) => {
        const row: Row = {
          id: `n-${rows.length + 1}`,
          payload: null,
          read_at: null,
          inbox_hidden: false,
          created_at: new Date(2026, 10, 10, 3, 0, 0, rows.length),
          ...a.data,
        };
        if (row.deep_link === undefined) row.deep_link = null;
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(async (a: { where: unknown }) => pick(a.where)[0] ?? null),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async (a: { where: unknown; take?: number }) => pick(a.where).slice(0, a.take ?? rows.length)),
      count: jest.fn(async (a: { where: unknown }) => pick(a.where).length),
      update: jest.fn(async (a: { where: { id: string }; data: Row }) => Object.assign(rows.find((r) => r.id === a.where.id)!, a.data)),
      updateMany: jest.fn(async (a: { where: unknown; data: Row }) => {
        const hit = pick(a.where);
        hit.forEach((r) => Object.assign(r, a.data));
        return { count: hit.length };
      }),
    },
    // notifications.service.ts:566-568: the coach's in-app coach-alert switch decides whether the row exists.
    notificationPreferences: {
      findUnique: jest.fn(async (a: { where: { user_id: string } }) =>
        opts.coachAlertInApp === false ? { user_id: a.where.user_id, coach_alert_inapp: false } : null,
      ),
    },
    user: {
      findUnique: jest.fn(async (a: { where: { id: string } }) => ({ role: ROLES[a.where.id] ?? 'student', coach_id: null })),
    },
    coachingSession: { findMany: jest.fn(async () => []) },
    // holdForRefund's claim (guest-checkout.service.ts:2348-2360): 0 when another run already moved the checkout.
    guestCheckout: { updateMany: jest.fn(async () => ({ count: opts.moved ?? 1 })) },
  };
  jest.spyOn(SubCoachScopeService.prototype, 'getAuthorizedClientIds').mockResolvedValue([]);
  jest.spyOn(SchedulingAccessService.prototype, 'sessionsStillTheirs').mockResolvedValue(stub({}));
  jest.spyOn(spaces, 'publicSpacesLedBy').mockResolvedValue([]);
  jest.spyOn(blockPair, 'everyoneInBlockWith').mockResolvedValue([]);
  const notifications = new NotificationsService(stub(db), undefined, undefined, undefined, new InboxBlockRule(stub(db)));

  const mail = jest.fn(async () => undefined);
  const guest = { prisma: db, notifications, logger: { error: jest.fn(), warn: jest.fn() }, deliverOutcomeMail: mail };
  const hold = (intent: string, pkg = 'Strength 12') =>
    stub<{ holdForRefund(c: unknown): Promise<void> }>(GuestCheckoutService.prototype).holdForRefund.call(guest, {
      id: `gc-${intent}`,
      stripe_payment_intent_id: intent,
      package: { coach_id: COACH, name: pkg },
    });
  const listed = async (reader = COACH) => (await notifications.listNotifications(reader, {})).items;
  return { rows, notifications, hold, listed, mail };
}

afterEach(() => jest.restoreAllMocks());

describe('HELD-ROW-WORDS-BE: the held-for-refund row says what happened to the money, names itself and is stored whole', () => {
  it('1: a paid hold (pi_) lists with payload.title "Refund needed" over W1 exactly as on main; the payload is main\'s four keys plus title', async () => {
    const w = world();
    await w.hold('pi_held_1');
    const items = await w.listed();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ user_id: COACH, kind: 'coach_alert', channel: 'inapp', deep_link: null, body: PAID_BODY('Strength 12') });
    expect(items[0].payload).toEqual({
      event: 'guest_purchase_held_for_refund',
      reason: 'buyer_has_other_coach',
      guest_checkout_id: 'gc-pi_held_1',
      payment_intent_id: 'pi_held_1',
      title: PAID_TITLE,
    });
    expect(w.mail).not.toHaveBeenCalled();
  });

  it('2: a held web trial (seti_) lists with payload.title "Free trial not started" over W4, which says neither "paid" nor "refund"', async () => {
    const w = world();
    await w.hold('seti_held_1');
    const items = await w.listed();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ user_id: COACH, kind: 'coach_alert', channel: 'inapp', deep_link: null, body: TRIAL_BODY('Strength 12') });
    expect(items[0].payload).toEqual({
      event: 'guest_purchase_held_for_refund',
      reason: 'buyer_has_other_coach',
      guest_checkout_id: 'gc-seti_held_1',
      payment_intent_id: 'seti_held_1',
      title: TRIAL_TITLE,
    });
    const body = String(items[0].body).toLowerCase();
    expect(body).not.toContain('paid');
    expect(body).not.toContain('refund');
    // The buyer's TW-F1 is still the one mail (guest-checkout.service.ts:2366-2368), unchanged here.
    expect(w.mail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a paid hold', 'pi_held_long', PAID_BODY, 'The payment needs a refund.'],
    ['a held web trial', 'seti_held_long', TRIAL_BODY, 'the trial was not started and nothing was charged.'],
  ])('3: for %s the stored body is whole at package names of 44, 54 and 120 characters and ends with its last words', async (_v, intent, words, ending) => {
    for (const n of [44, 54, 120]) {
      const w = world();
      const pkg = nameOf(n);
      expect(pkg).toHaveLength(n);
      await w.hold(intent, pkg);
      const items = await w.listed();
      expect(items).toHaveLength(1);
      expect(items[0].body).toBe(words(pkg));
      expect(String(items[0].body).endsWith(ending)).toBe(true);
      expect(w.rows[0].body).toBe(words(pkg));
    }
  });

  it('3 (guard, green at main too): a paid hold with a 43-character name stores the same 160-character body as on main', async () => {
    const w = world();
    const pkg = nameOf(43);
    await w.hold('pi_held_43', pkg);
    const [row] = w.rows;
    expect(row.body).toBe(PAID_BODY(pkg));
    expect(String(row.body)).toHaveLength(160);
  });

  it.each([['pi_held_2'], ['seti_held_2']])('7 (green at main too): the held row (%s) is listed, counted and marked by its own coach only', async (intent) => {
    const w = world();
    await w.hold(intent);
    const [row] = w.rows;
    for (const reader of [COACH_2, OWNER]) {
      expect(await w.listed(reader)).toEqual([]);
      expect(await w.notifications.getUnreadCount(reader)).toBe(0);
      expect(await w.notifications.markAllRead(reader)).toEqual({ updated: 0 });
      await expect(w.notifications.markRead(String(row.id), reader)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(row.read_at).toBeNull();
    expect(await w.notifications.getUnreadCount(COACH)).toBe(1);
    await w.notifications.markRead(String(row.id), COACH);
    expect(await w.notifications.getUnreadCount(COACH)).toBe(0);
  });

  it.each([['pi_held_3'], ['seti_held_3']])('8 (green at main too): with the coach\'s in-app coach-alert switch off, no row is stored (%s)', async (intent) => {
    const w = world({ coachAlertInApp: false });
    await w.hold(intent);
    expect(w.rows).toEqual([]);
    expect(await w.listed()).toEqual([]);
  });

  it.each([['pi_held_4'], ['seti_held_4']])('9 (green at main too): a hold that moves no checkout (count 0) writes no row and sends no mail (%s)', async (intent) => {
    const w = world({ moved: 0 });
    await w.hold(intent);
    expect(w.rows).toEqual([]);
    expect(w.mail).not.toHaveBeenCalled();
  });
});
