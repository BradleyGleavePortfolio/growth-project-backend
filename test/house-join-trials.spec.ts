// HOUSE-SERVER (agent 167) — owner "#166-6 HOUSE-TRIALS - offer no free
// trials from the house in v1". A house package that offers a free trial is
// not part of the house door: the list leaves it out and the detail answers
// the same 404 as any other cross-coach package, while a paid house package
// stays on the door. The live-DB proof of all three checkout paths is in
// test/rls/house-join-rls.spec.ts; this spec pins the rule itself.
import type { CoachPackage } from '@prisma/client';
import { ClientPackagesController } from '../src/packages/packages.controller';
import { freeTrialPackage, houseJoinToBuy } from '../src/checkout/plan-renewal/house-join';
import { readPlanRenewal } from '../src/checkout/plan-renewal/plan-renewal.state';
import { makeFakePrisma } from './support/b-recur-fakes';
import { stub } from './utils/trial-fakes';

jest.mock('../src/checkout/plan-renewal/plan-renewal.state', () => ({
  ...jest.requireActual('../src/checkout/plan-renewal/plan-renewal.state'),
  readPlanRenewal: jest.fn(),
}));

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const HOUSE = '44444444-4444-4444-8444-444444444444';

function pkgRow(id: string, over: Record<string, unknown> = {}): CoachPackage {
  return stub<CoachPackage>({
    id,
    coach_id: HOUSE,
    name: id,
    description: null,
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    recurring_stripe_price_id: null,
    stripe_price_id: null,
    trial_days: 0,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    ...over,
  });
}

const PAID = pkgRow('house-monthly');
const TRIAL = pkgRow('house-trial', { trial_days: 7 });
const ONE_TIME = pkgRow('house-one-time', { billing_type: 'one_time', interval: null });

describe('HOUSE-SERVER — no free trials through the house door (#166-6)', () => {
  const env = { ...process.env };
  const read = jest.mocked(readPlanRenewal);
  beforeEach(() => {
    process.env.FEATURE_PLAN_RENEWAL = 'true';
    process.env.HOUSE_COACH_USER_ID = HOUSE;
    // The client's plan with COACH ended on day 3: the house door is open.
    read.mockReset();
    read.mockResolvedValue(
      stub<Awaited<ReturnType<typeof readPlanRenewal>>>({
        state: 'ended',
        banner_due: true,
        coach: { id: COACH },
        house_coach: { id: HOUSE },
      }),
    );
  });
  afterAll(() => {
    process.env = env;
  });

  function build(rows: CoachPackage[]) {
    const packages = {
      listPublicForCoach: jest.fn(async (coachId: string) =>
        rows.filter((r) => r.coach_id === coachId),
      ),
      getById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    };
    const trials = { offersForClient: jest.fn(async () => new Map()) };
    return new ClientPackagesController(
      stub<ConstructorParameters<typeof ClientPackagesController>[0]>(packages),
      stub<ConstructorParameters<typeof ClientPackagesController>[1]>(makeFakePrisma()),
      stub<ConstructorParameters<typeof ClientPackagesController>[2]>(trials),
    );
  }
  const req = stub<Parameters<ClientPackagesController['list']>[0]>({
    user: { id: CLIENT, coach_id: COACH },
  });

  it('freeTrialPackage: a renewing package with trial days; never a one-time or trial-less package', () => {
    expect([PAID, TRIAL, ONE_TIME].map(freeTrialPackage)).toEqual([false, true, false]);
  });

  it('the house list leaves the free-trial package out and keeps the paid ones', async () => {
    const res = await build([PAID, TRIAL, ONE_TIME]).list(req, HOUSE);
    expect(res.packages.map((p) => p.id).sort()).toEqual([ONE_TIME.id, PAID.id].sort());
  });

  it('the detail of a free-trial house package is the cross-coach 404; a paid one opens', async () => {
    const controller = build([PAID, TRIAL]);
    await expect(controller.detail(req, TRIAL.id)).rejects.toMatchObject({
      response: { code: 'PACKAGE_NOT_FOUND' },
    });
    await expect(controller.detail(req, PAID.id)).resolves.toMatchObject({ id: PAID.id });
  });

  it('houseJoinToBuy (every checkout path): null for a free-trial package, the coach left for a paid one', async () => {
    const db = stub<Parameters<typeof houseJoinToBuy>[0]>({});
    await expect(houseJoinToBuy(db, CLIENT, TRIAL)).resolves.toBeNull();
    await expect(houseJoinToBuy(db, CLIENT, PAID)).resolves.toBe(COACH);
  });
});
