import {
  DAY1_SESSION_TYPES,
  parseSeedArgs,
  planSeed,
  seedCoachTypes,
} from '../scripts/seed-coach-session-types';

const coachId = '12345678-1234-1234-1234-123456789abc';
const existing = DAY1_SESSION_TYPES.map((spec, i) => ({
  ...spec,
  id: `type-${i}`,
  archived_at: null,
}));

describe('C04 appointment type seed', () => {
  it('plans the approved durations and approval settings', () => {
    expect(planSeed([]).map((a) => [a.spec.duration_minutes, a.spec.auto_approve])).toEqual([
      [15, true],
      [20, true],
      [45, false],
    ]);
    expect(DAY1_SESSION_TYPES[2].description).toContain('not medical care');
  });

  it('preserves existing rows, coach edits and archives', () => {
    expect(planSeed(existing).every((a) => a.kind === 'keep' && !a.drift)).toBe(true);
    const plan = planSeed([
      { ...existing[0], duration_minutes: 30 },
      { ...existing[1], archived_at: new Date() },
    ]);
    expect(plan[0]).toMatchObject({ kind: 'keep', drift: true, id: 'type-0' });
    expect(plan[1]).toMatchObject({ kind: 'keep', archived: true, id: 'type-1' });
    expect(plan[2]).toMatchObject({ kind: 'create' });
  });

  it('rejects ambiguous duplicate rows rather than selecting silently', () => {
    expect(() => planSeed([existing[0], { ...existing[0], id: 'duplicate' }])).toThrow(
      'Multiple appointment types',
    );
  });

  it('requires a coach ID and explicit apply; rejects unknown flags', () => {
    expect(parseSeedArgs(['--coach-id', coachId])).toEqual({ coachId, apply: false });
    expect(parseSeedArgs(['--apply', '--coach-id', coachId])).toEqual({ coachId, apply: true });
    for (const args of [[], ['--coach-id', 'bad'], ['--coach-id', coachId, '--reset']]) {
      expect(() => parseSeedArgs(args)).toThrow('Dry run');
    }
  });

  it('dry run performs no writes; apply only creates missing types', async () => {
    const tx = {
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'coach' }) },
      sessionType: {
        findMany: jest.fn().mockResolvedValue([existing[0]]),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    await seedCoachTypes(prisma as never, coachId, false);
    expect(tx.sessionType.create).not.toHaveBeenCalled();
    await seedCoachTypes(prisma as never, coachId, true);
    expect(tx.sessionType.create).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    tx.user.findUnique.mockResolvedValueOnce({ role: 'student' });
    await expect(seedCoachTypes(prisma as never, coachId, true)).rejects.toThrow('Complete coach signup');
  });
});
