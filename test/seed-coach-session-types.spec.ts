import { DAY1_SESSION_TYPES, planSeed, type ExistingType } from '../scripts/seed-coach-session-types';

const row = (over: Partial<ExistingType>): ExistingType => ({
  id: 'x',
  name: 'n',
  description: null,
  duration_minutes: 30,
  auto_approve: false,
  is_welcome: false,
  archived_at: null,
  ...over,
});

describe('seed-coach-session-types planSeed (S-SCHED)', () => {
  it('day-1 set: exactly one welcome type, 15/20/45 min, approval only on the 45', () => {
    expect(DAY1_SESSION_TYPES.filter((t) => t.is_welcome).map((t) => t.duration_minutes)).toEqual([15]);
    expect(DAY1_SESSION_TYPES.map((t) => [t.duration_minutes, t.auto_approve])).toEqual([
      [15, true],
      [20, true],
      [45, false],
    ]);
    for (const t of DAY1_SESSION_TYPES) {
      expect(`${t.name} ${t.description ?? ''}`).not.toMatch(/!/);
    }
  });

  it('empty coach: creates all three', () => {
    expect(planSeed([], DAY1_SESSION_TYPES).map((a) => a.kind)).toEqual(['create', 'create', 'create']);
  });

  it('re-running after apply is a no-op', () => {
    const existing = DAY1_SESSION_TYPES.map((s, i) => row({ ...s, id: `t${i}` }));
    expect(planSeed(existing, DAY1_SESSION_TYPES).map((a) => a.kind)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  it('matches the existing welcome type even if the coach renamed it', () => {
    const existing = [row({ id: 'w', name: 'Hello call', duration_minutes: 15, auto_approve: true, is_welcome: true })];
    const plan = planSeed(existing, DAY1_SESSION_TYPES);
    expect(plan[0]).toMatchObject({ kind: 'update', id: 'w' });
    expect(plan[1].kind).toBe('create');
  });

  it('ignores archived rows and never matches a non-welcome entry to the welcome type', () => {
    const existing = [
      row({ id: 'arch', name: 'Quick Q/A Call', archived_at: new Date() }),
      row({ id: 'w', name: 'Quick Q/A Call', is_welcome: true }),
    ];
    const plan = planSeed(existing, DAY1_SESSION_TYPES);
    expect(plan[0]).toMatchObject({ id: 'w' });
    expect(plan[1].kind).toBe('create');
  });
});
