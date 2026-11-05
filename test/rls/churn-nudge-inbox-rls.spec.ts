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
 * B-LONOTIFY3-1 / B-LSNOTIFY3-3 (FR-NOTIFY4, owner #169-5 "Dissapear"; block
 * contract b#1141 6354139283): while the coach and the client are in a block,
 * either way, the nudge is not listed, not counted and not marked; nothing is
 * deleted and unblock brings it back. The same rule covers the AI-drafted
 * notice the coach approved and the coach's message notices for that chat.
 * CPC-W2 (owner 10-27 DECISIONS #178-3): the lock screen reads as a new message.
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ChurnInterventionService } from '../../src/coach/command-center/churn-intervention.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { InboxBlockRule } from '../../src/notifications/inbox-block-rule';
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
  const interventionB = randomUUID();
  const sendKey = randomUUID();
  // As NotificationsModule wires it: the inbox's block rule (B-LONOTIFY3-1).
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma), undefined, undefined, undefined,
    new InboxBlockRule(stub<ConstructorParameters<typeof InboxBlockRule>[0]>(prisma)),
  );
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
    await prisma.churnIntervention.create({
      data: { id: interventionB, coach_id: id.K, client_id: id.B, draft_text: 'Hi', idempotency_key: randomUUID() },
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
      // B-LONOTIFY3-1: the row names its coach, so a block can hide it.
      payload: { title: 'Message from your coach', nudge_id: nudgeId, coach_id: id.K },
    });
    rowId = rows[0].id;
    expect((await prisma.churnIntervention.findUnique({ where: { id: interventionId } }))?.status).toBe('sent');
  });

  it('the push (no token here) names that row and the inbox screen; the lock screen reads as a new message (CPC-W2)', async () => {
    expect(pushes).toHaveBeenCalledTimes(1);
    const [to, title, body, data] = pushes.mock.calls[0];
    expect(to).toBe(id.A);
    expect({ title, body }).toEqual({
      title: 'New message',
      body: 'You have a new message. Open the app to read it.',
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
  it('(failed before) B-LONOTIFY3-1: a block either way hides the nudge from the list, the badge and the read marks; unblock restores it', async () => {
    // Controls that must stay listed for the client through a block: a row with
    // no payload, and a coach_nudge row whose payload has no coach_id (a JSON
    // path that is SQL NULL). And another client of the same coach.
    const plain = await prisma.notification.create({
      data: { user_id: id.A, kind: 'milestone_reached', channel: 'inapp', body: 'You hit a milestone' },
    });
    const other = await prisma.notification.create({
      data: { user_id: id.A, kind: 'coach_nudge', channel: 'inapp', body: 'From the app', payload: { title: 'Update' } },
    });
    await service.sendIntervention(id.K, interventionB, { message_text: 'Hi B', idempotency_key: randomUUID() });
    const listed = async (who: Key) =>
      (await notifications.listNotifications(id[who], {})).items.map((n) => n.id).sort();
    const visible = [plain.id, other.id].sort();

    for (const [blocker, blocked] of [['A', 'K'], ['K', 'A']] as const) {
      await prisma.userBlock.create({ data: { blocker_id: id[blocker], blocked_id: id[blocked] } });
      expect(await listed('A')).toEqual(visible);
      expect(await notifications.getUnreadCount(id.A)).toBe(2); // the bell badge counts the nudge 0
      await expect(notifications.markRead(rowId, id.A)).rejects.toThrow('Notification not found');
      // Control: the coach's other client is not in a block and still has theirs.
      const b = await notifications.listNotifications(id.B, {});
      expect(b.items.map((n) => n.body)).toEqual(['Hi B']);
      await prisma.userBlock.deleteMany({ where: { blocker_id: id[blocker], blocked_id: id[blocked] } });
      // Unblock: back as it was, still unread.
      expect(await listed('A')).toEqual([...visible, rowId].sort());
      expect(await notifications.getUnreadCount(id.A)).toBe(3);
    }

    // Mark all read during a block leaves the hidden row unread.
    await prisma.userBlock.create({ data: { blocker_id: id.A, blocked_id: id.K } });
    expect(await notifications.markAllRead(id.A)).toEqual({ updated: 2 });
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.A, blocked_id: id.K } });
    expect(await notifications.getUnreadCount(id.A)).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: rowId } })).read_at).toBeNull();
    expect(await prisma.notification.count({ where: { user_id: id.A, kind: 'coach_nudge' } })).toBe(2);
  });

  it('(failed before) the same rule hides what else names the other person: the AI notice they approved, and the chat\'s message notices', async () => {
    // The AI-drafted notice the coach approved (send-notification materialiser
    // shape, payload.approvedByCoachId) in the client's inbox.
    const ai = await prisma.notification.create({
      data: {
        user_id: id.A, kind: 'coach_nudge', channel: 'push', body: 'A note from your coach',
        payload: { aiDraftId: randomUUID(), authoredBy: 'ai', approvedByCoachId: id.K },
      },
    });
    // The coach's message notices (MessageReceivedEmitter shape: the thread is
    // the client) for the chat with A, and for the chat with B (control).
    const withA = await prisma.notification.create({
      data: {
        user_id: id.K, kind: 'message_received', channel: 'inapp', body: 'New message from RLS user',
        deep_link: `tgp://messages/${id.A}`, payload: { senderName: 'RLS user', threadId: id.A },
      },
    });
    const withB = await prisma.notification.create({
      data: {
        user_id: id.K, kind: 'message_received', channel: 'inapp', body: 'New message from RLS user',
        deep_link: `tgp://messages/${id.B}`, payload: { senderName: 'RLS user', threadId: id.B },
      },
    });
    const listed = async (who: Key) =>
      (await notifications.listNotifications(id[who], {})).items.map((n) => n.id);
    expect(await listed('A')).toContain(ai.id);
    expect(await listed('K')).toEqual(expect.arrayContaining([withA.id, withB.id]));

    await prisma.userBlock.create({ data: { blocker_id: id.K, blocked_id: id.A } });
    expect(await listed('A')).not.toContain(ai.id);
    const coach = await listed('K');
    expect(coach).not.toContain(withA.id);
    expect(coach).toContain(withB.id);
    const coachUnread = await notifications.getUnreadCount(id.K);
    await expect(notifications.markRead(withA.id, id.K)).rejects.toThrow('Notification not found');

    await prisma.userBlock.deleteMany({ where: { blocker_id: id.K, blocked_id: id.A } });
    expect(await listed('A')).toContain(ai.id);
    expect(await listed('K')).toEqual(expect.arrayContaining([withA.id, withB.id]));
    expect(await notifications.getUnreadCount(id.K)).toBe(coachUnread + 1);
  });

  it('(failed before) the client\'s side of the chat: the coach\'s message notices leave the client\'s inbox and badge in a block either way; unblock restores them', async () => {
    // MessageReceivedEmitter shape for a client reader: the thread is the
    // client, so the link is the reader's own chat; the body names the coach.
    const toA = await prisma.notification.create({
      data: {
        user_id: id.A, kind: 'message_received', channel: 'inapp', body: 'New message from RLS user',
        deep_link: `tgp://messages/${id.A}`, payload: { senderName: 'RLS user', threadId: id.A },
      },
    });
    // Control: the coach's other client, not in a block.
    const toB = await prisma.notification.create({
      data: {
        user_id: id.B, kind: 'message_received', channel: 'inapp', body: 'New message from RLS user',
        deep_link: `tgp://messages/${id.B}`, payload: { senderName: 'RLS user', threadId: id.B },
      },
    });
    const listed = async (who: Key) =>
      (await notifications.listNotifications(id[who], {})).items.map((n) => n.id);
    const unreadA = await notifications.getUnreadCount(id.A);
    expect(await listed('A')).toContain(toA.id);

    for (const [blocker, blocked] of [['A', 'K'], ['K', 'A']] as const) {
      await prisma.userBlock.create({ data: { blocker_id: id[blocker], blocked_id: id[blocked] } });
      expect(await listed('A')).not.toContain(toA.id);
      // The nudge and the AI notice from the cases above name the coach too,
      // so they leave as well: prove this row is not counted by reading it
      // directly and seeing the badge stay the same.
      const badge = await notifications.getUnreadCount(id.A);
      expect(badge).toBeLessThan(unreadA);
      await prisma.notification.update({ where: { id: toA.id }, data: { read_at: new Date() } });
      expect(await notifications.getUnreadCount(id.A)).toBe(badge);
      await prisma.notification.update({ where: { id: toA.id }, data: { read_at: null } });
      await expect(notifications.markRead(toA.id, id.A)).rejects.toThrow('Notification not found');
      expect(await listed('B')).toContain(toB.id);
      await prisma.userBlock.deleteMany({ where: { blocker_id: id[blocker], blocked_id: id[blocked] } });
      expect(await listed('A')).toContain(toA.id);
      expect(await notifications.getUnreadCount(id.A)).toBe(unreadA);
    }
  });
});
