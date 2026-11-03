/**
 * LO-1205 B-TEST (lens probe, never merged): a team coach in a block with the
 * CLIENT (either way) opens that chat empty in the v1 detail (control), so the
 * coach AI context built for that team coach must carry none of the thread's
 * words either. Expected red at b#1205 head 12f5cdd4.
 */
import { randomUUID } from 'crypto';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { ClientContextService } from '../src/ai/context/client-context.service';
import { ls1197Database } from './ls-1197-live-fixture';

type Who = 'head' | 'team' | 'client';

describe('LO-1205 B-TEST: team coach in a block with the client', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const id: Record<Who, string> = { head: randomUUID(), team: randomUUID(), client: randomUUID() };
  const words: Record<Who, string> = { head: 'LO head words', team: 'LO team words', client: 'LO client words' };

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [who, role, coachId] of [['head', 'coach', null], ['team', 'coach', null], ['client', 'student', 'head']] as const) {
      await fixture.prisma.user.create({
        data: { id: id[who], role, coach_id: coachId ? id[coachId] : null, name: `LO ${who}`, email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({ data: { head_coach_id: id.head, sub_coach_id: id.team, client_id: id.client } });
    for (const [who, ago] of [['client', 3000], ['team', 2000], ['head', 1000]] as const) {
      await fixture.prisma.coachMessage.create({
        data: { coach_id: id.head, client_id: id.client, sender_id: id[who], body: words[who], created_at: new Date(Date.now() - ago) },
      });
    }
  }, 240_000);
  afterAll(async () => { await fixture?.stop(); });

  const v1 = () => Object.assign(Object.create(V1CoachService.prototype), {
    prisma: fixture.db,
    subCoachScope: { isSubCoach: async (who: string) => who === id.team, getAuthorizedClientIds: async () => [id.client] },
  }) as V1CoachService;

  for (const block of [['client', 'team'], ['team', 'client']] as [Who, Who][]) {
    it(`${block.join(' blocks ')}: v1 detail (control) and coach AI context both carry no thread words for the team coach`, async () => {
      const pair = { blocker_id: id[block[0]], blocked_id: id[block[1]] };
      await fixture.prisma.userBlock.create({ data: pair });
      try {
        const detail = await v1().getThread({ id: id.team, role: 'coach' }, id.client);
        expect(detail.messages).toHaveLength(0); // control: the chat opens empty for the team coach
        const ctx = await new ClientContextService(fixture.db).build(id.client, id.team);
        expect(JSON.stringify(ctx)).not.toContain(words.head);
        expect(ctx.coach.last_coach_message_excerpt).toBeNull();
      } finally {
        await fixture.prisma.userBlock.deleteMany({ where: pair });
      }
    }, 120_000);
  }
});
