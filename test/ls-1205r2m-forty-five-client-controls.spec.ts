/**
 * LS-1205R2M: normal single-coach scope, with 45 solely assigned clients.
 * No owner account or shared assignment. A block involving one client must
 * not hide this coach's own autosave in any other client's conversation.
 */
import { randomUUID } from 'crypto';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1205R2M: one coach, 45 clients, no owner-account block', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let service: V1CoachService;
  const head = randomUUID();
  const unrelated = randomUUID();
  const clients = Array.from({ length: 45 }, () => randomUUID());
  const blockedClient = clients[0];
  const caller = { id: head, role: 'coach' as const };
  const scenarios = [
    { label: 'no block', pair: null, closesClient: false },
    { label: 'coach blocks one client', pair: [head, blockedClient], closesClient: true },
    { label: 'one client blocks coach', pair: [blockedClient, head], closesClient: true },
    { label: 'coach blocks unrelated coach', pair: [head, unrelated], closesClient: false },
    { label: 'unrelated coach blocks coach', pair: [unrelated, head], closesClient: false },
  ];

  beforeAll(async () => {
    fixture = await ls1197Database();
    await fixture.prisma.user.createMany({
      data: [
        ...[head, unrelated].map((id) => ({
          id, role: 'coach' as const, name: 'Solo control coach',
          email: randomUUID(), supabase_id: randomUUID(),
        })),
        ...clients.map((id) => ({
          id, role: 'student' as const, coach_id: head, name: 'Solo control client',
          email: randomUUID(), supabase_id: randomUUID(),
        })),
      ],
    });
    service = new V1CoachService(
      fixture.db, stub({}), stub({}), new SubCoachScopeService(fixture.db),
    );
  }, 240_000);

  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.messageDraft.deleteMany({});
  });
  afterAll(async () => { await fixture?.stop(); });

  it.each(scenarios)('$label: preserve every open conversation autosave', async (scenario) => {
    expect(await fixture.prisma.user.count({ where: { coach_id: head, role: 'student' } })).toBe(45);
    expect(await fixture.prisma.user.count({ where: { role: 'owner' } })).toBe(0);
    expect(await fixture.prisma.subCoachAssignment.count()).toBe(0);
    for (const client of clients) {
      await service.saveDraft(caller, client, `initial solo reply for ${client}`);
    }
    if (scenario.pair) {
      await fixture.prisma.userBlock.create({
        data: { blocker_id: scenario.pair[0], blocked_id: scenario.pair[1] },
      });
    }
    for (const client of clients) {
      if (scenario.closesClient && client === blockedClient) {
        expect(await service.getDraft(caller, client)).toBeNull();
        const thread = await service.getThread(caller, client);
        expect(thread.draft).toBeNull();
        expect(thread.messages).toEqual([]);
        continue;
      }
      const initial = `initial solo reply for ${client}`;
      expect(await service.getDraft(caller, client)).toMatchObject({ body: initial });
      expect((await service.getThread(caller, client)).draft).toMatchObject({ body: initial });
      const fresh = `fresh solo reply for ${client}`;
      expect(await service.saveDraft(caller, client, fresh)).toMatchObject({
        body: fresh, cleared: false,
      });
      expect(await service.getDraft(caller, client)).toMatchObject({ body: fresh });
      expect((await service.getThread(caller, client)).draft).toMatchObject({ body: fresh });
    }
    expect(await fixture.prisma.messageDraft.count()).toBe(45);
  }, 120_000);
});
