import { V1CoachService } from '../src/v1/v1-coach.service';
import { randomUUID } from 'crypto';
import { ls1197Database } from './ls-1197-live-fixture';

describe('LS-1197R2 B1: opening the filtered v1 row', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const coach = randomUUID();
  const client = randomUUID();
  const author = randomUUID();
  const visibleBody = 'Allowed client message';
  const hiddenBody = 'Blocked team author private words';
  let visibleId: string;
  let hiddenId: string;

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coachId] of [
      [coach, 'coach', null],
      [client, 'student', coach],
      [author, 'coach', coach],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id: coachId, name: 'Review fixture',
          email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    const visible = await fixture.prisma.coachMessage.create({
      data: { coach_id: coach, client_id: client, sender_id: client,
        body: visibleBody, created_at: new Date(Date.now() - 2000) },
    });
    const hidden = await fixture.prisma.coachMessage.create({
      data: { coach_id: coach, client_id: client, sender_id: author,
        body: hiddenBody, created_at: new Date(Date.now() - 1000) },
    });
    visibleId = visible.id;
    hiddenId = hidden.id;
  }, 240_000);
  afterAll(async () => {
    await fixture?.stop();
  });

  it.each(['viewer-blocks-author', 'author-blocks-viewer'] as const)(
    'does not reveal the excluded team author after list -> open (%s)',
    async (direction) => {
      const service = Object.assign(Object.create(V1CoachService.prototype), {
        prisma: fixture.db,
      }) as V1CoachService;
      const caller = { id: coach, role: 'coach' as const };
      expect(JSON.stringify(await service.getThread(caller, client))).toContain(hiddenBody);
      const pair = {
        blocker_id: direction === 'viewer-blocks-author' ? coach : author,
        blocked_id: direction === 'viewer-blocks-author' ? author : coach,
      };
      await fixture.prisma.userBlock.create({ data: pair });
      try {
        const listed = await service.listThreads(caller);
        expect(JSON.stringify(listed)).toContain(visibleBody);
        expect(JSON.stringify(listed)).not.toContain(hiddenBody);
        const opened = await service.getThread(caller, client);
        expect(opened.messages.map((message) => message.id)).toContain(visibleId);
        expect(opened.messages.map((message) => message.id)).not.toContain(hiddenId);
        expect(JSON.stringify(opened)).not.toContain(hiddenBody);
      } finally {
        await fixture.prisma.userBlock.deleteMany({ where: pair });
      }
    },
  );
});
