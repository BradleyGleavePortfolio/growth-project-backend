/**
 * B-LSNOTIFY-2 (FR-NOTIFY2, agent 177; b#1171 AUDIT 6426427779) on real
 * Postgres: a coach's churn nudge reaches the client's inbox, whole, and only
 * that client can read it.
 *
 * The client's inbox (Home bell -> NotificationCenter -> GET /notifications)
 * reads Notification rows; the nudge used to live only in CoachNudge. The real
 * ChurnInterventionService.sendIntervention now writes the inbox row in the
 * same transaction as the nudge. This suite runs it against a superuser copy
 * of rls_replay (the whole migration chain), then reads the inbox through the
 * real NotificationsService.listNotifications, then checks the row rule
 * (notification_owner_access, 20270410000000) as the request role: the client
 * reads it (control); another client, the coach and another coach read none.
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ChurnInterventionService } from '../../src/coach/command-center/churn-intervention.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('churn-nudge-inbox-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'K' | 'L' | 'A' | 'B';
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', B: 'student' };
const COACH_OF: Partial<Record<Key, Key>> = { A: 'K', B: 'K' };
// 1000 characters (the send limit), far over the 160 the generic writer keeps.
const MESSAGE = `Hi, your weigh-in is up 3 kg this week. ${'Call me tonight and we will adjust the plan together. '.repeat(20)}`
  .slice(0, 999)
  .trimEnd()
  .padEnd(1000, '!');

(DB_URL ? describe : describe.skip)('B-LSNOTIFY-2: the churn nudge reaches the client inbox on Postgres', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['K', 'L', 'A', 'B'];
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const interventionId = randomUUID();
  const sendKey = randomUUID();
  const notifications = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma));
  const service = new ChurnInterventionService(
    stub<ConstructorParameters<typeof ChurnInterventionService>[0]>(prisma),
    stub<ConstructorParameters<typeof ChurnInterventionService>[1]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[2]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[3]>({}),
    notifications,
  );
  const pushes = jest.spyOn(notifications, 'pushToUser');

  // Count the nudge's inbox rows as a request user (the row rule applies).
  const inboxRowsAs = (who: Key, rowId: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who]);
      const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS "n" FROM "Notification" WHERE "id" = $1`, rowId);
      return rows[0].n;
    });

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const k of keys) {
      const coach = COACH_OF[k] ? id[COACH_OF[k] as Key] : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`churn-nudge-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    await prisma.churnIntervention.create({
      data: { id: interventionId, coach_id: id.K, client_id: id.A, draft_text: 'Hi', idempotency_key: randomUUID() },
    });
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.$disconnect();
  });

  let rowId = '';
  let nudgeId = '';

  it('the send commits the nudge and its inbox row together, with the whole message', async () => {
    const out = await service.sendIntervention(id.K, interventionId, { message_text: MESSAGE, idempotency_key: sendKey });
    nudgeId = out.nudge_id;
    expect(MESSAGE.length).toBe(1000);
    const nudge = await prisma.coachNudge.findUnique({ where: { id: nudgeId } });
    expect(nudge).toMatchObject({ client_id: id.A, coach_id: id.K, body: MESSAGE });
    const rows = await prisma.notification.findMany({ where: { user_id: id.A, kind: 'coach_nudge' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'inapp',
      body: MESSAGE,
      deep_link: null,
      read_at: null,
      inbox_hidden: false,
      payload: { title: 'Message from your coach', nudge_id: nudgeId },
    });
    rowId = rows[0].id;
    expect((await prisma.churnIntervention.findUnique({ where: { id: interventionId } }))?.status).toBe('sent');
  });

  it('the push (no token here) names that row and the inbox screen; the lock screen line is generic', async () => {
    expect(pushes).toHaveBeenCalledTimes(1);
    const [to, title, body, data] = pushes.mock.calls[0];
    expect(to).toBe(id.A);
    expect({ title, body }).toEqual({
      title: 'The Growth Project',
      body: 'You have a new notification. Open the app to see it.',
    });
    expect(data).toEqual({
      type: 'coach_nudge',
      kind: 'coach_nudge',
      actionScreen: 'NotificationCenter',
      nudge_id: nudgeId,
      notification_id: rowId,
    });
    await expect(pushes.mock.results[0].value).resolves.toEqual({ delivered: false, code: 'no-token' });
  });

  it('the client inbox (GET /notifications) lists it whole and counts it unread', async () => {
    const page = await notifications.listNotifications(id.A, {});
    expect(page.items.map((n) => n.id)).toEqual([rowId]);
    expect(page.items[0].body).toBe(MESSAGE);
    expect(await notifications.getUnreadCount(id.A)).toBe(1);
    expect((await notifications.listNotifications(id.B, {})).items).toEqual([]);
  });

  it('the same send again writes no second row and sends no second push', async () => {
    const again = await service.sendIntervention(id.K, interventionId, { message_text: MESSAGE, idempotency_key: sendKey });
    expect(again.nudge_id).toBe(nudgeId);
    expect(await prisma.notification.count({ where: { user_id: id.A, kind: 'coach_nudge' } })).toBe(1);
    expect(pushes).toHaveBeenCalledTimes(1);
  });

  it('tenancy: the client reads the row (control); another client, the coach and another coach read none', async () => {
    expect(await inboxRowsAs('A', rowId)).toBe(1);
    expect(await inboxRowsAs('B', rowId)).toBe(0);
    expect(await inboxRowsAs('K', rowId)).toBe(0);
    expect(await inboxRowsAs('L', rowId)).toBe(0);
  });
});
