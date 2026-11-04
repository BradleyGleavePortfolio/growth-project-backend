/**
 * LS-1205 B2: the canonical coach inbox must pick the newest readable
 * author before selecting one row per thread. A blocked newest author
 * must not erase the preview of an older, still-readable client message.
 */
import { randomUUID } from 'crypto';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { MessagingInboxService } from '../src/messaging/messaging-inbox.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1205 B2: coach inbox selects the newest actual-author-readable preview', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let inbox: MessagingInboxService;
  const head = randomUUID();
  const team = randomUUID();
  const client = randomUUID();
  const teamWords = 'LS1205 newest team message';
  const clientWords = 'LS1205 allowed client message';

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', null], [client, 'student', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205 inbox fixture', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: head, sub_coach_id: team, client_id: client },
    });
    for (const [sender_id, body, ago] of [
      [client, clientWords, 4000], [team, teamWords, 2000],
    ] as const) {
      await fixture.prisma.coachMessage.create({
        data: { coach_id: head, client_id: client, sender_id, body, created_at: new Date(Date.now() - ago) },
      });
    }
    const scope = new SubCoachScopeService(fixture.db);
    const safety = new MessagesSafetyService(fixture.db, stub({}), stub({}));
    const messaging = new MessagingService(
      fixture.db, stub({}), stub({}), stub({}), stub({}), stub({}),
      new ClientAIContextService(fixture.db), safety, scope,
    );
    inbox = new MessagingInboxService(fixture.db, messaging, scope);
  }, 240_000);
  afterEach(async () => { await fixture.prisma.userBlock.deleteMany({}); });
  afterAll(async () => { await fixture?.stop(); });

  it.each(['head blocks team', 'team blocks head', 'no block'] as const)('%s', async (direction) => {
    if (direction !== 'no block') {
      const [blocker_id, blocked_id] = direction === 'head blocks team' ? [head, team] : [team, head];
      await fixture.prisma.userBlock.create({ data: { blocker_id, blocked_id } });
    }
    const response = await inbox.inboxForCoach(head, {});
    expect(response.items).toHaveLength(1);
    expect(response.items[0].client_id).toBe(client);
    expect(response.items[0].last_message?.preview).toBe(direction === 'no block' ? teamWords : clientWords);
  }, 120_000);
});
