import { ConflictException } from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';

// BUG-R3 — PackagesService.archive() must refuse to archive a CoachPackage
// while it still has active subscribers (rows with entitlement_active=true).
//
// Without the guard, archive() sets is_active=false / archived_at=now() and
// pulls the package off the storefront, but the underlying Stripe
// subscriptions keep billing the client for a package the app now treats as
// "not available" — breaking the client UI. Option A (the safer path) blocks
// the archive with a 409 PACKAGE_HAS_ACTIVE_SUBSCRIBERS and tells the coach
// to cancel the subscriptions first.
//
// These are service-level assertions: archive() throwing ConflictException is
// what the controller serialises to HTTP 409 (NestJS maps ConflictException →
// 409), and a successful return of the updated row is the HTTP 200 success
// path. The repo's existing packages.service.spec.ts uses the same in-memory
// Prisma stub style, so this spec stays consistent with that architecture.

// In-memory Prisma stub. Only the surface archive() / requireOwnedPackage()
// touch is modelled: coachPackage.{findFirst,create,update} and
// clientPurchase.count keyed on package_id + entitlement_active.
function makePrismaStub() {
  const rows: any[] = [];
  const purchases: any[] = [];
  const stub: any = {
    _rows: rows,
    _purchases: purchases,
    coachPackage: {
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pkg-${rows.length + 1}`,
          is_active: true,
          archived_at: null,
          published_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      }),
    },
    clientPurchase: {
      // Mirrors the exact Prisma `where` the BUG-R3 guard passes:
      //   { package_id, entitlement_active: true }
      count: jest.fn(async ({ where }: any) =>
        purchases.filter((p) => {
          if (
            where.package_id !== undefined &&
            p.package_id !== where.package_id
          )
            return false;
          if (
            where.entitlement_active !== undefined &&
            p.entitlement_active !== where.entitlement_active
          )
            return false;
          return true;
        }).length,
      ),
    },
  };
  return stub;
}

function makeSubCoachStub() {
  return {
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
  };
}

// Seed a package owned by `coachId` and N active (entitlement_active=true)
// purchases against it. `inactive` adds entitlement_active=false rows that
// must NOT count toward the guard.
function seedPackageWithSubscribers(
  prisma: ReturnType<typeof makePrismaStub>,
  coachId: string,
  opts: { active: number; inactive?: number },
): any {
  const pkg = {
    id: `pkg-${prisma._rows.length + 1}`,
    coach_id: coachId,
    name: 'Monthly Coaching',
    amount_cents: 19900,
    is_active: true,
    archived_at: null,
    published_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  };
  prisma._rows.push(pkg);
  for (let i = 0; i < opts.active; i++) {
    prisma._purchases.push({
      id: `cp-active-${pkg.id}-${i}`,
      package_id: pkg.id,
      entitlement_active: true,
      stripe_subscription_id: `sub_${i}`,
      status: 'active',
      created_at: new Date(),
    });
  }
  for (let i = 0; i < (opts.inactive ?? 0); i++) {
    prisma._purchases.push({
      id: `cp-inactive-${pkg.id}-${i}`,
      package_id: pkg.id,
      entitlement_active: false,
      stripe_subscription_id: null,
      status: 'canceled',
      created_at: new Date(),
    });
  }
  return pkg;
}

describe('BUG-R3 — PackagesService.archive() active-subscriber guard', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let subCoach: ReturnType<typeof makeSubCoachStub>;
  let svc: PackagesService;

  beforeEach(() => {
    prisma = makePrismaStub();
    subCoach = makeSubCoachStub();
    svc = new PackagesService(prisma as any, subCoach as any);
  });

  // Case 1 — coach with 0 active subscribers can archive → HTTP 200.
  it('archives a package with 0 active subscribers (success path / 200)', async () => {
    const pkg = seedPackageWithSubscribers(prisma, 'coach-1', { active: 0 });

    const archived = await svc.archive('coach-1', pkg.id);

    expect(archived.archived_at).toBeTruthy();
    expect(archived.is_active).toBe(false);
    // Success path response shape is unchanged: the updated CoachPackage row.
    expect(archived.id).toBe(pkg.id);
  });

  // Inactive entitlements (canceled/expired) must not block the archive.
  it('archives when all subscribers are entitlement_active=false', async () => {
    const pkg = seedPackageWithSubscribers(prisma, 'coach-1', {
      active: 0,
      inactive: 3,
    });

    const archived = await svc.archive('coach-1', pkg.id);

    expect(archived.archived_at).toBeTruthy();
    expect(archived.is_active).toBe(false);
  });

  // Case 2 — coach with 1 active subscriber → 409 PACKAGE_HAS_ACTIVE_SUBSCRIBERS
  // with active_subscriber_count: 1.
  it('refuses archive with 1 active subscriber → 409 with count 1', async () => {
    const pkg = seedPackageWithSubscribers(prisma, 'coach-1', { active: 1 });

    expect.assertions(5);
    try {
      await svc.archive('coach-1', pkg.id);
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      const body = (err as ConflictException).getResponse() as any;
      expect(body.error).toBe('PACKAGE_HAS_ACTIVE_SUBSCRIBERS');
      expect(body.active_subscriber_count).toBe(1);
      expect(body.message).toContain('1 active subscriber');
      // Package must NOT have been archived.
      expect(prisma._rows.find((r: any) => r.id === pkg.id).archived_at).toBeNull();
    }
  });

  // Case 3 — coach with N active subscribers → 409 with the correct count.
  it('refuses archive with N active subscribers → 409 with correct count', async () => {
    const N = 4;
    const pkg = seedPackageWithSubscribers(prisma, 'coach-1', {
      active: N,
      // a couple of inactive rows that must be excluded from the count.
      inactive: 2,
    });

    expect.assertions(4);
    try {
      await svc.archive('coach-1', pkg.id);
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      const body = (err as ConflictException).getResponse() as any;
      expect(body.error).toBe('PACKAGE_HAS_ACTIVE_SUBSCRIBERS');
      // Only entitlement_active=true rows count — inactive rows excluded.
      expect(body.active_subscriber_count).toBe(N);
      expect(body.message).toContain(`${N} active subscriber`);
    }
  });

  // Case 4 — an already-archived package is idempotent: it returns the
  // existing row WITHOUT a count check, even if it still has active
  // subscribers (the idempotency guard runs before the subscriber count).
  it('is idempotent on an already-archived package (no count check)', async () => {
    const pkg = seedPackageWithSubscribers(prisma, 'coach-1', { active: 2 });
    // Pre-archive the row directly so archive() hits the idempotency guard.
    const archivedAt = new Date('2026-01-01T00:00:00.000Z');
    prisma._rows.find((r: any) => r.id === pkg.id).archived_at = archivedAt;

    const result = await svc.archive('coach-1', pkg.id);

    // Returns the existing row, same archived_at, no re-bump.
    expect(result.archived_at).toEqual(archivedAt);
    // The subscriber count must NOT have been consulted on the idempotent
    // path (the early return precedes it).
    expect(prisma.clientPurchase.count).not.toHaveBeenCalled();
  });
});
