// The coach digest's check-in numbers follow the client's current coach and
// the client's "Check-ins and habits" switch. Fails on main: the numbers were
// keyed on the coach stamped on each check-in, so a moved client's check-ins
// kept counting for the former coach. The unread-messages count likewise
// leaves out the moved client's old thread (owner 4, GAPS1).
import { ConfigService } from '@nestjs/config';
import { ConsentService } from '../src/consent/consent.service';
import { DigestService } from '../src/notifications/digest.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';

type Where = { coach_id?: string; user_id?: { in: string[] } };

it("coach digest: a moved client's check-ins and unread messages leave the former coach's numbers; unshared ones are left out", async () => {
  // client-1 moved from coach-A to coach-B; client-2 turned check-in sharing off.
  const coachOf: Record<string, string> = { 'client-1': 'coach-B', 'client-2': 'coach-B' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = [
    { user_id: 'client-1', coach_id: 'coach-A', date: today }, // logged before the move
    { user_id: 'client-2', coach_id: 'coach-B', date: today },
  ];
  const match = (w: Where) =>
    rows.filter(
      (r) => (w.coach_id === undefined || w.coach_id === r.coach_id) && (!w.user_id || w.user_id.in.includes(r.user_id)),
    );

  const prisma = Object.create(PrismaService.prototype);
  Object.defineProperty(prisma, 'user', {
    value: {
      findMany: async ({ where }: { where: { coach_id: string } }) =>
        Object.keys(coachOf)
          .filter((id) => coachOf[id] === where.coach_id)
          .map((id) => ({ id, name: `Client ${id}` })),
      findUnique: async () => ({ role: 'coach' }),
    },
  });
  Object.defineProperty(prisma, 'checkIn', {
    value: {
      count: async ({ where }: { where: Where }) => match(where).length,
      findMany: async ({ where }: { where: Where }) => match(where).map((r) => ({ user_id: r.user_id })),
    },
  });
  // client-1 wrote to coach-A before the move and to coach-B after it; both unread.
  const messages = [
    { coach_id: 'coach-A', client_id: 'client-1', sender_id: 'client-1', read_at: null },
    { coach_id: 'coach-B', client_id: 'client-1', sender_id: 'client-1', read_at: null },
  ];
  type MessageWhere = { coach_id: string; client?: { coach_id: string }; sender_id: { not: string } };
  Object.defineProperty(prisma, 'coachMessage', {
    value: {
      count: async ({ where }: { where: MessageWhere }) =>
        messages.filter(
          (m) =>
            m.coach_id === where.coach_id &&
            (!where.client || coachOf[m.client_id] === where.client.coach_id) &&
            m.sender_id !== where.sender_id.not,
        ).length,
    },
  });
  const consent = Object.create(ConsentService.prototype);
  Object.defineProperty(consent, 'grantedScopesByClient', {
    value: async (_coach: string, ids: string[], scopes: string[]) =>
      new Map(ids.filter((id) => id !== 'client-2').map((id) => [id, new Set(scopes)])),
  });
  const svc = new DigestService(prisma, Object.create(NotificationsService.prototype), new ConfigService({}), consent);

  const former = await svc['_buildCoachDigestData']('coach-A', 'weekly');
  expect(former.rosterStats).toMatchObject({
    activeCount: 0,
    checkinsToday: 0,
    weeklyCheckinsCount: 0,
    unreadMessages: 0,
  });

  const current = await svc['_buildCoachDigestData']('coach-B', 'weekly');
  expect(current.rosterStats).toMatchObject({
    activeCount: 2,
    checkinsToday: 1,
    weeklyCheckinsCount: 1,
    needingReview: 0,
    unreadMessages: 1, // only the thread with coach-B; the old thread never reaches the new coach
    avgConsistencyPct: 14, // 1 check-in / (1 sharing client x 7 days)
  });
  expect(current.alertClients).toEqual([]);
});
