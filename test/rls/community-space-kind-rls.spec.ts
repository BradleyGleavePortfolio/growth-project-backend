// C6-B1: a space's kind and posting policy decide who starts a message in it. Each coach starts with
// Announcements (the coach posts, clients reply in threads) and Everyone (open chat); a section takes nothing.
// Rows run as role authenticated; server paths run the real services. X, Y coach; I is X's client; Z is Y's
// client; N has no coach and joined X's public space. Every 0 or refusal follows a 1 for the same person.
import { randomUUID } from 'crypto';
import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { CommunityCohortWriteRepository } from '../../src/community/cohorts/community-cohort-write.repository';
import { CommunityCohortWriteService } from '../../src/community/cohorts/community-cohort-write.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import { CommunityVoiceService } from '../../src/community/voice/community-voice.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-space-kind-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'Z' | 'N';
type Space = 'ann' | 'all' | 'sec' | 'pub' | 'yann' | 'yall';
const PEOPLE: Key[] = ['X', 'Y', 'I', 'Z', 'N']; // coaches first: clients reference them
const SPACES: Space[] = ['ann', 'all', 'sec', 'pub', 'yann', 'yall'];
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', Z: 'Y', N: null };
const ROLE = (k: Key) => (k === 'X' || k === 'Y' ? 'coach' : 'student');
// Who reads each space (the C6-BVIS rule, unchanged) and who starts a message in it (C6-B1).
const READS: Record<Space, Key[]> = { ann: ['X', 'I'], all: ['X', 'I'], sec: ['X', 'I'], pub: ['X', 'N'], yann: ['Y', 'Z'], yall: ['Y', 'Z'] };
const STARTS: Record<Space, Key[]> = { ann: ['X'], all: ['X', 'I'], sec: [], pub: ['X', 'N'], yann: ['Y'], yall: ['Y', 'Z'] };
const REPLIES: Record<Space, Key[]> = { ...READS, sec: [] }; // a thread reply needs access only; a section takes none
const CONTROL: Record<Key, Space> = { X: 'ann', Y: 'yann', I: 'all', Z: 'yall', N: 'pub' };
const DENIED = '42501';
const READ_ONLY = 'community.space.read_only';
const REPLY = 'community_challenge_comment';

(DB_URL ? describe : describe.skip)('a space takes the messages its kind and posting policy allow', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const foundation = new CommunityRepository(db);
  const community = new CommunityService(db, foundation, stub<CommunitySafetyService>({}));
  const cohorts = new CommunityCohortWriteService(access, new CommunityCohortWriteRepository(db));
  const chat = new CommunityMessagesService(access, new CommunityMessagesRepository(db),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }), stub<PlanContextService>({}),
    stub<CommunitySafetyService>({ assertAllowed: () => undefined }), stub<CommunityNotificationsService>({ pushEnabled: () => false }));
  const voice = new CommunityVoiceService(access, stub<CommunityVoiceRepository>({}), stub<VoiceUploadProvider>({ bucket: () => 'voice-notes' }),
    stub<CommunityRealtimeService>({}), stub<AnalyticsService>({ capture: () => undefined }), stub<CommunitySafetyService>({}));
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const msg = uuids(SPACES);
  const space = uuids(['sec', 'pub'] as const) as Record<Space, string>;
  const ws = { X: '', Y: '' };
  const wsOf = (s: Space) => (s.startsWith('y') ? ws.Y : ws.X);
  const user = (k: Key) => {
    const coach = COACH[k];
    return stub<User>({ id: id[k], role: ROLE(k), coach_id: coach ? id[coach] : null });
  };

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const count = (k: Key, s: Space) =>
    as(k, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = ${msg[s]}::uuid`)
      .then((r) => r[0].n);
  const MESSAGE = `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "sender_id", "body", "plan_context_type", "plan_context_id", "updated_at")
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'cohort', $4, 'RLS message', $5::varchar, $6::uuid, now())`;
  // Rows written, or the SQLSTATE of the refusal.
  const write = async (k: Key, s: Space, type: string | null): Promise<number | string> => {
    try {
      return await as(k, (tx) => tx.$executeRawUnsafe(MESSAGE, randomUUID(), wsOf(s), space[s], id[k], type, type && randomUUID()));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const send = (k: Key, s: Space) => write(k, s, null);
  const reply = (k: Key, s: Space) => write(k, s, REPLY);
  // The server's answer: 'sent', or the refusal code.
  const outcome = (p: Promise<unknown>) => p.then(() => 'sent', (e: unknown) => {
    const body = e instanceof HttpException ? e.getResponse() : null;
    if (body && typeof body === 'object' && 'code' in body) return String(body.code);
    throw e;
  });
  const note = (s: Space) => ({ cohort_id: space[s], storage_key: 'not-a-minted-key', duration_ms: 5000, bytes: 1000, mime_type: 'audio/mp4' as const });
  const spacesOf = (c: 'X' | 'Y') => prisma.communityCohort.findMany({ where: { workspace_id: ws[c], sort_order: { lt: 2 } }, orderBy: { sort_order: 'asc' } });

  beforeAll(async () => {
    for (const k of PEOPLE) {
      const coach = COACH[k];
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`space-kind-${id[k]}`}, 'RLS person', ${ROLE(k)}::"Role", ${coach ? id[coach] : null})`;
    }
    for (const c of ['X', 'Y'] as const) {
      const made = await foundation.ensureWorkspaceForCoach(id[c]); // the real first-open bootstrap
      ws[c] = made?.id ?? '';
      const [ann, all] = await spacesOf(c);
      space[c === 'X' ? 'ann' : 'yann'] = ann.id;
      space[c === 'X' ? 'all' : 'yall'] = all.id;
    }
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "kind", "visibility", "sort_order", "updated_at")
      VALUES (${space.sec}::uuid, ${ws.X}::uuid, 'RLS section', 'section', 'clients', 2, now()),
             (${space.pub}::uuid, ${ws.X}::uuid, 'RLS public', 'chat', 'public', 3, now())`;
    await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
      VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${space.pub}::uuid, ${id.N}, 'student', 'active', now())`;
    for (const s of SPACES) await prisma.$executeRawUnsafe(MESSAGE, msg[s], wsOf(s), space[s], s.startsWith('y') ? id.Y : id.X, null, null);
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('the first open gives each coach Announcements and Everyone for all their clients, once; a renamed one stays renamed', async () => {
    const shape = async (c: 'X' | 'Y') => (await spacesOf(c)).map((r) => [r.name, r.kind, r.posting_policy, r.visibility]);
    const made = [['Announcements', 'announcement', 'coach', 'clients'], ['Everyone', 'chat', 'all', 'clients']];
    expect([await shape('X'), await shape('Y')]).toEqual([made, made]);
    await cohorts.update(user('X'), space.ann, { name: 'News' });
    expect([(await foundation.ensureWorkspaceForCoach(id.X))?.id, (await foundation.ensureWorkspaceForCoach(id.Y))?.id]).toEqual([ws.X, ws.Y]);
    expect([(await shape('X')).map(([n]) => n), await shape('Y')]).toEqual([['News', 'Everyone'], made]);
  });

  it.each(PEOPLE)('%s reads, starts and replies exactly where kind and posting policy allow, at the row layer and in the server', async (k) => {
    expect(await count(k, CONTROL[k])).toBe(1);
    for (const s of SPACES) {
      const reads = READS[s].includes(k);
      const starts = STARTS[s].includes(k);
      // A voice note first needs a space of that community that is not public (C6-BVIS, unchanged).
      const circle = SPACES.some((t) => t !== 'pub' && wsOf(t) === wsOf(s) && READS[t].includes(k));
      expect([s, await count(k, s)]).toEqual([s, reads ? 1 : 0]);
      expect([s, await send(k, s), await reply(k, s)]).toEqual([s, starts ? 1 : DENIED, REPLIES[s].includes(k) ? 1 : DENIED]);
      expect([s, await outcome(chat.send(user(k), space[s], 'RLS server message'))])
        .toEqual([s, starts ? 'sent' : reads ? READ_ONLY : 'community.message.not_found']);
      expect([s, await outcome(voice.create(user(k), wsOf(s), note(s)))]) // past the rule, the unminted key is refused
        .toEqual([s, !circle ? 'community.voice.not_found' : starts ? 'community.voice.storage_key_rejected' : reads ? READ_ONLY : 'community.voice.not_found']);
    }
  });

  it('the coach sets who starts a message in a space; another coach cannot', async () => {
    expect([await send('I', 'all'), await outcome(chat.send(user('I'), space.all, 'before'))]).toEqual([1, 'sent']);
    // SPACE-404-CLASS: Y cannot read X's space, so Y gets the same 404 as no space.
    await expect(cohorts.update(user('Y'), space.all, { posting_policy: 'coach' })).rejects.toBeInstanceOf(NotFoundException);
    expect(await send('I', 'all')).toBe(1);
    expect((await cohorts.update(user('X'), space.all, { posting_policy: 'coach' })).cohort.posting_policy).toBe('coach');
    expect([await count('I', 'all'), await send('I', 'all'), await reply('I', 'all'), await outcome(chat.send(user('I'), space.all, 'after'))])
      .toEqual([1, DENIED, 1, READ_ONLY]);
    expect([await send('X', 'all'), await outcome(chat.send(user('X'), space.all, 'coach'))]).toEqual([1, 'sent']);
    await cohorts.update(user('X'), space.all, { posting_policy: 'all' });
    expect(await send('I', 'all')).toBe(1);
  });

  it('the space list carries kind and posting policy, and never another coach\'s spaces', async () => {
    const listed = async (k: Key) => (await community.getCohorts(user(k))).cohorts.map((c) => [c.id, c.kind, c.posting_policy]);
    expect(await listed('I')).toEqual([[space.ann, 'announcement', 'coach'], [space.all, 'chat', 'all'], [space.sec, 'section', 'all']]);
    expect(await listed('Z')).toEqual([[space.yann, 'announcement', 'coach'], [space.yall, 'chat', 'all']]);
  });
});
