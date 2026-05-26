import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';

function makePrismaStub() {
  const rows: any[] = [];
  return {
    _rows: rows,
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
              // archived_at: null or is_active: true
              return Object.entries(v as any).every(([sk, sv]) => r[k] === sv);
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
  };
}

describe('PackagesService', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let svc: PackagesService;

  beforeEach(() => {
    prisma = makePrismaStub();
    svc = new PackagesService(prisma as any);
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
      // Pretend a checkout cached the Stripe ids
      prisma._rows[0].stripe_price_id = 'price_old';
      prisma._rows[0].stripe_product_id = 'prod_keep';
      const updated = await svc.update('coach-1', pkg.id, {
        amount_cents: 2000,
      });
      expect(updated.stripe_price_id).toBeNull();
      // Product is kept (name unchanged).
      expect(updated.stripe_product_id).toBe('prod_keep');
    });

    it('keeps stripe_price_id when only name changes', async () => {
      const pkg = await svc.create('coach-1', { name: 'p', amount_cents: 1000 });
      prisma._rows[0].stripe_price_id = 'price_keep';
      const updated = await svc.update('coach-1', pkg.id, { name: 'p2' });
      expect(updated.stripe_price_id).toBe('price_keep');
    });
  });

  describe('requireOwnedPackage', () => {
    it(
      'requireOwnedPackage collapses unknown-id and foreign-coach-id into 404 PACKAGE_NOT_FOUND (DL-5 enumeration fix)',
      async () => {
        const pkg = await svc.create('coach-1', { name: 'pkg', amount_cents: 5000 });

        // Case 1: completely unknown ID → must 404 with PACKAGE_NOT_FOUND
        const errUnknown = await (svc as any)
          .requireOwnedPackage('coach-1', 'nonexistent-id')
          .catch((e: unknown) => e);
        expect(errUnknown).toBeInstanceOf(NotFoundException);
        expect((errUnknown as NotFoundException).getResponse()).toMatchObject({
          error: 'PACKAGE_NOT_FOUND',
        });

        // Case 2: valid ID belonging to a different coach → must also 404 PACKAGE_NOT_FOUND (not 403)
        const errForeign = await (svc as any)
          .requireOwnedPackage('coach-2', pkg.id)
          .catch((e: unknown) => e);
        expect(errForeign).toBeInstanceOf(NotFoundException);
        expect((errForeign as NotFoundException).getResponse()).toMatchObject({
          error: 'PACKAGE_NOT_FOUND',
        });
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
    it('filters out archived and inactive packages', async () => {
      await svc.create('coach-1', { name: 'a', amount_cents: 1000 });
      const b = await svc.create('coach-1', { name: 'b', amount_cents: 1000 });
      const c = await svc.create('coach-1', { name: 'c', amount_cents: 1000 });
      await svc.update('coach-1', b.id, { is_active: false });
      await svc.archive('coach-1', c.id);
      const out = await svc.listPublicForCoach('coach-1');
      const names = out.map((r) => r.name).sort();
      expect(names).toEqual(['a']);
    });
  });
});
