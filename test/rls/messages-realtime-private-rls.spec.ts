// MSGRT: coach-client message pings are private per person. A listener joins a topic only when it is their own:
// Realtime authorization runs the realtime.messages policies as the joining role with the topic in realtime.topic,
// as `listen` does here. Who hears a ping is decided at send time: the chat's two people, by the thread rule of the
// REST routes. PATHS walks every send path through the real services and the real SupabaseService.pingChat; only
// the Realtime client is a recorder. X, Y coach; I and M are X's clients (M is the third signed-in person); Z is Y's
// client. I then moves to Y, so X is a former coach. Every 0 follows a 1.
// Runs in the rls-live-tests job on a superuser copy of rls_replay. Gate: TEST_DATABASE_URL (CI=true without it fails).
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { cast } from '../engagement/_fake-db';
import type { PrismaService } from '../../src/prisma.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import { MessageActionsService } from '../../src/messaging/message-actions.service';
import { V1CoachService } from '../../src/v1/v1-coach.service';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { CapabilityMaterializerRegistry } from '../../src/ai/gateway/materialisers/capability-materialiser.registry';
import { COACH_MESSAGE_CAPABILITY, CoachMessageMaterializer } from '../../src/ai/gateway/materialisers/coach-message.materialiser';
import {
  COACH_WEARABLE_MESSAGE_CAPABILITY,
  CoachWearableMessageMaterializer,
} from '../../src/ai/gateway/materialisers/coach-wearable-message.materialiser';
import { AutoMessageAssetResolver } from '../../src/packages/asset-resolvers/auto-message.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { BroadcastDispatcherService } from '../../src/broadcasts/broadcast-dispatcher.service';
import { BroadcastScopeService } from '../../src/broadcasts/broadcast-scope.service';
import { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('messages-realtime-private-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'M' | 'Z';
type Listener = Key | 'anon' | 'nobody';
type Row = [string, () => Promise<unknown>, string | number, string[]];
const PEOPLE: Key[] = ['X', 'Y', 'I', 'M', 'Z']; // coaches first: clients reference them
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', M: 'X', Z: 'Y' };
const DENIED = '42501';
const FLAGS = ['FEATURE_MESSAGING_CORE_V2', 'FEATURE_COACH_BROADCASTS'];

(DB_URL ? describe : describe.skip)('message pings: own private topic only, the chat\'s two people at send time', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = cast<PrismaService>(prisma);
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const topic = (k: Key) => `messages:user:${id[k]}`;
  const prevFlags = FLAGS.map((f) => process.env[f]);

  // Runs `query` as the listener's role and session, with the joining topic set.
  const as = <T>(who: Listener, topicOf: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who === 'anon' ? 'anon' : 'authenticated'}`);
      const claims = who === 'anon' ? { role: 'anon' } : { sub: who === 'nobody' ? randomUUID() : sub[who], role: 'authenticated' };
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify(claims));
      await tx.$executeRawUnsafe(`SELECT set_config('realtime.topic', $1, true)`, topic(topicOf));
      return query(tx);
    });
  const listen = (who: Listener, topicOf: Key, extension: string) =>
    as(who, topicOf, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM realtime.messages WHERE "topic" = $1 AND "extension" = $2`, topic(topicOf), extension))
      .then((r) => r[0].n);

  // The real sender with a Realtime client that records each send.
  const sent: { topic: string; private: unknown; event: string; payload: unknown }[] = [];
  const client = {
    channel: (name: string, opts: { config: { private?: boolean } }) => ({
      httpSend: async (event: string, payload: unknown) => {
        sent.push({ topic: name, private: opts.config.private, event, payload });
        return { success: true };
      },
    }),
    removeChannel: async () => 'ok',
  };
  const supabase = Object.assign(Object.create(SupabaseService.prototype) as SupabaseService, { getClient: () => client });
  const spy = jest.spyOn(supabase, 'pingChat');
  const heard = () => sent.map((s) => `${PEOPLE.find((k) => topic(k) === s.topic) ?? s.topic} ${s.event}`
    + `${s.private === true ? '' : ' (not private)'}${JSON.stringify(s.payload) === '{}' ? '' : ' (with payload)'}`).sort();
  const hears = async (run: () => Promise<unknown>) => {
    sent.length = 0;
    spy.mockClear();
    const outcome = await run().then((r) => (typeof r === 'string' ? r : 'ok'),
      (e: { getStatus?: () => number }) => e.getStatus?.() ?? String(e));
    await Promise.all(spy.mock.results.map((r) => r.value)); // every ping has been sent
    return { outcome, hears: heard() };
  };

  const quiet = async () => undefined;
  const messaging = new MessagingService(db, supabase, cast({ capture: quiet }), cast({ emit: quiet }),
    cast({ emit: quiet }), cast({ write: quiet }), cast({ invalidateForUser: quiet }));
  const actions = new MessageActionsService(db, messaging, cast({ write: quiet }));
  const v1 = new V1CoachService(db, supabase, cast({ write: quiet }));
  const approvals = new AiApprovalService(db, cast({ write: quiet }), new CapabilityMaterializerRegistry([
    new CoachMessageMaterializer(db, messaging), new CoachWearableMessageMaterializer(db, messaging)]));
  const autoMessage = new AutoMessageAssetResolver(messaging, new ResolverSubCoachScope(
    cast({ canAccessClient: async () => true, getHeadCoachIdForSubCoach: async () => null })), db);
  const dispatcher = new BroadcastDispatcherService(db, new BroadcastScopeService(new SubCoachScopeService(db), db),
    new SegmentResolverService(db), supabase, cast({ emit: quiet }));

  const draft = { reply: randomUUID(), insight: randomUUID() };
  const welcome = { jobId: randomUUID(), lease: randomUUID() };
  const delivery = { before: '', after: '' };
  const msg = { coach: '', client: '' };
  const voiceOf = (k: Key) => ({ url: `${process.env.SUPABASE_URL}/storage/v1/object/public/voice-notes/${id[k]}/n.m4a`,
    duration_sec: 30, size_bytes: 200_000, content_type: 'audio/m4a' });
  const approve = (draftId: string) => () => approvals.decide({ draftId, decider: { id: id.X, role: 'coach' }, decision: 'approved' });
  const coachThread = () => messaging.resolveThreadForCoach(id.X, id.I);
  const clientThread = () => messaging.resolveThreadForClient(id.I);
  const broadcastTo = async (k: Key) => {
    const [b, r] = [randomUUID(), randomUUID()];
    await prisma.coachBroadcast.create({ data: { id: b, coach_id: id.X, author_user_id: id.X, status: 'sending',
      body: 'Hi all', segment: {}, timezone: 'UTC', urgent: true } });
    await prisma.coachBroadcastRun.create({ data: { id: r, broadcast_id: b, run_key: new Date().toISOString(),
      scheduled_for: new Date(), status: 'delivering', body: 'Hi all', segment: {}, urgent: true } });
    return (await prisma.coachBroadcastDelivery.create({ data: { run_id: r, broadcast_id: b, recipient_id: id[k],
      deliver_after: new Date(Date.now() - 60_000) } })).id;
  };

  beforeAll(async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`msgrt-${id[k]}`}, 'RLS person', ${k === 'X' || k === 'Y' ? 'coach' : 'student'}::"Role",
                ${COACH[k] ? id[COACH[k] as Key] : null})`;
      for (const extension of ['broadcast', 'presence']) {
        await prisma.$executeRaw`INSERT INTO realtime.messages ("topic", "extension") VALUES (${topic(k)}, ${extension})`;
      }
    }
    const roman = (draftId: string, capability: string, payload: Prisma.InputJsonObject) => prisma.aiActionDraft.create({
      data: { id: draftId, capability, tenant_coach_id: id.X, subject_user_id: id.I, payload: { clientId: id.I, ...payload } },
    });
    await roman(draft.reply, COACH_MESSAGE_CAPABILITY, { body: 'Roman drafted this reply' });
    await roman(draft.insight, COACH_WEARABLE_MESSAGE_CAPABILITY, { bucket: 'SLEEP_RECOVERY', body: 'Roman drafted this' });
    await prisma.coachWelcomeMessageJob.create({
      data: { id: welcome.jobId, client_id: id.I, coach_id: id.X, completed_at: new Date(), fire_at: new Date(),
        status: 'sending', lease_token: welcome.lease },
    });
    delivery.before = await broadcastTo('I');
    delivery.after = await broadcastTo('I');
  });
  afterAll(async () => {
    FLAGS.forEach((f, i) => {
      if (prevFlags[i] === undefined) delete process.env[f];
      else process.env[f] = prevFlags[i];
    });
    spy.mockRestore();
    await prisma.$disconnect();
  });

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', 'I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('a signed-in person joins their own topic and no other; signed-out readers get nothing', async () => {
    const joins: [string, Listener, Key, string, number][] = [
      ['I (client), own topic', 'I', 'I', 'broadcast', 1],
      ['X (I\'s coach), own topic', 'X', 'X', 'broadcast', 1],
      ['X, I\'s topic', 'X', 'I', 'broadcast', 0],
      ['I, X\'s topic', 'I', 'X', 'broadcast', 0],
      ['M (a third signed-in person), own topic', 'M', 'M', 'broadcast', 1],
      ['M, I\'s topic', 'M', 'I', 'broadcast', 0],
      ['M, X\'s topic', 'M', 'X', 'broadcast', 0],
      ['Z (another coach\'s client), I\'s topic', 'Z', 'I', 'broadcast', 0],
      ['Y (another coach), X\'s topic', 'Y', 'X', 'broadcast', 0],
      ['signed out, I\'s topic', 'anon', 'I', 'broadcast', 0],
      ['signed out, X\'s topic', 'anon', 'X', 'broadcast', 0],
      ['a session that is nobody, I\'s topic', 'nobody', 'I', 'broadcast', 0],
      ['I, own topic, presence', 'I', 'I', 'presence', 0],
    ];
    for (const [label, who, topicOf, extension, n] of joins) {
      expect({ label, n: await listen(who, topicOf, extension) }).toEqual({ label, n });
    }
  });

  it('nobody but the server sends, not even on their own topic', async () => {
    expect(await listen('I', 'I', 'broadcast')).toBe(1);
    const sendOwn = as('I', 'I', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO realtime.messages ("topic", "extension") VALUES ($1, 'broadcast')`, topic('I')));
    const err = await sendOwn.then(() => null, (e: { code?: string; meta?: { code?: string } }) => e);
    expect(String(err?.code === 'P2010' ? err.meta?.code : err?.code)).toBe(DENIED);
  });

  it('every send path pings the chat\'s two people on private topics, empty payload; after a move the former coach hears nothing', async () => {
    const both = (event: string) => [`I ${event}`, `X ${event}`];
    const PATHS: Row[] = [
      ['coach composer, text', async () => { msg.coach = (await messaging.sendAsCoach(id.X, id.I, { body: 'Hi' })).id; }, 'ok', both('new-message')],
      ['coach composer, voice note', () => messaging.sendAsCoach(id.X, id.I, { voice: voiceOf('X') }), 'ok', both('new-message')],
      ['client reply, text', async () => { msg.client = (await messaging.sendAsClient(id.I, { body: 'Thanks' })).id; }, 'ok', both('new-message')],
      ['client reply, voice note', () => messaging.sendAsClient(id.I, { voice: voiceOf('I') }), 'ok', both('new-message')],
      ['Roman reply draft, approved', approve(draft.reply), 'ok', both('new-message')],
      ['Roman wearable insight, approved', approve(draft.insight), 'ok', both('new-message')],
      ['coach welcome', () => messaging.sendAsCoach(id.X, id.I, { body: 'Welcome' }, { welcome }), 'ok', both('new-message')],
      ['package auto-message', () => autoMessage.materialise({ coachId: id.X, clientId: id.I, assetId: randomUUID(),
        displayCaption: 'Week 2' }), 'ok', both('new-message')],
      ['v1 coach composer', () => v1.sendMessage({ id: id.X, role: 'coach' }, id.I, 'Hello'), 'ok', both('new-message')],
      ['coach broadcast, delivered', () => dispatcher.deliverOne(delivery.before, new Date()), 'delivered', both('new-message')],
      ['coach read receipt', () => messaging.markReadByCoach(id.X, id.I), 'ok', both('thread-updated')],
      ['client read receipt', () => messaging.markReadByClient(id.I), 'ok', both('thread-updated')],
      ['coach edits a message', async () => actions.edit(await coachThread(), msg.coach, 'Hi again'), 'ok', both('thread-updated')],
      ['client deletes their message', async () => actions.delete(await clientThread(), msg.client), 'ok', both('thread-updated')],
      ['coach pins a message', async () => actions.pin(await coachThread(), msg.coach), 'ok', both('thread-updated')],
      ['coach unpins it', async () => actions.unpin(await coachThread(), msg.coach), 'ok', both('thread-updated')],
    ];
    for (const [path, run, outcome, people] of PATHS) {
      expect({ path, ...(await hears(run)) }).toEqual({ path, outcome, hears: people });
    }
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.Y} WHERE "id" = ${id.I}`;
    const MOVED: Row[] = [
      ['X (former coach) sends I a message', () => messaging.sendAsCoach(id.X, id.I, { body: 'Hi' }), 404, []],
      ['X sends through the v1 composer', () => v1.sendMessage({ id: id.X, role: 'coach' }, id.I, 'Hi'), 404, []],
      ['X marks I\'s messages read', () => messaging.markReadByCoach(id.X, id.I), 404, []],
      ['a broadcast X queued before the move', () => dispatcher.deliverOne(delivery.after, new Date()), 'skipped_ineligible', []],
      ['I pins a message in the old chat', async () => actions.pin(await clientThread(), msg.coach), 404, []],
      ['I sends a message: their new coach hears it', () => messaging.sendAsClient(id.I, { body: 'Hello' }), 'ok', ['I new-message', 'Y new-message']],
    ];
    for (const [path, run, outcome, people] of MOVED) {
      expect({ path, ...(await hears(run)) }).toEqual({ path, outcome, hears: people });
    }
  });
});
