import { NotFoundException } from '@nestjs/common';
import { MacrosService } from '../src/macros/macros.service';
import type { PrismaService } from '../src/prisma.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';

// A target set by coach-A stays with the client when they move to coach-B.
// The fake answers like the database: `coach_id` is the coach who set the
// target, `client.coach_id` is the client's coach now.
function setup() {
  const coachOf: Record<string, string> = { 'client-1': 'coach-A' };
  const targets = [
    { id: 't-1', client_id: 'client-1', coach_id: 'coach-A', archived_at: null as Date | null },
  ];
  const matches = (t: (typeof targets)[number], where: any) =>
    t.id === where.id &&
    (where.coach_id === undefined || t.coach_id === where.coach_id) &&
    (where.client === undefined || coachOf[t.client_id] === where.client.coach_id) &&
    t.archived_at === where.archived_at;
  const prisma = {
    macroTarget: {
      findFirst: jest.fn(async ({ where }: any) => targets.find((t) => matches(t, where)) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = targets.filter((t) => matches(t, where));
        hit.forEach((t) => Object.assign(t, data));
        return { count: hit.length };
      }),
    },
  };
  const svc = new MacrosService(fakeOf<PrismaService>(prisma));
  return { svc, targets, move: () => (coachOf['client-1'] = 'coach-B') };
}

describe('MacrosService coach access follows the client', () => {
  it('the current coach reads and archives the target', async () => {
    const { svc, targets } = setup();
    expect((await svc.getOneByCoach('coach-A', 't-1')).id).toBe('t-1');
    expect(await svc.archiveByCoach('coach-A', 't-1')).toEqual({ archived: 1 });
    expect(targets[0].archived_at).toBeInstanceOf(Date);
  });

  it('after the client moves, the former coach gets the same 404 as a missing target', async () => {
    const { svc, targets, move } = setup();
    move();
    await expect(svc.getOneByCoach('coach-A', 't-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.archiveByCoach('coach-A', 't-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(targets[0].archived_at).toBeNull();
  });

  it('after the client moves, the new coach reads and archives the earlier target', async () => {
    const { svc, targets, move } = setup();
    move();
    expect((await svc.getOneByCoach('coach-B', 't-1')).id).toBe('t-1');
    expect(await svc.archiveByCoach('coach-B', 't-1')).toEqual({ archived: 1 });
    expect(targets[0].archived_at).toBeInstanceOf(Date);
  });
});
