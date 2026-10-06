// AUDIT-02-125: the setup wizard binds a free first package to the coach's
// invite link (grant_mode 'free'). When the coach later prices that package,
// the link must stop giving it away for $0. Fails on main: the binding stays.
import { PackagesService } from '../src/packages/packages.service';
import { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function makeStore() {
  const packages: Row[] = [];
  const profiles: Row[] = [];
  const codes: Row[] = [];
  const updateMany = (rows: Row[]) =>
    jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
  const client = {
    $queryRaw: jest.fn(async () => []),
    coachPackage: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const r = packages.find((p) => matches(p, where));
        return r ? { ...r } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const r = packages.find((p) => p.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return { ...r };
      }),
    },
    clientPurchase: { count: jest.fn(async () => 0) },
    coachProfile: { updateMany: updateMany(profiles) },
    inviteCode: { updateMany: updateMany(codes) },
  };
  const tx = {
    ...client,
    $transaction: jest.fn(async (cb: (t: typeof client) => Promise<unknown>) => cb(client)),
  };
  const prisma: PrismaService = Object.assign(Object.create(PrismaService.prototype), tx);
  const subCoach: SubCoachScopeService = Object.create(SubCoachScopeService.prototype);
  return { packages, profiles, codes, client, svc: new PackagesService(prisma, subCoach) };
}

function pkg(over: Row): Row {
  return {
    id: 'pkg-free',
    coach_id: 'coach-1',
    name: 'Starter coaching',
    description: null,
    amount_cents: 0,
    currency: 'usd',
    billing_type: 'one_time',
    interval: null,
    interval_count: 1,
    duration_periods: null,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    trial_days: 0,
    stripe_price_id: null,
    recurring_stripe_price_id: null,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-10-01T00:00:00Z'),
    first_published_at: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

describe('AUDIT-02-125 free invite binding is released when the package is priced', () => {
  it('a coach who prices the free setup package at $49 a month stops giving it away on the invite link', async () => {
    const s = makeStore();
    s.packages.push(pkg({}));
    s.profiles.push(
      { user_id: 'coach-1', invite_code_package_id: 'pkg-free', invite_code_grant_mode: 'free' },
      { user_id: 'coach-2', invite_code_package_id: 'pkg-other', invite_code_grant_mode: 'free' },
    );
    s.codes.push(
      { id: 'c1', coach_id: 'coach-1', package_id: 'pkg-free', grant_mode: 'free' },
      { id: 'c2', coach_id: 'coach-1', package_id: 'pkg-free', grant_mode: 'prepaid' },
    );

    const out = await s.svc.update('coach-1', 'pkg-free', {
      amount_cents: 4900,
      billing_type: 'recurring',
      interval: 'month',
      interval_count: 1,
    });

    expect(out.amount_cents).toBe(4900);
    expect(s.profiles[0]).toMatchObject({ invite_code_package_id: null, invite_code_grant_mode: 'none' });
    expect(s.profiles[1]).toMatchObject({ invite_code_package_id: 'pkg-other', invite_code_grant_mode: 'free' });
    expect(s.codes[0]).toMatchObject({ package_id: null, grant_mode: 'none' });
    // Paid outside the app: the coach's prepaid code keeps working.
    expect(s.codes[1]).toMatchObject({ package_id: 'pkg-free', grant_mode: 'prepaid' });
  });

  it('a one-time price on the free package also releases the free link binding', async () => {
    const s = makeStore();
    s.packages.push(pkg({}));
    s.profiles.push({ user_id: 'coach-1', invite_code_package_id: 'pkg-free', invite_code_grant_mode: 'free' });

    await s.svc.update('coach-1', 'pkg-free', { amount_cents: 2500 });

    expect(s.profiles[0]).toMatchObject({ invite_code_package_id: null, invite_code_grant_mode: 'none' });
  });

  it('a paid package price change leaves every binding as the coach set it', async () => {
    const s = makeStore();
    s.packages.push(pkg({ id: 'pkg-paid', amount_cents: 4900, billing_type: 'recurring', interval: 'month' }));
    s.codes.push({ id: 'c1', coach_id: 'coach-1', package_id: 'pkg-paid', grant_mode: 'free' });

    await s.svc.update('coach-1', 'pkg-paid', { amount_cents: 5900 });

    expect(s.client.coachProfile.updateMany).not.toHaveBeenCalled();
    expect(s.client.inviteCode.updateMany).not.toHaveBeenCalled();
    expect(s.codes[0]).toMatchObject({ package_id: 'pkg-paid', grant_mode: 'free' });
  });

  it('a name edit on the free package keeps the free link binding', async () => {
    const s = makeStore();
    s.packages.push(pkg({}));
    s.profiles.push({ user_id: 'coach-1', invite_code_package_id: 'pkg-free', invite_code_grant_mode: 'free' });

    await s.svc.update('coach-1', 'pkg-free', { name: 'Welcome coaching' });

    expect(s.profiles[0]).toMatchObject({ invite_code_package_id: 'pkg-free', invite_code_grant_mode: 'free' });
  });
});
