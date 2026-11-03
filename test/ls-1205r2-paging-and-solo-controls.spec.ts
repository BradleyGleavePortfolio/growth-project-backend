/**
 * Independent LS-1205R2 controls, never a product change.
 * Exercise the phone's normal 100-row cursor across more than three pages
 * and a solo coach's own composer draft with no relevant block.
 */
import { randomUUID } from 'crypto';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1205R2: readable history cursor and normal solo composer', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let messaging: MessagingService;
  let v1: V1CoachService;
  const head = randomUUID();
  const team = randomUUID();
  const client = randomUUID();
  const solo = randomUUID();
  const soloClient = randomUUID();
  const unrelated = randomUUID();
  const allIds: string[] = [];
  const hiddenIds = new Set<string>();
  const removedIds = new Set<string>();
  const originalFlag = process.env.FEATURE_MESSAGING_CORE_V2;

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', head], [client, 'student', head],
      [solo, 'coach', null], [soloClient, 'student', solo], [unrelated, 'coach', null],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205R2 control', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: head, sub_coach_id: team, client_id: client },
    });
    const now = Date.now();
    await fixture.prisma.coachMessage.createMany({
      data: Array.from({ length: 412 }, (_, index) => {
        const id = randomUUID();
        allIds.push(id);
        const removed = index === 6 || index === 211;
        if (removed) removedIds.add(id);
        const hidden = !removed && index % 5 === 0;
        if (hidden) hiddenIds.add(id);
        return {
          id, coach_id: head, client_id: client,
          sender_id: index === 211 ? null : hidden ? team : index % 2 ? client : head,
          body: removed ? null : `LS1205R2 message ${index}`,
          created_at: new Date(now - index * 1000),
          ...(removed ? { deleted_at: new Date(now - index * 1000 + 10) } : {}),
        };
      }),
    });
    const scope = new SubCoachScopeService(fixture.db);
    messaging = new MessagingService(
      fixture.db, stub({}), stub({}), stub({}), stub({}), stub({}),
      new ClientAIContextService(fixture.db),
      new MessagesSafetyService(fixture.db, stub({}), stub({})), scope,
    );
    v1 = new V1CoachService(fixture.db, stub({}), stub({}), scope);
  }, 240_000);

  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.messageDraft.deleteMany({});
    if (originalFlag === undefined) delete process.env.FEATURE_MESSAGING_CORE_V2;
    else process.env.FEATURE_MESSAGING_CORE_V2 = originalFlag;
  });
  afterAll(async () => { await fixture?.stop(); });

  for (const flag of ['true', 'false']) {
    for (const viewer of ['coach', 'client'] as const) {
      for (const direction of ['viewer blocks author', 'author blocks viewer'] as const) {
        it(`${flag} / ${viewer} / ${direction}: pages retain every allowed row exactly once, including removed placeholders`, async () => {
          process.env.FEATURE_MESSAGING_CORE_V2 = flag;
          const reader = viewer === 'coach' ? head : client;
          await fixture.prisma.userBlock.create({
            data: direction === 'viewer blocks author'
              ? { blocker_id: reader, blocked_id: team }
              : { blocker_id: team, blocked_id: reader },
          });
          const expected = allIds.filter((id) => !hiddenIds.has(id));
          const collected: string[] = [];
          let before: string | undefined;
          let pages = 0;
          while (pages < 6) {
            const opts = { limit: 100, ...(before ? { before } : {}) };
            const rows = viewer === 'coach'
              ? await messaging.listThreadForCoach(head, client, opts)
              : await messaging.listThreadForClient(client, opts);
            pages += 1;
            collected.push(...rows.map((row) => row.id));
            if (rows.length < 100) break;
            before = new Date(rows[rows.length - 1].created_at).toISOString();
          }
          expect(pages).toBe(4);
          expect(collected).toEqual(expected);
          expect(new Set(collected).size).toBe(collected.length);
          for (const id of removedIds) expect(collected).toContain(id);
        }, 120_000);
      }
    }
  }

  it.each(['no block', 'solo blocks unrelated', 'unrelated blocks solo'] as const)(
    '%s: a normal solo coach can save, resume and open their own composer text',
    async (direction) => {
      const caller = { id: solo, role: 'coach' as const };
      const words = 'LS1205R2 solo coach own autosave';
      await v1.saveDraft(caller, soloClient, words);
      if (direction !== 'no block') {
        await fixture.prisma.userBlock.create({
          data: direction === 'solo blocks unrelated'
            ? { blocker_id: solo, blocked_id: unrelated }
            : { blocker_id: unrelated, blocked_id: solo },
        });
      }
      expect(await v1.getDraft(caller, soloClient)).toMatchObject({ body: words });
      expect((await v1.getThread(caller, soloClient)).draft).toMatchObject({ body: words });
    },
    120_000,
  );
});
