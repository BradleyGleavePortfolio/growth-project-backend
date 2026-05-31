import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';

function makePrismaStub() {
  const rows: any[] = [];
  const purchases: any[] = [];
  const contents: any[] = [];
  const stub: any = {
    _rows: rows,
    _purchases: purchases,
    _contents: contents,
    // B1 — the pricing-lock path runs inside prisma.$transaction(cb). The
    // stub executes the callback synchronously with itself as the `tx`
    // client so tx.$queryRaw / tx.clientPurchase / tx.coachPackage all
    // resolve against the same in-memory rows.
    $transaction: jest.fn(async (cb: any) => cb(stub)),
    // FOR UPDATE row lock — no-op in the stub; just returns the locked id.
    $queryRaw: jest.fn(async () => []),
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        ) ?? null,
      ),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        const out = rows.filter((r) =>
          Object.entries(where).every(([k, v]) => {
            if (v === null) return r[k] === null || r[k] === undefined;
            if (typeof v === 'object' && v !== null) {
              // Filter sub-objects (archived_at: null, published_at: { not: null }, etc.)
              return Object.entries(v as any).every(([sk, sv]) => {
                if (sk === 'not') return r[k] !== sv && r[k] != null;
                return r[k] === sv;
              });
            }
            return r[k] === v;
          }),
        );
        return out;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pkg-${rows.length + 1}`,
          interval: null,
          interval_count: 1,
          duration_periods: null,
          stripe_price_id: null,
          stripe_product_id: null,
          is_active: true,
          archived_at: null,
          published_at: null,
          recurring_amount_cents: null,
          recurring_interval: null,
          recurring_interval_count: null,
          recurring_stripe_price_id: null,
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
      findMany: jest.fn(async ({ where, orderBy, skip, take }: any) => {
        const all = purchases.filter((p) => p.package_id === where.package_id);
        all.sort((a, b) =>
          (b.created_at as Date).getTime() - (a.created_at as Date).getTime(),
        );
        return all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
      }),
      // B1 — the active-recurring-buyer count used by the pricing lock.
      // Mirrors the Prisma `where` the service passes: package_id +
      // entitlement_active + stripe_subscription_id { not: null } +
      // status { in: [...] }.
      count: jest.fn(async ({ where }: any) =>
        purchases.filter((p) => {
          if (where.package_id !== undefined && p.package_id !== where.package_id)
            return false;
          if (
            where.entitlement_active !== undefined &&
            p.entitlement_active !== where.entitlement_active
          )
            return false;
          if (
            where.stripe_subscription_id &&
            typeof where.stripe_subscription_id === 'object' &&
            'not' in where.stripe_subscription_id
          ) {
            // { not: null } → require a non-null subscription id.
            if (p.stripe_subscription_id == null) return false;
          }
          if (
            where.status &&
            typeof where.status === 'object' &&
            Array.isArray(where.status.in)
          ) {
            if (!where.status.in.includes(p.status)) return false;
          }
          return true;
        }).length,
      ),
    },
    coachPackageContent: {
      count: jest.fn(async ({ where }: any) =>
        contents.filter(
          (c) =>
            c.package_id === where.package_id &&
            (where.removed_at === null ? c.removed_at == null : true),
        ).length,
      ),
    },
  };
  return stub;
}

function makeSubCoachStub(headMap: Record<string, string | null> = {}) {
  return {
    getHeadCoachIdForSubCoach: jest.fn(
      async (userId: string) => headMap[userId] ?? null,
    ),
  };
}

describe('PackagesService', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let subCoach: ReturnType<typeof makeSubCoachStub>;
  let svc: PackagesService;

  beforeEach(() => {
    prisma = makePrismaStub();
    subCoach = makeSubCoachStub();
    svc = new PackagesService(prisma as any, subCoach as any);
  });

  describe('create', () => {
    it('creates a one_time package with defaults', async () => {
      const pkg = await svc.create('coach-1', {
        name: 'Transform 12',
        amount_cents: 99900,
      });
      expect(pkg.coach_id).toBe('coach-1');
      expect(pkg.billing_type).toBe('one_time');
      expect(pkg.currency).toBe('usd');
      expect(pkg.interval).toBeNull();
      expect(pkg.is_active).toBe(true);
      // PR-6: new packages default to DRAFT (published_at = null).
      expect(pkg.published_at).toBeNull();
    });

    it('creates a recurring package with month interval', async () => {
      const pkg = await svc.create('coach-1', {
        name: 'Monthly Coaching',
        amount_cents: 19900,
        billing_type: 'recurring',
        interval: 'month',
      });
      expect(pkg.billing_type).toBe('recurring');
      expect(pkg.interval).toBe('month');
    });

    it('rejects amount_cents below Stripe minimum', async () => {
      await expect(
        svc.create('c1', { name: 'tiny', amount_cents: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects recurring without interval', async () => {
      await expect(
        svc.create('c1', {
          name: 'x',
          amount_cents: 5000,
          billing_type: 'recurring',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects one_time with interval', async () => {
      await expect(
        svc.create('c1', {
          name: 'x',
          amount_cents: 5000,
          billing_type: 'one_time',
          interval: 'month',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing name', async () => {
      await expect(
        svc.create('c1', { name: '   ', amount_cents: 5000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects bad currency', async () => {
      await expect(
        svc.create('c1', {
          name: 'x',
          amount_cents: 5000,
          currency: 'xxxx',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-integer duration_periods', async () => {
      await expect(
        svc.create('c1', {
          name: 'x',
          amount_cents: 5000,
          duration_periods: 1.5,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('rejects update by non-owner with 404 PACKAGE_NOT_FOUND (DL-5 enumeration fix)', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      const err = await svc
        .update('coach-2', pkg.id, { name: 'p2' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        error: 'PACKAGE_NOT_FOUND',
      });
    });

    it('returns 404 for unknown id', async () => {
      await expect(
        svc.update('coach-1', 'nope', { name: 'p2' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('clears stripe_price_id when amount changes', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      prisma._rows[0].stripe_price_id = 'price_old';
      prisma._rows[0].stripe_product_id = 'prod_keep';
      const updated = await svc.update('coach-1', pkg.id, {
        amount_cents: 2000,
      });
      expect(updated.stripe_price_id).toBeNull();
      expect(updated.stripe_product_id).toBe('prod_keep');
    });

    it('keeps stripe_price_id when only name changes', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      prisma._rows[0].stripe_price_id = 'price_keep';
      const updated = await svc.update('coach-1', pkg.id, { name: 'p2' });
      expect(updated.stripe_price_id).toBe('price_keep');
    });

    it('PR-6 round-trips duration_periods on create+update', async () => {
      const pkg = await svc.create('coach-1', {
        name: 'p',
        amount_cents: 1000,
        duration_periods: 12,
      });
      expect(pkg.duration_periods).toBe(12);
      const cleared = await svc.update('coach-1', pkg.id, {
        duration_periods: null,
      });
      expect(cleared.duration_periods).toBeNull();
    });
  });

  describe('requireOwnedPackage', () => {
    it(
      'collapses unknown-id and foreign-coach-id into 404 PACKAGE_NOT_FOUND (DL-5)',
      async () => {
        const pkg = await svc.create('coach-1', { name: 'pkg', amount_cents: 5000 });

        const errUnknown = await (svc as any)
          .requireOwnedPackage('coach-1', 'nonexistent-id')
          .catch((e: unknown) => e);
        expect(errUnknown).toBeInstanceOf(NotFoundException);

        const errForeign = await (svc as any)
          .requireOwnedPackage('coach-2', pkg.id)
          .catch((e: unknown) => e);
        expect(errForeign).toBeInstanceOf(NotFoundException);
      },
    );
  });

  describe('archive', () => {
    it('sets archived_at + is_active=false', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      const a = await svc.archive('coach-1', pkg.id);
      expect(a.archived_at).toBeTruthy();
      expect(a.is_active).toBe(false);
    });

    it('is idempotent', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      const a = await svc.archive('coach-1', pkg.id);
      const b = await svc.archive('coach-1', pkg.id);
      expect(a.archived_at).toEqual(b.archived_at);
    });
  });

  describe('listPublicForCoach', () => {
    it('filters out archived, inactive, AND draft packages', async () => {
      const a = await svc.create('coach-1', { name: 'a', amount_cents: 1000 });
      const b = await svc.create('coach-1', { name: 'b', amount_cents: 1000 });
      const c = await svc.create('coach-1', { name: 'c', amount_cents: 1000 });
      const d = await svc.create('coach-1', { name: 'd', amount_cents: 1000 });
      // Publish a + b + c so they're not DRAFT.
      await svc.publish('coach-1', a.id);
      await svc.publish('coach-1', b.id);
      await svc.publish('coach-1', c.id);
      // b → inactive; c → archived; d → still DRAFT (never published).
      await svc.update('coach-1', b.id, { is_active: false });
      await svc.archive('coach-1', c.id);
      const out = await svc.listPublicForCoach('coach-1');
      const names = out.map((r) => r.name).sort();
      expect(names).toEqual(['a']);
    });
  });

  describe('PR-6: publish / unpublish', () => {
    it('publish sets published_at and is idempotent', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      expect(pkg.published_at).toBeNull();
      const first = await svc.publish('coach-1', pkg.id);
      expect(first.published_at).toBeTruthy();
      const second = await svc.publish('coach-1', pkg.id);
      // Idempotent — same timestamp, not a re-bump.
      expect(second.published_at).toEqual(first.published_at);
    });

    it('unpublish clears published_at and is idempotent', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      await svc.publish('coach-1', pkg.id);
      const first = await svc.unpublish('coach-1', pkg.id);
      expect(first.published_at).toBeNull();
      const second = await svc.unpublish('coach-1', pkg.id);
      expect(second.published_at).toBeNull();
    });

    it('publish rejects archived packages', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      await svc.archive('coach-1', pkg.id);
      await expect(svc.publish('coach-1', pkg.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('publish IDOR-guarded — foreign coach 404s', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      await expect(svc.publish('coach-2', pkg.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.unpublish('coach-2', pkg.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('PR-6: pricing combos', () => {
    it('accepts a one_time + recurring combo', async () => {
      const pkg = await svc.create('coach-1', {
        name: 'combo',
        amount_cents: 50000,
        billing_type: 'one_time',
        recurring_amount_cents: 9900,
        recurring_interval: 'month',
        recurring_interval_count: 1,
      });
      expect(pkg.recurring_amount_cents).toBe(9900);
      expect(pkg.recurring_interval).toBe('month');
    });

    it('accepts each recurring cadence (week, month, year)', async () => {
      for (const cadence of ['week', 'month', 'year'] as const) {
        const p = await svc.create('coach-1', {
          name: `r-${cadence}`,
          amount_cents: 1000,
          billing_type: 'recurring',
          interval: cadence,
        });
        expect(p.interval).toBe(cadence);
      }
    });

    it('rejects recurring primary + recurring companion (no two competing subs)', async () => {
      await expect(
        svc.create('coach-1', {
          name: 'bad',
          amount_cents: 1000,
          billing_type: 'recurring',
          interval: 'month',
          recurring_amount_cents: 5000,
          recurring_interval: 'month',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects half-set recurring companion (amount only)', async () => {
      await expect(
        svc.create('coach-1', {
          name: 'bad',
          amount_cents: 1000,
          billing_type: 'one_time',
          recurring_amount_cents: 5000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects recurring companion below Stripe minimum', async () => {
      await expect(
        svc.create('coach-1', {
          name: 'bad',
          amount_cents: 1000,
          billing_type: 'one_time',
          recurring_amount_cents: 10,
          recurring_interval: 'month',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects recurring companion with bad cadence', async () => {
      await expect(
        svc.create('coach-1', {
          name: 'bad',
          amount_cents: 1000,
          billing_type: 'one_time',
          recurring_amount_cents: 5000,
          // @ts-expect-error invalid cadence on purpose
          recurring_interval: 'fortnight',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update clears recurring_stripe_price_id when recurring fields change', async () => {
      const pkg = await svc.create('coach-1', {
        name: 'p',
        amount_cents: 1000,
        billing_type: 'one_time',
        recurring_amount_cents: 5000,
        recurring_interval: 'month',
      });
      prisma._rows[0].recurring_stripe_price_id = 'price_old';
      const updated = await svc.update('coach-1', pkg.id, {
        recurring_amount_cents: 7500,
      });
      expect(updated.recurring_stripe_price_id).toBeNull();
    });
  });

  describe('B1: pricing lock after active recurring subscriber', () => {
    // Seed a recurring package + a single buyer with a given lifecycle.
    async function seedWithSubscriber(
      purchase: Partial<{
        entitlement_active: boolean;
        stripe_subscription_id: string | null;
        status: string;
      }> = {},
    ) {
      const pkg = await svc.create('coach-1', {
        name: 'Monthly Coaching',
        amount_cents: 19900,
        billing_type: 'recurring',
        interval: 'month',
      });
      prisma._purchases.push({
        id: 'pu-1',
        package_id: pkg.id,
        client_user_id: 'cli-1',
        entitlement_active: purchase.entitlement_active ?? true,
        stripe_subscription_id:
          purchase.stripe_subscription_id === undefined
            ? 'sub_123'
            : purchase.stripe_subscription_id,
        status: purchase.status ?? 'active',
        created_at: new Date(2026, 0, 1),
      });
      return pkg;
    }

    it('ALLOWS name/description/status update with active recurring subscribers', async () => {
      const pkg = await seedWithSubscriber();
      const updated = await svc.update('coach-1', pkg.id, {
        name: 'Renamed',
        description: 'new copy',
        is_active: false,
      });
      expect(updated.name).toBe('Renamed');
      expect(updated.description).toBe('new copy');
      expect(updated.is_active).toBe(false);
      // Pure non-price edit must NOT open a transaction / lock.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('BLOCKS amount_cents change with active recurring subscriber', async () => {
      const pkg = await seedWithSubscriber();
      const err = await svc
        .update('coach-1', pkg.id, { amount_cents: 29900 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'PACKAGE_PRICING_LOCKED',
      });
      // Lock acquired before counting.
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('BLOCKS currency change with active recurring subscriber', async () => {
      const pkg = await seedWithSubscriber();
      await expect(
        svc.update('coach-1', pkg.id, { currency: 'eur' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('BLOCKS billing_type change with active recurring subscriber', async () => {
      // Seed a one_time package that nonetheless has a live recurring buyer
      // row (e.g. a legacy/combo purchase carrying a subscription id). The
      // coach tries to flip the primary to recurring — a valid shape that
      // must still be blocked by the lock.
      const pkg = await svc.create('coach-1', {
        name: 'OneTime',
        amount_cents: 19900,
        billing_type: 'one_time',
      });
      prisma._purchases.push({
        id: 'pu-bt',
        package_id: pkg.id,
        client_user_id: 'cli-1',
        entitlement_active: true,
        stripe_subscription_id: 'sub_bt',
        status: 'active',
        created_at: new Date(2026, 0, 1),
      });
      await expect(
        svc.update('coach-1', pkg.id, {
          billing_type: 'recurring',
          interval: 'month',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('BLOCKS interval change with active recurring subscriber', async () => {
      const pkg = await seedWithSubscriber();
      await expect(
        svc.update('coach-1', pkg.id, { interval: 'year' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('BLOCKS interval_count change with active recurring subscriber', async () => {
      const pkg = await seedWithSubscriber();
      await expect(
        svc.update('coach-1', pkg.id, { interval_count: 3 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('BLOCKS duration_periods change with active recurring subscriber', async () => {
      const pkg = await seedWithSubscriber();
      await expect(
        svc.update('coach-1', pkg.id, { duration_periods: 12 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('BLOCKS recurring companion change with active recurring subscriber (combo locks both legs)', async () => {
      // One-time primary + recurring companion combo with an active
      // recurring buyer. Editing EITHER the companion or the one-time
      // primary must lock.
      const pkg = await svc.create('coach-1', {
        name: 'combo',
        amount_cents: 50000,
        billing_type: 'one_time',
        recurring_amount_cents: 9900,
        recurring_interval: 'month',
        recurring_interval_count: 1,
      });
      prisma._purchases.push({
        id: 'pu-combo',
        package_id: pkg.id,
        client_user_id: 'cli-1',
        entitlement_active: true,
        stripe_subscription_id: 'sub_combo',
        status: 'active',
        created_at: new Date(2026, 0, 1),
      });
      // Companion leg locked.
      await expect(
        svc.update('coach-1', pkg.id, { recurring_amount_cents: 12900 }),
      ).rejects.toBeInstanceOf(ConflictException);
      // One-time primary leg locked too.
      await expect(
        svc.update('coach-1', pkg.id, { amount_cents: 60000 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('locks on a trialing subscriber', async () => {
      const pkg = await seedWithSubscriber({ status: 'trialing' });
      await expect(
        svc.update('coach-1', pkg.id, { amount_cents: 29900 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('locks on a past_due subscriber (still in dunning, entitlement live)', async () => {
      const pkg = await seedWithSubscriber({ status: 'past_due' });
      await expect(
        svc.update('coach-1', pkg.id, { amount_cents: 29900 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('ALLOWS pricing edit when the subscriber is canceled', async () => {
      const pkg = await seedWithSubscriber({
        status: 'canceled',
        entitlement_active: false,
      });
      const updated = await svc.update('coach-1', pkg.id, {
        amount_cents: 29900,
      });
      expect(updated.amount_cents).toBe(29900);
    });

    it('ALLOWS pricing edit when entitlement is inactive (even if status active)', async () => {
      const pkg = await seedWithSubscriber({ entitlement_active: false });
      const updated = await svc.update('coach-1', pkg.id, {
        amount_cents: 29900,
      });
      expect(updated.amount_cents).toBe(29900);
    });

    it('ALLOWS pricing edit when buyer has no Stripe subscription (one-time buyer)', async () => {
      const pkg = await seedWithSubscriber({ stripe_subscription_id: null });
      const updated = await svc.update('coach-1', pkg.id, {
        amount_cents: 29900,
      });
      expect(updated.amount_cents).toBe(29900);
    });

    it('ALLOWS pricing edit when there are no buyers at all', async () => {
      const pkg = await svc.create('coach-1', {
        name: 'Monthly',
        amount_cents: 19900,
        billing_type: 'recurring',
        interval: 'month',
      });
      const updated = await svc.update('coach-1', pkg.id, {
        amount_cents: 29900,
      });
      expect(updated.amount_cents).toBe(29900);
    });

    it('IDOR guard runs BEFORE the subscriber count (foreign coach 404s, never counts)', async () => {
      const pkg = await seedWithSubscriber();
      const countSpy = prisma.clientPurchase.count as jest.Mock;
      const err = await svc
        .update('coach-2', pkg.id, { amount_cents: 29900 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        error: 'PACKAGE_NOT_FOUND',
      });
      // Never reached the lock/count path for a non-owned package.
      expect(countSpy).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('uses exactly ONE count query on the lock path (no N+1)', async () => {
      const pkg = await seedWithSubscriber();
      const countSpy = prisma.clientPurchase.count as jest.Mock;
      await svc
        .update('coach-1', pkg.id, { amount_cents: 29900 })
        .catch(() => undefined);
      expect(countSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('B1: combo min/max error copy', () => {
    it('primary minimum copy is GENERIC when there is no recurring companion', async () => {
      const err = await svc
        .create('coach-1', { name: 'p', amount_cents: 10 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        error: 'PACKAGE_INVALID',
        message: 'amount_cents must be an integer ≥ 50 (Stripe minimum)',
      });
    });

    it('primary minimum copy DISAMBIGUATES the one-time leg when a recurring companion is present', async () => {
      const err = await svc
        .create('coach-1', {
          name: 'combo',
          amount_cents: 10,
          billing_type: 'one_time',
          recurring_amount_cents: 9900,
          recurring_interval: 'month',
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        error: 'PACKAGE_INVALID',
        message:
          'one-time amount_cents must be an integer ≥ 50 (Stripe minimum)',
      });
    });

    it('recurring companion minimum copy names the recurring companion', async () => {
      const err = await svc
        .create('coach-1', {
          name: 'combo',
          amount_cents: 5000,
          billing_type: 'one_time',
          recurring_amount_cents: 10,
          recurring_interval: 'month',
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        error: 'PACKAGE_INVALID',
        message:
          'recurring_amount_cents must be an integer ≥ 50 (Stripe minimum for the recurring companion)',
      });
    });
  });

  describe('PR-6: getOwnedDetail', () => {
    it('returns row + content_count and IDOR-404s foreign coach', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      prisma._contents.push(
        { package_id: pkg.id, removed_at: null },
        { package_id: pkg.id, removed_at: null },
        { package_id: pkg.id, removed_at: new Date() }, // removed → excluded
      );
      const detail = await svc.getOwnedDetail('coach-1', pkg.id);
      expect(detail.id).toBe(pkg.id);
      expect(detail.content_count).toBe(2);
      await expect(svc.getOwnedDetail('coach-2', pkg.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('PR-6: listSubscribers', () => {
    it('paginates and IDOR-404s foreign coach', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      // Seed 75 purchases.
      for (let i = 0; i < 75; i++) {
        prisma._purchases.push({
          id: `pu-${i}`,
          package_id: pkg.id,
          client_user_id: `cli-${i}`,
          created_at: new Date(2026, 0, 1, 0, i),
        });
      }
      const page1 = await svc.listSubscribers('coach-1', pkg.id, {
        limit: 50,
        offset: 0,
      });
      expect(page1.subscribers.length).toBe(50);
      expect(page1.next_offset).toBe(50);

      const page2 = await svc.listSubscribers('coach-1', pkg.id, {
        limit: 50,
        offset: 50,
      });
      expect(page2.subscribers.length).toBe(25);
      expect(page2.next_offset).toBeNull();

      await expect(
        svc.listSubscribers('coach-2', pkg.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('caps limit at 200', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      const page = await svc.listSubscribers('coach-1', pkg.id, {
        limit: 99999,
      });
      // Empty list — just confirming no crash / no negative skip.
      expect(page.subscribers.length).toBe(0);
    });
  });

  describe('PR-6: sub-coach effective id resolution', () => {
    it('head coach: returns caller id unchanged', async () => {
      const id = await svc.resolveEffectiveCoachId('head-1');
      expect(id).toBe('head-1');
    });

    it('sub-coach: promotes to head coach id', async () => {
      subCoach.getHeadCoachIdForSubCoach.mockImplementation(
        async (u: string) => (u === 'sub-1' ? 'head-1' : null),
      );
      const id = await svc.resolveEffectiveCoachId('sub-1');
      expect(id).toBe('head-1');
    });
  });
});
