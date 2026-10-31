import { randomUUID } from 'crypto';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { ClientContextService } from '../src/ai/context/client-context.service';
import { ls1197Database } from './ls-1197-live-fixture';

describe('LS-1197R2 B2: structured AI preview honors the actual author block', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const head = randomUUID();
  const client = randomUUID();
  const team = randomUUID();
  const control = 'Allowed head coach message';
  const hidden = 'Blocked team coach private message';

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coachId] of [
      [head, 'coach', null],
      [client, 'student', head],
      [team, 'coach', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id: coachId, name: 'Review fixture',
          email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.coachMessage.create({
      data: { coach_id: head, client_id: client, sender_id: head,
        body: control, created_at: new Date(Date.now() - 2000) },
    });
    await fixture.prisma.coachMessage.create({
      data: { coach_id: head, client_id: client, sender_id: team,
        body: hidden, created_at: new Date(Date.now() - 1000) },
    });
  }, 240_000);
  afterAll(async () => { await fixture?.stop(); });

  it.each(['client-blocks-author', 'author-blocks-client'] as const)(
    'does not put the excluded author in coach AI context (%s)',
    async (direction) => {
      const structured = new ClientContextService(fixture.db);
      expect((await structured.build(client)).coach.last_coach_message_excerpt).toBe(hidden);
      const pair = {
        blocker_id: direction === 'client-blocks-author' ? client : team,
        blocked_id: direction === 'client-blocks-author' ? team : client,
      };
      await fixture.prisma.userBlock.create({ data: pair });
      try {
        // The other context builder's sender-id check is a negative control.
        const gateway = await new ClientAIContextService(fixture.db).build(client);
        expect(JSON.stringify(gateway)).toContain(control);
        expect(JSON.stringify(gateway)).not.toContain(hidden);
        const result = await structured.build(client);
        expect(JSON.stringify(result)).not.toContain(hidden);
      } finally {
        await fixture.prisma.userBlock.deleteMany({ where: pair });
      }
    },
  );
});
