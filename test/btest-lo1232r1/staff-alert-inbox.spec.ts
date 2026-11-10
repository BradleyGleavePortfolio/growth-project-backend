/**
 * LO-1232R1 B1 (lens, agent 203): the staff alert alertStaff writes for a community crisis match must be listed and
 * counted in that staff account's inbox (GET /notifications), where the push's tap opens. The row is taken exactly as
 * CommunitySafetyService.alertStaff writes it, and the inbox read is the real listNotifications / currentCoachInbox,
 * with the where clause read the way Postgres reads it (test/utils/notification-where.ts).
 */
import type { ModuleRef } from '@nestjs/core';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { SchedulingAccessService } from '../../src/scheduling/scheduling-access.service';
import { whereMatches } from '../utils/notification-where';

const STAFF = '0a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
const stub = <T>(v: unknown): T => v as T;

describe('LO-1232R1 B1: the community crisis staff alert reaches the staff inbox', () => {
  afterEach(() => jest.restoreAllMocks());

  it('an owner-role staff account sees the alert row in GET /notifications and in its unread count', async () => {
    jest.spyOn(SubCoachScopeService.prototype, 'getAuthorizedClientIds').mockResolvedValue([]);
    jest.spyOn(SchedulingAccessService.prototype, 'sessionsStillTheirs').mockResolvedValue({});
    let n = 0;
    const rows: Record<string, unknown>[] = [];
    const db = {
      notificationPreferences: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => ({ id: STAFF, role: 'owner', coach_id: null })) },
      coachingSession: { findMany: jest.fn(async () => []) },
      communityCohort: { findMany: jest.fn(async () => []) },
      notification: {
        create: jest.fn(async (a: { data: Record<string, unknown> }) => {
          const row = { id: `n-${++n}`, deep_link: null, read_at: null, inbox_hidden: false, created_at: new Date(), ...a.data };
          rows.push(row);
          return row;
        }),
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async (a: { where: unknown }) => rows.filter((r) => whereMatches(r, a.where))),
        count: jest.fn(async (a: { where: unknown }) => rows.filter((r) => whereMatches(r, a.where)).length),
      },
    };
    const notifications = new NotificationsService(stub(db));
    const safety = new CommunitySafetyService(
      stub({ user: { findMany: jest.fn(async () => [{ id: STAFF }]) } }),
      stub<ModuleRef>({ get: (t: unknown) => (t === NotificationsService ? notifications : undefined) }),
    );

    await safety.alertStaff({ surface: 'post', posterId: POSTER, flag: true, page: true }, 'row-1');
    expect(rows).toHaveLength(1); // the row was written for the staff account

    const inbox = await notifications.listNotifications(STAFF, {});
    expect(inbox.items.map((r: { id: string }) => r.id)).toEqual([rows[0].id]);
    expect(inbox.unreadCount).toBe(1);
  });
});
