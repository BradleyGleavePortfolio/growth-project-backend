/**
 * ACTUAL-AUTHOR-READS-BE class test: every reader of a client thread's words
 * reads by who wrote each message, not only by the thread's coach/client pair.
 *
 * One client thread under head coach H, with words from H, the client C, a
 * team coach T (newest) and one removed row. Each row puts one block in place
 * (either way where it matters) and reads once. "hides" must be absent, "keeps"
 * present. Rows marked control read code this job does not change.
 *
 * R-AAR-1 (operator 192): the client's own AI follows what the client can read,
 * so a head <-> team coach block, which does not involve the client, keeps the
 * team coach's words there.
 */
import { randomUUID } from 'crypto';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { ClientContextService } from '../src/ai/context/client-context.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { PrivateContextService } from '../src/ai/gateway/private-context.service';
import { RomanClientContextService } from '../src/roman/context/roman-client-context.service';
import { RomanConsultationIntakeSource } from '../src/roman/context/roman-consultation.source';
import { RomanTimelineReader } from '../src/roman/memory/roman-timeline.reader';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { ls1197Database } from './ls-1197-live-fixture';

type Who = 'head' | 'team' | 'client';
type Row = {
  reader: string;
  block: [Who, Who] | null;
  read: () => Promise<unknown>;
  hides: Who[];
  keeps: Who[];
};

describe('ACTUAL-AUTHOR-READS-BE: readers of thread words honor the actual author block', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const id: Record<Who, string> = { head: randomUUID(), team: randomUUID(), client: randomUUID() };
  const words: Record<Who, string> = {
    head: 'AAR head coach words',
    team: 'AAR team coach words',
    client: 'AAR client own words',
  };
  let removedId = '';

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [who, role, coachId] of [
      ['head', 'coach', null],
      ['team', 'coach', null],
      ['client', 'student', 'head'],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id: id[who], role, coach_id: coachId ? id[coachId] : null, name: `Fixture ${who}`,
          email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: id.head, sub_coach_id: id.team, client_id: id.client },
    });
    const at = (ago: number) => new Date(Date.now() - ago);
    const removed = await fixture.prisma.coachMessage.create({
      data: { coach_id: id.head, client_id: id.client, sender_id: id.client,
        body: null, deleted_at: at(4000), created_at: at(5000) },
    });
    removedId = removed.id;
    for (const [who, ago] of [['head', 4000], ['client', 3000], ['team', 1000]] as const) {
      await fixture.prisma.coachMessage.create({
        data: { coach_id: id.head, client_id: id.client, sender_id: id[who],
          body: words[who], created_at: at(ago) },
      });
    }
  }, 240_000);
  afterAll(async () => { await fixture?.stop(); });

  const v1 = (sub: boolean) => Object.assign(Object.create(V1CoachService.prototype), {
    prisma: fixture.db,
    subCoachScope: {
      isSubCoach: async (who: string) => sub && who === id.team,
      getAuthorizedClientIds: async () => [id.client],
    },
  }) as V1CoachService;
  const thread = async (who: 'head' | 'team') => {
    const opened = await v1(who === 'team').getThread({ id: id[who], role: 'coach' }, id.client);
    // The removed row keeps its place in the detail, as before.
    expect(opened.messages.map((m) => m.id)).toContain(removedId);
    return opened;
  };
  const excerpt = async (viewer?: Who) =>
    (await new ClientContextService(fixture.db).build(id.client, viewer && id[viewer])).coach.last_coach_message_excerpt;
  const gateway = (caller: Who) => new PrivateContextService(fixture.db).loadClientContext(
    { id: id[caller], role: caller === 'client' ? 'student' : 'coach', coach_id: caller === 'client' ? id.head : null },
    id.client,
  );
  const selfAi = () => new ClientAIContextService(fixture.db).build(id.client);
  const roman = async () =>
    (await new RomanClientContextService(fixture.db, new RomanConsultationIntakeSource(fixture.db), grantAllEgress())
      .buildFresh({ id: id.client, role: 'student' })).rendered;
  const timeline = () => new RomanTimelineReader(fixture.db, grantAllEgress())
    .read(id.client, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000), now: new Date() });

  const rows: Row[] = [];
  for (const block of [['head', 'team'], ['team', 'head']] as [Who, Who][]) {
    rows.push(
      { reader: 'v1 thread detail, head coach', block, read: () => thread('head'), hides: ['team'], keeps: ['head', 'client'] },
      { reader: 'v1 thread detail, team coach', block, read: () => thread('team'), hides: ['head'], keeps: ['team', 'client'] },
      { reader: 'coach AI context, head coach', block, read: () => excerpt('head'), hides: ['team'], keeps: ['client'] },
      { reader: 'coach AI context, no viewer (thread coach)', block, read: () => excerpt(), hides: ['team'], keeps: ['client'] },
      { reader: 'coach AI context, team coach', block, read: () => excerpt('team'), hides: [], keeps: ['team'] },
      { reader: 'gateway context, head coach', block, read: () => gateway('head'), hides: ['team'], keeps: ['client'] },
      // R-AAR-1 controls: the client is not in this block.
      { reader: 'gateway self context (R-AAR-1)', block, read: () => gateway('client'), hides: [], keeps: ['team'] },
      { reader: 'client own AI context (R-AAR-1)', block, read: selfAi, hides: [], keeps: ['team', 'head', 'client'] },
    );
  }
  for (const block of [['client', 'team'], ['team', 'client']] as [Who, Who][]) {
    rows.push(
      { reader: 'gateway self context', block, read: () => gateway('client'), hides: ['team'], keeps: ['client'] },
      { reader: 'client own AI context', block, read: selfAi, hides: ['team'], keeps: ['head', 'client'] },
      { reader: 'Roman client context (control)', block, read: roman, hides: ['team'], keeps: [] },
      { reader: 'Roman timeline (control)', block, read: timeline, hides: ['team'], keeps: [] },
    );
  }
  // No block: nobody's words are lost.
  rows.push(
    { reader: 'v1 thread detail, head coach', block: null, read: () => thread('head'), hides: [], keeps: ['head', 'team', 'client'] },
    { reader: 'coach AI context, head coach', block: null, read: () => excerpt('head'), hides: [], keeps: ['team'] },
    { reader: 'gateway self context', block: null, read: () => gateway('client'), hides: [], keeps: ['team'] },
    { reader: 'client own AI context', block: null, read: selfAi, hides: [], keeps: ['head', 'team', 'client'] },
    { reader: 'Roman client context (control)', block: null, read: roman, hides: [], keeps: ['team'] },
    { reader: 'Roman timeline (control)', block: null, read: timeline, hides: [], keeps: ['team'] },
  );

  it.each(rows.map((r) => [`${r.reader} | ${r.block ? r.block.join(' blocks ') : 'no block'}`, r] as const))(
    '%s',
    async (_name, row) => {
      const pair = row.block && { blocker_id: id[row.block[0]], blocked_id: id[row.block[1]] };
      if (pair) await fixture.prisma.userBlock.create({ data: pair });
      try {
        const out = JSON.stringify(await row.read());
        for (const who of row.hides) expect(out).not.toContain(words[who]);
        for (const who of row.keeps) expect(out).toContain(words[who]);
      } finally {
        if (pair) await fixture.prisma.userBlock.deleteMany({ where: pair });
      }
    },
    120_000,
  );
});
