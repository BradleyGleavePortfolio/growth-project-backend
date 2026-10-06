import { CoachController } from '../src/coach/coach.controller';
import { CoachService } from '../src/coach/coach.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';

/** Typed test double: the fake implements only what the unit under test calls. */
function stub<T>(v: unknown): T {
  return v as T;
}
type CoachServiceArgs = ConstructorParameters<typeof CoachService>;
type CoachControllerArgs = ConstructorParameters<typeof CoachController>;

// UX-COACHLOOKUP-124: GET /coach/clients carries, per client, the latest
// logged day and the check-ins waiting for review, so the coach's Clients
// list can show how each client is doing without opening them. Every slice
// follows the client summary's per-scope consent rule; the profile is sent
// only with body-metrics consent; token columns never leave the server.

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function rosterRow(id: string, name: string) {
  return {
    id,
    name,
    email: `${id}@example.test`,
    role: 'student',
    coach_id: 'coach-A',
    archived_at: null,
    created_at: day('2026-09-01'),
    deletion_token_hash: 'hash-secret',
    deletion_token_expires_at: day('2026-12-01'),
    expo_push_token: 'ExponentPushToken[secret]',
    profile: { id: `p-${id}`, current_weight_lbs: 180, injuries: ['knee'] },
  };
}

function makePrisma(consentRows: Array<Record<string, unknown>>) {
  const maxBy = (rows: Array<{ user_id: string; date: string }>) =>
    jest.fn(async ({ where }: { where: { user_id: { in: string[] } } }) => {
      const out = new Map<string, Date>();
      for (const r of rows) {
        if (!where.user_id.in.includes(r.user_id)) continue;
        const d = day(r.date);
        const prev = out.get(r.user_id);
        if (!prev || d > prev) out.set(r.user_id, d);
      }
      return [...out].map(([user_id, date]) => ({ user_id, _max: { date } }));
    });
  const checkIns = [
    { user_id: 'c1', date: '2026-10-03', reviewed_by_coach: false },
    { user_id: 'c1', date: '2026-10-04', reviewed_by_coach: false },
    { user_id: 'c2', date: '2026-10-05', reviewed_by_coach: false },
  ];
  return {
    user: {
      findMany: jest.fn().mockResolvedValue([rosterRow('c1', 'Ana Lopez'), rosterRow('c2', 'Ben Cho')]),
    },
    clientCoachConsent: { findMany: jest.fn().mockResolvedValue(consentRows) },
    loggedFoodEntry: {
      groupBy: maxBy([
        { user_id: 'c1', date: '2026-10-05' },
        { user_id: 'c1', date: '2026-10-01' },
        { user_id: 'c2', date: '2026-10-06' },
      ]),
    },
    workoutSession: { groupBy: maxBy([{ user_id: 'c1', date: '2026-10-02' }, { user_id: 'c2', date: '2026-10-06' }]) },
    weightLog: { groupBy: maxBy([{ user_id: 'c1', date: '2026-10-06' }, { user_id: 'c2', date: '2026-10-06' }]) },
    checkIn: {
      groupBy: jest.fn(async (args: { where: { user_id: { in: string[] }; reviewed_by_coach?: boolean }; _count?: unknown }) => {
        const rows = checkIns.filter(
          (c) =>
            args.where.user_id.in.includes(c.user_id) &&
            (args.where.reviewed_by_coach === undefined || c.reviewed_by_coach === args.where.reviewed_by_coach),
        );
        const ids = [...new Set(rows.map((r) => r.user_id))];
        if (args._count) {
          return ids.map((user_id) => ({ user_id, _count: { _all: rows.filter((r) => r.user_id === user_id).length } }));
        }
        return ids.map((user_id) => ({
          user_id,
          _max: { date: rows.filter((r) => r.user_id === user_id).map((r) => day(r.date)).sort((a, b) => +b - +a)[0] },
        }));
      }),
    },
  };
}

const audit = stub<CoachServiceArgs[1]>({ write: jest.fn(async () => undefined) });
const consentService = stub<ConsentService>({}); // presence turns real gating on
const granted = (client_id: string, scope: string) => ({
  client_id,
  scope,
  granted_at: day('2026-09-02'),
  revoked_at: null,
});

describe('GET /coach/clients roster activity (UX-COACHLOOKUP-124)', () => {
  it('coach sees only the shared slices per client; profile only with body metrics; tokens never sent', async () => {
    const prisma = makePrisma([
      granted('c1', ConsentScope.FITNESS_FOOD_MACROS),
      granted('c1', ConsentScope.FITNESS_WORKOUTS),
      granted('c1', ConsentScope.FITNESS_HABITS_PROGRESS),
      // c2 granted food once and later revoked it: hidden.
      { ...granted('c2', ConsentScope.FITNESS_FOOD_MACROS), revoked_at: day('2026-09-10') },
    ]);
    const svc = new CoachService(stub<CoachServiceArgs[0]>(prisma), audit, consentService);
    const controller = new CoachController(
      svc,
      stub<CoachControllerArgs[1]>({ capture: jest.fn() }),
      stub<CoachControllerArgs[2]>({}),
    );

    const req = stub<Parameters<CoachController['getClients']>[0]>({ user: { id: 'coach-A', role: 'coach' } });
    const rows = await controller.getClients(req, 'all');

    expect(prisma.clientCoachConsent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ coach_id: 'coach-A', client_id: { in: ['c1', 'c2'] } }),
      }),
    );
    const [ana, ben] = rows;
    expect(ana.id).toBe('c1');
    expect(ana.activity).toEqual({
      shared: true,
      last_active_on: '2026-10-05',
      last_food_on: '2026-10-05',
      last_workout_on: '2026-10-02',
      last_weigh_in_on: null,
      last_check_in_on: '2026-10-04',
      check_ins_to_review: 2,
    });
    // No body-metrics consent: no profile, and the weigh-in is not counted.
    expect(ana.profile).toBeNull();
    expect(prisma.weightLog.groupBy).not.toHaveBeenCalled();

    expect(ben.activity).toEqual({
      shared: false,
      last_active_on: null,
      last_food_on: null,
      last_workout_on: null,
      last_weigh_in_on: null,
      last_check_in_on: null,
      check_ins_to_review: null,
    });
    expect(ben.profile).toBeNull();
    // c2's food rows were never read.
    expect(prisma.loggedFoodEntry.groupBy.mock.calls[0][0].where.user_id.in).toEqual(['c1']);

    for (const r of rows) {
      expect(r).not.toHaveProperty('deletion_token_hash');
      expect(r).not.toHaveProperty('deletion_token_expires_at');
      expect(r).not.toHaveProperty('expo_push_token');
      expect(r).toEqual(expect.objectContaining({ name: expect.any(String), email: expect.any(String), archived_at: null }));
    }
  });

  it('body-metrics consent sends the profile and counts the weigh-in toward last active', async () => {
    const prisma = makePrisma([
      granted('c1', ConsentScope.FITNESS_BODY_METRICS),
      granted('c1', ConsentScope.FITNESS_FOOD_MACROS),
    ]);
    const svc = new CoachService(stub<CoachServiceArgs[0]>(prisma), audit, consentService);
    const [ana] = await svc.withRosterActivity('coach-A', 'coach', await svc.getClients('coach-A', 'all', 'coach'));
    expect(ana.profile).toEqual(expect.objectContaining({ id: 'p-c1' }));
    expect(ana.activity.last_weigh_in_on).toBe('2026-10-06');
    expect(ana.activity.last_active_on).toBe('2026-10-06');
    expect(ana.activity.check_ins_to_review).toBeNull();
  });

  it('owner sees every slice without a consent read', async () => {
    const prisma = makePrisma([]);
    const svc = new CoachService(stub<CoachServiceArgs[0]>(prisma), audit, consentService);
    const rows = await svc.withRosterActivity('owner-1', 'owner', await svc.getClients('owner-1', 'all', 'owner'));
    expect(prisma.clientCoachConsent.findMany).not.toHaveBeenCalled();
    expect(rows[1].activity).toEqual(
      expect.objectContaining({ shared: true, last_active_on: '2026-10-06', check_ins_to_review: 1 }),
    );
    expect(rows[1].profile).toEqual(expect.objectContaining({ id: 'p-c2' }));
  });

  it('an empty page makes no extra queries', async () => {
    const prisma = makePrisma([]);
    const svc = new CoachService(stub<CoachServiceArgs[0]>(prisma), audit, consentService);
    expect(await svc.withRosterActivity('coach-A', 'coach', [])).toEqual([]);
    expect(prisma.clientCoachConsent.findMany).not.toHaveBeenCalled();
    expect(prisma.loggedFoodEntry.groupBy).not.toHaveBeenCalled();
  });
});
