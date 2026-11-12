/**
 * MONEY-ROW-INBOX-BE (agent 203): two link-free coach_alert rows name no client of their reader, so the inbox rule
 * (current-coach-inbox.ts) never listed, counted or marked them: the daily money-check row to the owner account and
 * the held-for-refund notice to the package's coach. Each is now its own recipient's row, and nothing that names a
 * client, or belongs to another account, becomes newly listed.
 *
 * The rows are written by the real writers: ReconciliationDailyCron.alertOwner (reconciliation-daily.cron.ts:236-286)
 * and GuestCheckoutService.holdForRefund (guest-checkout.service.ts:2346-2386), both through the real
 * createNotification. Every inbox read is the real NotificationsService method over rows filtered the way Postgres
 * reads the where (test/utils/notification-where.ts). Payload values are written here as literals on purpose: this
 * file must compile at a base without the shared constants.
 */
import { NotFoundException } from '@nestjs/common';
import { ReconciliationDailyCron, type DailyTally } from '../../src/checkout/reconciliation-daily.cron';
import { GuestCheckoutService } from '../../src/storefront/guest-checkout.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { InboxBlockRule } from '../../src/notifications/inbox-block-rule';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { SchedulingAccessService } from '../../src/scheduling/scheduling-access.service';
import * as spaces from '../../src/community/space-safety-alerts';
import * as blockPair from '../../src/messaging/block-pair';
import { whereMatches } from '../utils/notification-where';

type Row = Record<string, unknown>;
const stub = <T>(v: unknown): T => v as T;
const OWNER = '0a5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
const OWNER_2 = '0b5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b61';
const COACH = '1c5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b62';
const COACH_2 = '1d5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b63';
const MY_CLIENT = '2e5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b64';
const NOT_MY_CLIENT = '2f5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b65';
const BLOCKED = '3a5b2c1e-8b1f-4c55-9a0e-1f2e3d4c5b66';
const ROLES: Record<string, string> = { [OWNER]: 'owner', [OWNER_2]: 'owner', [COACH]: 'coach', [COACH_2]: 'coach' };
const CLIENTS: Record<string, string[]> = { [COACH]: [MY_CLIENT] };

const CLEAN: DailyTally = { checked: 3, ok: 3, drift: 0, unknown: 0, failed: 0, stopped: null };
const REVIEW: DailyTally = { checked: 3, ok: 2, drift: 1, unknown: 0, failed: 0, stopped: null };
const NOW = new Date('2026-11-09T11:00:00.000Z');
const HELD_BODY =
  'A buyer paid for Strength 12, but their account already has another coach, so nothing was delivered. The payment needs a refund.';
// HELD-ROW-WORDS-BE: a held web trial charged nothing, and its row says so (W4).
const HELD_TRIAL_BODY =
  'A buyer tried to start a free trial of Strength 12, but their account already has another coach, so the trial was not started and nothing was charged.';

function world(opts: { blockedWith?: string[] } = {}) {
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
          created_at: new Date(2026, 10, 9, 3, 0, 0, rows.length),
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
    notificationPreferences: { findUnique: jest.fn(async () => null) },
    user: {
      // reconciliation-daily.cron.ts:238-242: the oldest owner-role account.
      findFirst: jest.fn(async () => ({ id: OWNER })),
      findUnique: jest.fn(async (a: { where: { id: string } }) => ({ role: ROLES[a.where.id] ?? 'student', coach_id: null })),
    },
    coachingSession: { findMany: jest.fn(async () => []) },
    guestCheckout: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  jest.spyOn(SubCoachScopeService.prototype, 'getAuthorizedClientIds').mockImplementation(async (id: string) => CLIENTS[id] ?? []);
  jest.spyOn(SchedulingAccessService.prototype, 'sessionsStillTheirs').mockResolvedValue(stub({}));
  jest.spyOn(spaces, 'publicSpacesLedBy').mockResolvedValue([]);
  jest.spyOn(blockPair, 'everyoneInBlockWith').mockResolvedValue(opts.blockedWith ?? []);
  const notifications = new NotificationsService(stub(db), undefined, undefined, undefined, new InboxBlockRule(stub(db)));
  // The push is outside this job (the row is what lists); keep it off the fake tables.
  jest.spyOn(notifications, 'pushToUser').mockResolvedValue(stub({ delivered: true }));

  const cron = new ReconciliationDailyCron(stub({}), stub({}), notifications, stub(db));
  const moneyCheck = (tally: DailyTally = CLEAN) =>
    stub<{ alertOwner(t: DailyTally, now: Date): Promise<boolean> }>(cron).alertOwner(tally, NOW);

  const guest = { prisma: db, notifications, logger: { error: jest.fn(), warn: jest.fn() }, deliverOutcomeMail: jest.fn(async () => undefined) };
  const holdForRefund = (intent: string) =>
    stub<{ holdForRefund(c: unknown): Promise<void> }>(GuestCheckoutService.prototype).holdForRefund.call(guest, {
      id: `gc-${intent}`,
      stripe_payment_intent_id: intent,
      package: { coach_id: COACH, name: 'Strength 12' },
    });

  const write = (user_id: string, payload: Row, deep_link?: string) =>
    notifications.createNotification({ user_id, kind: NotificationKind.COACH_ALERT, body: 'other row', payload, deep_link, channel: 'inapp' });
  const only = (user: string) => rows.filter((r) => r.user_id === user);
  return { rows, notifications, moneyCheck, holdForRefund, write, only };
}

afterEach(() => jest.restoreAllMocks());

describe('MONEY-ROW-INBOX-BE: the money-check row and the held-for-refund notice are listed by their own recipient', () => {
  it.each([
    ['clean', CLEAN, 'Money check: clean', 'Checked 3 purchases against Stripe. Every one matches.'],
    ['needs review', REVIEW, 'Money check: needs review', "Checked 3 purchases against Stripe. 1 doesn't match."],
  ])('1: the owner-role reader lists the day\'s money row (%s) with its payload.title and body as written, and both counts count it', async (_v, tally, title, body) => {
    const w = world();
    expect(await w.moneyCheck(tally)).toBe(true);
    const listed = await w.notifications.listNotifications(OWNER, {});
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ user_id: OWNER, kind: 'coach_alert', deep_link: null, body, read_at: null });
    expect((listed.items[0].payload as Row).title).toBe(title);
    expect((listed.items[0].payload as Row).type).toBe('money_check');
    expect(listed.unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(OWNER)).toBe(1);
  });

  it('2: markRead reaches the money row and the count drops to 0', async () => {
    const w = world();
    await w.moneyCheck();
    const [row] = w.only(OWNER);
    await w.notifications.markRead(String(row.id), OWNER);
    expect(row.read_at).toBeInstanceOf(Date);
    expect(await w.notifications.getUnreadCount(OWNER)).toBe(0);
  });

  it('2: markAllRead reaches the money row', async () => {
    const w = world();
    await w.moneyCheck();
    expect(await w.notifications.markAllRead(OWNER)).toEqual({ updated: 1 });
    expect(w.only(OWNER)[0].read_at).toBeInstanceOf(Date);
  });

  it.each([
    ['a paid checkout', 'pi_held_1', HELD_BODY, 'Refund needed'],
    // HELD-ROW-WORDS-BE: a held web trial charged nothing; its row names itself and says so.
    ['a held web trial', 'seti_held_1', HELD_TRIAL_BODY, 'Free trial not started'],
  ])('3: the coach lists, counts and marks the held-for-refund row for %s (body and title as written)', async (_v, intent, body, title) => {
    const w = world();
    await w.holdForRefund(intent);
    const listed = await w.notifications.listNotifications(COACH, {});
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ user_id: COACH, kind: 'coach_alert', deep_link: null, body });
    expect(listed.items[0].payload).toEqual({
      event: 'guest_purchase_held_for_refund',
      reason: 'buyer_has_other_coach',
      guest_checkout_id: `gc-${intent}`,
      payment_intent_id: intent,
      title,
    });
    expect(listed.unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(COACH)).toBe(1);
    await w.notifications.markRead(String(listed.items[0].id), COACH);
    expect(await w.notifications.getUnreadCount(COACH)).toBe(0);
  });

  it('4 (green at the base too): a link-free coach_alert naming a client the reader does not hold stays out; naming one they hold is listed', async () => {
    const w = world();
    await w.write(COACH, { type: 'onboarding_screening_review', client_id: NOT_MY_CLIENT });
    expect((await w.notifications.listNotifications(COACH, {})).items).toEqual([]);
    expect(await w.notifications.getUnreadCount(COACH)).toBe(0);
    await w.write(COACH, { type: 'onboarding_screening_review', client_id: MY_CLIENT });
    const listed = await w.notifications.listNotifications(COACH, {});
    expect(listed.items.map((r) => (r.payload as Row).client_id)).toEqual([MY_CLIENT]);
  });

  it('5 (green at the base too): a link-free coach_alert with neither key (payload.title only) stays out', async () => {
    const w = world();
    await w.write(OWNER, { title: 'Something' });
    await w.write(COACH, { title: 'Something' });
    expect((await w.notifications.listNotifications(OWNER, {})).items).toEqual([]);
    expect((await w.notifications.listNotifications(COACH, {})).items).toEqual([]);
    expect(await w.notifications.markAllRead(COACH)).toEqual({ updated: 0 });
  });

  it('6 (green at the base too): the owner\'s money row is never listed, counted or marked by another owner-role account or a coach', async () => {
    const w = world();
    await w.moneyCheck();
    const [row] = w.only(OWNER);
    for (const reader of [OWNER_2, COACH, COACH_2]) {
      expect((await w.notifications.listNotifications(reader, {})).items).toEqual([]);
      expect(await w.notifications.getUnreadCount(reader)).toBe(0);
      expect(await w.notifications.markAllRead(reader)).toEqual({ updated: 0 });
      await expect(w.notifications.markRead(String(row.id), reader)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(row.read_at).toBeNull();
  });

  it('6 (green at the base too): a coach\'s held row is never listed or marked by another coach or the owner', async () => {
    const w = world();
    await w.holdForRefund('pi_held_2');
    const [row] = w.only(COACH);
    for (const reader of [COACH_2, OWNER]) {
      expect((await w.notifications.listNotifications(reader, {})).items).toEqual([]);
      await expect(w.notifications.markRead(String(row.id), reader)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(row.read_at).toBeNull();
  });

  it('7 (green at the base too): a money-check row with a deep_link keeps the link arms\' answer', async () => {
    const w = world();
    await w.write(COACH, { type: 'money_check' }, `tgp://coach/clients/${NOT_MY_CLIENT}`);
    expect((await w.notifications.listNotifications(COACH, {})).items).toEqual([]);
    await w.write(COACH, { type: 'money_check' }, 'tgp://coach/billing/refunds');
    const listed = await w.notifications.listNotifications(COACH, {});
    expect(listed.items.map((r) => r.deep_link)).toEqual(['tgp://coach/billing/refunds']);
  });

  it('9 (green at the base too): the block rule still hides a row on top of the new arms (through inboxWhere)', async () => {
    const w = world({ blockedWith: [BLOCKED] });
    await w.write(OWNER, { type: 'money_check', approvedByCoachId: BLOCKED });
    await w.write(COACH, { event: 'guest_purchase_held_for_refund', approvedByCoachId: BLOCKED });
    for (const reader of [OWNER, COACH]) {
      expect((await w.notifications.listNotifications(reader, {})).items).toEqual([]);
      expect(await w.notifications.getUnreadCount(reader)).toBe(0);
      expect(await w.notifications.markAllRead(reader)).toEqual({ updated: 0 });
      await expect(w.notifications.markRead(String(w.only(reader)[0].id), reader)).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});
