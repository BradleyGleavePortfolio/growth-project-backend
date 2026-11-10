/**
 * LS-1232R1 B1 (b#1232 CRISIS-TEXT-BE @ d3c15742): the staff row alertStaff writes must reach the owner-role account's
 * inbox. The push says "Open TGP to see it" and the phone's notification center reads GET /notifications
 * (listNotifications) and the unread count (getUnreadCount). The row is kind coach_alert with no deep_link and a
 * payload of ids only, and the inbox rule (src/notifications/current-coach-inbox.ts:67-83) has no arm for it:
 * :79 lists a link-free row only when its kind is NOT coach_alert, and :80 looks for payload.client_id. So the staff
 * account is paged and the inbox shows nothing. This spec writes the row through the real CommunitySafetyService.alertStaff
 * and NotificationsService.createNotification, then lists the inbox through the real listNotifications with a tiny
 * evaluator of the Prisma where it builds. A control row (a link-free row of another kind) proves the evaluator.
 */
import type { ModuleRef } from '@nestjs/core';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { SubCoachScopeService } from '../../../src/sub-coach/sub-coach-scope.service';
import { SchedulingAccessService } from '../../../src/scheduling/scheduling-access.service';
import * as spaces from '../../../src/community/space-safety-alerts';

type Row = Record<string, unknown>;
const stub = <T>(v: unknown): T => v as T;
const STAFF = '0a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
const ROW_ID = '33333333-3333-4333-8333-333333333333';

/** The subset of Prisma's where grammar that current-coach-inbox.ts and listNotifications use. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (Array.isArray(cond) ? cond : [cond as Row]).every((w) => matches(row, w));
    if (key === 'NOT') return !(Array.isArray(cond) ? cond : [cond as Row]).some((w) => matches(row, w));
    if (key === 'payload') {
      const { path, equals } = cond as { path: string[]; equals: unknown };
      const payload = (row.payload ?? {}) as Row;
      return path.length === 1 && payload[path[0]] === equals;
    }
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond;
    return Object.entries(cond as Row).every(([op, arg]) => {
      switch (op) {
        case 'in':
          return (arg as unknown[]).includes(value);
        case 'notIn':
          return !(arg as unknown[]).includes(value);
        case 'not':
          return value !== arg;
        case 'startsWith':
          return typeof value === 'string' && value.startsWith(arg as string);
        case 'equals':
          return value === arg;
        case 'lt':
          return (value as Date) < (arg as Date);
        default:
          throw new Error(`unhandled where op ${op}`);
      }
    });
  });
}

function world() {
  const rows: Row[] = [];
  const db = {
    notification: {
      create: jest.fn(async (a: { data: Row }) => {
        const row: Row = {
          id: `n-${rows.length + 1}`,
          deep_link: null,
          payload: null,
          read_at: null,
          inbox_hidden: false,
          created_at: new Date(2026, 5, 2, 14, 0, 0, rows.length),
          ...a.data,
          ...(a.data.deep_link === undefined ? { deep_link: null } : {}),
        };
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async (a: { where: Row; take?: number }) =>
        rows.filter((r) => matches(r, a.where)).slice(0, a.take ?? rows.length),
      ),
      count: jest.fn(async (a: { where: Row }) => rows.filter((r) => matches(r, a.where)).length),
    },
    notificationPreferences: { findUnique: jest.fn(async () => null) },
    user: {
      findUnique: jest.fn(async () => ({ id: STAFF, role: 'owner' })),
      findMany: jest.fn(async () => [{ id: STAFF }]),
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
  return { db, rows, notifications, safety };
}

afterEach(() => jest.restoreAllMocks());

describe('LS-1232R1 B1: the staff alert row is in the owner-role inbox', () => {
  it('control: a link-free row of another kind is listed and counted (the evaluator and the inbox rule agree)', async () => {
    const w = world();
    await w.notifications.createNotification({
      user_id: STAFF,
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      body: 'control',
      channel: 'inapp',
    });
    const listed = await w.notifications.listNotifications(STAFF, {});
    expect(listed.items.map((n) => n.id)).toEqual([w.rows[0].id]);
    expect(await w.notifications.getUnreadCount(STAFF)).toBe(1);
  });

  it('the row alertStaff writes is listed by GET /notifications and counted unread', async () => {
    const w = world();
    await w.safety.alertStaff({ surface: 'dm', posterId: POSTER, flag: true, page: true }, ROW_ID);
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ user_id: STAFF, kind: NotificationKind.COACH_ALERT, deep_link: null, channel: 'inapp' });
    expect((w.rows[0].payload as Row).poster_id).toBe(POSTER);

    const listed = await w.notifications.listNotifications(STAFF, {});
    expect(listed.items.map((n) => n.id)).toEqual([w.rows[0].id]);
    expect(listed.unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(STAFF)).toBe(1);
  });
});
