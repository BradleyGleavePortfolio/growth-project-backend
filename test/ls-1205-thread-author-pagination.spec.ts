/**
 * LS-1205 B3: blocking a team author in an ordinary existing conversation
 * must not produce an empty first page while allowed client history exists.
 * The standard first page is 50 rows; these fixtures use 50 recent team
 * messages and one older client message, not an artificial one-row limit.
 */
import { randomUUID } from 'crypto';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1205 B3: live thread authors are filtered before the standard page limit', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let messaging: MessagingService;
  let ai: ClientAIContextService;
  const head = randomUUID();
  const team = randomUUID();
  const client = randomUUID();
  const teamWords = 'LS1205 team history';
  const clientWords = 'LS1205 allowed older client message';

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', null], [client, 'student', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205 thread fixture', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: head, sub_coach_id: team, client_id: client },
    });
    await fixture.prisma.coachMessage.create({
      data: { coach_id: head, client_id: client, sender_id: client, body: clientWords, created_at: new Date(Date.now() - 100_000) },
    });
    await fixture.prisma.coachMessage.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        coach_id: head, client_id: client, sender_id: team,
        body: `${teamWords} ${index}`, created_at: new Date(Date.now() - index * 1000),
      })),
    });
    ai = new ClientAIContextService(fixture.db);
    const scope = new SubCoachScopeService(fixture.db);
    const safety = new MessagesSafetyService(fixture.db, stub({}), stub({}));
    messaging = new MessagingService(
      fixture.db, stub({}), stub({}), stub({}), stub({}), stub({}), ai, safety, scope,
    );
  }, 240_000);
  afterEach(async () => { await fixture.prisma.userBlock.deleteMany({}); });
  afterAll(async () => { await fixture?.stop(); });

  it.each(['head blocks team', 'team blocks head'] as const)('%s: head first page keeps allowed history', async (direction) => {
    const [blocker_id, blocked_id] = direction === 'head blocks team' ? [head, team] : [team, head];
    await fixture.prisma.userBlock.create({ data: { blocker_id, blocked_id } });
    const rows = await messaging.listThreadForCoach(head, client);
    expect(JSON.stringify(rows)).toContain(clientWords);
    expect(JSON.stringify(rows)).not.toContain(teamWords);
  });
  it.each(['client blocks team', 'team blocks client'] as const)('%s: client first page keeps own history', async (direction) => {
    const [blocker_id, blocked_id] = direction === 'client blocks team' ? [client, team] : [team, client];
    await fixture.prisma.userBlock.create({ data: { blocker_id, blocked_id } });
    const rows = await messaging.listThreadForClient(client);
    expect(JSON.stringify(rows)).toContain(clientWords);
    expect(JSON.stringify(rows)).not.toContain(teamWords);
  });
  it.each(['coach', 'client'] as const)('no block: %s keeps the newest 50 team messages', async (viewer) => {
    const rows = viewer === 'coach'
      ? await messaging.listThreadForCoach(head, client) : await messaging.listThreadForClient(client);
    expect(rows).toHaveLength(50);
    expect(JSON.stringify(rows)).toContain(teamWords);
  });
  it.each(['client blocks team', 'team blocks client', 'head blocks team', 'team blocks head'] as const)(
    'warm client context immediately follows its own block graph: %s', async (direction) => {
      expect(JSON.stringify((await ai.build(client)).coach)).toContain(teamWords);
      const pair = direction === 'client blocks team' ? [client, team]
        : direction === 'team blocks client' ? [team, client]
        : direction === 'head blocks team' ? [head, team] : [team, head];
      await fixture.prisma.userBlock.create({ data: { blocker_id: pair[0], blocked_id: pair[1] } });
      const blocked = JSON.stringify((await ai.build(client)).coach);
      if (direction.includes('client')) {
        expect(blocked).not.toContain(teamWords);
        expect(blocked).toContain(clientWords);
      } else expect(blocked).toContain(teamWords);
      await fixture.prisma.userBlock.deleteMany({});
      expect(JSON.stringify((await ai.build(client)).coach)).toContain(teamWords);
    },
  );
});
