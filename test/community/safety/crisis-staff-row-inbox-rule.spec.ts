/**
 * FIX-1232R1 (agent 203), B1 of LO-1232R1 and LS-1232R1: the row alertStaff writes is listed, counted unread and
 * marked read by its own recipient through the one inbox rule (currentCoachInbox), and nothing else becomes newly
 * listed. The row is written by the real alertStaff and createNotification; every inbox read is the real
 * NotificationsService method over rows filtered the way Postgres reads the where (test/utils/notification-where.ts).
 */
import type { ModuleRef } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { SubCoachScopeService } from '../../../src/sub-coach/sub-coach-scope.service';
import { SchedulingAccessService } from '../../../src/scheduling/scheduling-access.service';
import * as spaces from '../../../src/community/space-safety-alerts';
import { whereMatches } from '../../utils/notification-where';

type Row = Record<string, unknown>;
const stub = <T>(v: unknown): T => v as T;
const STAFF_A = '0a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
const STAFF_B = '0b4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b61';
const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
const NOT_MY_CLIENT = '3e4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6c';

function world() {
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
          created_at: new Date(2026, 5, 2, 14, 0, 0, rows.length),
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
      findUnique: jest.fn(async () => ({ role: 'owner' })),
      findMany: jest.fn(async (a: { where: { id: { not: string } } }) =>
        [STAFF_A, STAFF_B].filter((id) => id !== a.where.id.not).map((id) => ({ id })),
      ),
    },
    coachingSession: { findMany: jest.fn(async () => []) },
  };
  jest.spyOn(SubCoachScopeService.prototype, 'getAuthorizedClientIds').mockResolvedValue([]);
  jest.spyOn(SchedulingAccessService.prototype, 'sessionsStillTheirs').mockResolvedValue(stub({}));
  jest.spyOn(spaces, 'publicSpacesLedBy').mockResolvedValue([]);
  const notifications = new NotificationsService(stub(db));
  const safety = new CommunitySafetyService(
    stub(db),
    stub<ModuleRef>({ get: (t: unknown) => (t === NotificationsService ? notifications : undefined) }),
  );
  const alert = () => safety.alertStaff({ surface: 'post_comment', posterId: POSTER, flag: true, page: true }, 'row-1');
  const rowOf = (user: string) => rows.find((r) => r.user_id === user && r.kind === NotificationKind.COACH_ALERT)!;
  return { rows, notifications, alert, rowOf };
}

afterEach(() => jest.restoreAllMocks());

describe('FIX-1232R1 B1: the staff crisis row is in its own recipient\'s inbox', () => {
  it('K2: markRead reaches the row, and the unread count drops to 0', async () => {
    const w = world();
    await w.alert();
    const mine = w.rowOf(STAFF_A);
    await w.notifications.markRead(String(mine.id), STAFF_A);
    expect(mine.read_at).toBeInstanceOf(Date);
    expect(await w.notifications.getUnreadCount(STAFF_A)).toBe(0);
  });

  it('K2: markAllRead reaches the row', async () => {
    const w = world();
    await w.alert();
    expect(await w.notifications.markAllRead(STAFF_A)).toEqual({ updated: 1 });
    expect(w.rowOf(STAFF_A).read_at).toBeInstanceOf(Date);
    expect(w.rowOf(STAFF_B).read_at).toBeNull();
  });

  it('K3 (green at the head too): a link-free coach_alert row without the key, naming a client the reader does not hold, stays out', async () => {
    const w = world();
    await w.notifications.createNotification({
      user_id: STAFF_A,
      kind: NotificationKind.COACH_ALERT,
      body: 'flag alert',
      payload: { type: 'onboarding_screening_review', client_id: NOT_MY_CLIENT },
      channel: 'inapp',
    });
    expect((await w.notifications.listNotifications(STAFF_A, {})).items).toEqual([]);
    expect(await w.notifications.getUnreadCount(STAFF_A)).toBe(0);
  });

  it('K3 (green at the head too): the row is listed for its own recipient only; another staff account cannot read or mark it', async () => {
    const w = world();
    await w.alert();
    const theirs = w.rowOf(STAFF_B);
    const listed = await w.notifications.listNotifications(STAFF_A, {});
    expect(listed.items.map((r) => r.user_id)).not.toContain(STAFF_B);
    await expect(w.notifications.markRead(String(theirs.id), STAFF_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(theirs.read_at).toBeNull();
  });

  it('MONEY-ROW-INBOX-BE (b#1241, operator ruling 00:4x: b#1241 lands second and flips this case): the daily money-check row, a link-free coach_alert with payload.type money_check and no client_id, is listed and counted unread for its own recipient only', async () => {
    const w = world();
    await w.notifications.createNotification({
      user_id: STAFF_A,
      kind: NotificationKind.COACH_ALERT,
      body: 'money check',
      payload: { type: 'money_check', title: 'Money check', verdict: 'ok', day: '2026-06-02' },
      channel: 'inapp',
    });
    // Listed by the money arm of currentCoachInbox (current-coach-inbox.ts, payload.type equals MONEY_CHECK_ROW_TYPE).
    expect((await w.notifications.listNotifications(STAFF_A, {})).items).toEqual([
      expect.objectContaining({
        user_id: STAFF_A,
        kind: NotificationKind.COACH_ALERT,
        payload: expect.objectContaining({ type: 'money_check' }),
      }),
    ]);
    expect(await w.notifications.getUnreadCount(STAFF_A)).toBe(1);
    expect((await w.notifications.listNotifications(STAFF_B, {})).items).toEqual([]);
  });
});
