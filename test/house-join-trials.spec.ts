// HOUSE-SERVER (agent 167) — owner "#166-6 HOUSE-TRIALS - offer no free
// trials from the house in v1". A house package that offers a free trial is
// not part of the house door: the list leaves it out and the detail answers
// the same 404 as any other cross-coach package, while a paid house package
// stays on the door. The live-DB proof of all three checkout paths is in
// test/rls/house-join-rls.spec.ts; this spec pins the rule itself.
import { Logger } from '@nestjs/common';
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
/** Any other coach's package: the cross-coach 404 the trial package must match. */
const OTHER = pkgRow('other-coach', { coach_id: '55555555-5555-4555-8555-555555555555' });

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
    const db = makeFakePrisma();
    db._users.push({ id: HOUSE, role: 'coach' });
    return new ClientPackagesController(
      stub<ConstructorParameters<typeof ClientPackagesController>[0]>(packages),
      stub<ConstructorParameters<typeof ClientPackagesController>[1]>(db),
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
    const controller = build([PAID, TRIAL, OTHER]);
    const refusal = (id: string) =>
      controller.detail(req, id).then(
        () => 'opened',
        (e: { getStatus(): number; getResponse(): unknown }) => [e.getStatus(), e.getResponse()],
      );
    const crossCoach = await refusal(OTHER.id);
    expect(crossCoach).toEqual([404, { error: 'PACKAGE_NOT_FOUND', message: 'Package not available' }]);
    expect(await refusal(TRIAL.id)).toEqual(crossCoach);
    await expect(controller.detail(req, PAID.id)).resolves.toMatchObject({ id: PAID.id });
  });

  /** A database whose house account has `role`. */
  const houseIs = (role: string) =>
    stub<Parameters<typeof houseJoinToBuy>[0]>({ user: { findUnique: async () => ({ role }) } });

  it('houseJoinToBuy (every checkout path): null for a free-trial package, the coach left for a paid one', async () => {
    const db = houseIs('coach');
    await expect(houseJoinToBuy(db, CLIENT, TRIAL)).resolves.toBeNull();
    await expect(houseJoinToBuy(db, CLIENT, PAID)).resolves.toBe(COACH);
  });

  it('b#1131 LO N3: the door is closed, with one log line, unless the house account is a coach', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await Promise.all(['owner', 'student', 'sub_coach'].map((r) => houseJoinToBuy(houseIs(r), CLIENT, PAID))))
        .toEqual([null, null, null]);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith('house join closed: HOUSE_COACH_USER_ID role is owner, not coach');
      warn.mockClear();
      await expect(houseJoinToBuy(houseIs('coach'), CLIENT, PAID)).resolves.toBe(COACH);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
