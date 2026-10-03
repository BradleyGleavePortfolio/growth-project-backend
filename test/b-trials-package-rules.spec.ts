// B-TRIALS (OR-113-2) — package trial rules: validation, DTO shape, update
// semantics and the client read model. Every case here failed before the
// change (no trial_days anywhere: the DTO rejected the field as unknown, the
// service ignored it, and the client reads had no trial_offer).
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import { CreatePackageDto, UpdatePackageDto } from '../src/packages/packages.dto';
import { PackagesService } from '../src/packages/packages.service';
import {
  assertValidTrial,
  stripeTrialParams,
  TRIAL_DAY_PRESETS,
  TRIAL_DAYS_MAX,
  TrialErrorCode,
} from '../src/packages/trials/trial-rules';
import { ClientPackagesController } from '../src/packages/packages.controller';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

type PkgRow = Record<string, unknown> & { id: string };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof BadRequestException) {
      return (err.getResponse() as { code?: string }).code;
    }
    throw err;
  }
  return undefined;
}

async function asyncCodeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    const res = (err as { getResponse?: () => unknown }).getResponse?.();
    return (res as { code?: string } | undefined)?.code;
  }
  return undefined;
}

function makePrisma() {
  const rows: PkgRow[] = [];
  const prisma = {
    rows,
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    $queryRaw: jest.fn(async () => []),
    coachPackage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: PkgRow = {
          id: `pkg-${rows.length + 1}`,
          interval_count: 1,
          duration_periods: null,
          stripe_price_id: null,
          recurring_amount_cents: null,
          recurring_interval: null,
          recurring_interval_count: null,
          recurring_stripe_price_id: null,
          published_at: null,
          first_published_at: null,
          archived_at: null,
          trial_days: 0,
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    clientPurchase: { count: jest.fn(async () => 0) },
  };
  return prisma;
}

function makeService() {
  const prisma = makePrisma();
  const sub = { getHeadCoachIdForSubCoach: jest.fn(async () => null) };
  // The service only touches the members the stub provides.
  const service = new PackagesService(
    stub<ConstructorParameters<typeof PackagesService>[0]>(prisma),
    stub<ConstructorParameters<typeof PackagesService>[1]>(sub),
  );
  return { prisma, service };
}

const monthly = {
  name: 'GP Monthly',
  amount_cents: 4900,
  billing_type: 'recurring' as const,
  interval: 'month' as const,
};

describe('B-TRIALS — assertValidTrial', () => {
  it('accepts 0 (no trial) on any package, and 1..30 on a paid recurring package', () => {
    expect(
      codeOf(() => assertValidTrial({ trial_days: 0, amount_cents: 0, billing_type: 'one_time' })),
    ).toBeUndefined();
    for (const d of [1, ...TRIAL_DAY_PRESETS, TRIAL_DAYS_MAX]) {
      expect(
        codeOf(() =>
          assertValidTrial({ trial_days: d, amount_cents: 4900, billing_type: 'recurring' }),
        ),
      ).toBeUndefined();
    }
  });

  it('refuses out-of-range and fractional lengths with PACKAGE_TRIAL_DAYS_OUT_OF_RANGE', () => {
    for (const d of [-1, 31, 90, 2.5, Number.NaN]) {
      expect(
        codeOf(() =>
          assertValidTrial({ trial_days: d, amount_cents: 4900, billing_type: 'recurring' }),
        ),
      ).toBe(TrialErrorCode.OUT_OF_RANGE);
    }
  });

  it('refuses a trial on one-time and one-time + recurring combo packages', () => {
    expect(
      codeOf(() =>
        assertValidTrial({ trial_days: 7, amount_cents: 4900, billing_type: 'one_time' }),
      ),
    ).toBe(TrialErrorCode.REQUIRES_RECURRING);
    expect(
      codeOf(() =>
        assertValidTrial({
          trial_days: 7,
          amount_cents: 9900,
          billing_type: 'one_time',
          recurring_amount_cents: 4900,
          recurring_interval: 'month',
        }),
      ),
    ).toBe(TrialErrorCode.REQUIRES_RECURRING);
  });

  it('refuses a trial on a free package', () => {
    expect(
      codeOf(() => assertValidTrial({ trial_days: 7, amount_cents: 0, billing_type: 'one_time' })),
    ).toBe(TrialErrorCode.NOT_ON_FREE);
  });

  it('every refusal message is Quiet Luxury copy (no exclamation marks, no first person)', () => {
    const shapes = [
      { trial_days: 31, amount_cents: 4900, billing_type: 'recurring' },
      { trial_days: 7, amount_cents: 4900, billing_type: 'one_time' },
      { trial_days: 7, amount_cents: 0, billing_type: 'one_time' },
      {
        trial_days: 7,
        amount_cents: 9900,
        billing_type: 'one_time',
        recurring_amount_cents: 4900,
        recurring_interval: 'month',
      },
    ];
    for (const shape of shapes) {
      try {
        assertValidTrial(shape);
        throw new Error('expected a refusal');
      } catch (err) {
        const msg = ((err as BadRequestException).getResponse() as { message: string }).message;
        expect(msg).not.toMatch(/!/);
        expect(msg).not.toMatch(/\b(we|us|our)\b/i);
        expect(msg.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('B-TRIALS — stripeTrialParams (contract for the subscription creator)', () => {
  it('sends trial_period_days and cancels at trial end when no card was saved', () => {
    expect(stripeTrialParams(7)).toEqual({
      trial_period_days: '7',
      'trial_settings[end_behavior][missing_payment_method]': 'cancel',
      'payment_settings[save_default_payment_method]': 'on_subscription',
    });
    expect(stripeTrialParams(0)).toEqual({});
  });
});

describe('B-TRIALS — package DTOs accept trial_days', () => {
  const opts = { whitelist: true, forbidNonWhitelisted: true };
  it('a whole number of days validates on create and update; text does not', async () => {
    const body = {
      name: 'GP Monthly',
      amount_cents: 4900,
      billing_type: 'recurring',
      billing_interval: 'month',
    };
    const ok = plainToInstance(CreatePackageDto, { ...body, trial_days: 7 });
    expect(await validate(ok, opts)).toHaveLength(0);
    const bad = plainToInstance(CreatePackageDto, { ...body, trial_days: 'seven' });
    const errs = await validate(bad, opts);
    expect(errs.map((e) => e.property)).toContain('trial_days');
    const patch = plainToInstance(UpdatePackageDto, { trial_days: 14 });
    expect(await validate(patch, opts)).toHaveLength(0);
  });
});

describe('B-TRIALS — PackagesService', () => {
  it('create stores trial_days on a recurring package', async () => {
    const { service, prisma } = makeService();
    const row = await service.create('coach-1', { ...monthly, trial_days: 7 });
    expect(row.trial_days).toBe(7);
    expect(prisma.coachPackage.create.mock.calls[0][0].data.trial_days).toBe(7);
  });

  it('create defaults to no trial', async () => {
    const { service } = makeService();
    const row = await service.create('coach-1', monthly);
    expect(row.trial_days).toBe(0);
  });

  it('create refuses a trial on a one-time package with a coded 400', async () => {
    const { service } = makeService();
    expect(
      await asyncCodeOf(
        service.create('coach-1', {
          name: 'Program',
          amount_cents: 9900,
          billing_type: 'one_time',
          trial_days: 7,
        }),
      ),
    ).toBe(TrialErrorCode.REQUIRES_RECURRING);
  });

  it('update sets a trial without tripping the pricing lock or clearing the Stripe price', async () => {
    const { service, prisma } = makeService();
    const created = await service.create('coach-1', monthly);
    prisma.rows[0].stripe_price_id = 'price_123';
    const row = await service.update('coach-1', created.id, { trial_days: 14 });
    expect(row.trial_days).toBe(14);
    expect(row.stripe_price_id).toBe('price_123');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.clientPurchase.count).not.toHaveBeenCalled();
  });

  it('update refuses 31 days', async () => {
    const { service } = makeService();
    const created = await service.create('coach-1', monthly);
    expect(await asyncCodeOf(service.update('coach-1', created.id, { trial_days: 31 }))).toBe(
      TrialErrorCode.OUT_OF_RANGE,
    );
  });

  it('switching a trial package to one-time drops the trial in the same PATCH', async () => {
    const { service } = makeService();
    const created = await service.create('coach-1', { ...monthly, trial_days: 7 });
    const row = await service.update('coach-1', created.id, { billing_type: 'one_time' });
    expect(row.billing_type).toBe('one_time');
    expect(row.trial_days).toBe(0);
  });

  it('switching to one-time while explicitly keeping a trial is refused', async () => {
    const { service } = makeService();
    const created = await service.create('coach-1', { ...monthly, trial_days: 7 });
    expect(
      await asyncCodeOf(
        service.update('coach-1', created.id, { billing_type: 'one_time', trial_days: 7 }),
      ),
    ).toBe(TrialErrorCode.REQUIRES_RECURRING);
  });

  it('null clears the trial', async () => {
    const { service } = makeService();
    const created = await service.create('coach-1', { ...monthly, trial_days: 7 });
    const row = await service.update('coach-1', created.id, { trial_days: null });
    expect(row.trial_days).toBe(0);
  });

  it('publish re-checks the trial rule on the stored row', async () => {
    const { service, prisma } = makeService();
    const created = await service.create('coach-1', monthly);
    prisma.rows[0].trial_days = 45; // a row that slipped past (defence in depth)
    expect(await asyncCodeOf(service.publish('coach-1', created.id))).toBe(
      TrialErrorCode.OUT_OF_RANGE,
    );
  });
});

describe('B-TRIALS — client package reads carry trial_offer for this client', () => {
  function build(started: Array<{ client: string; coach: string }>) {
    const table = makeTrialUsageTable();
    for (const s of started) {
      table.rows.push({
        id: `u-${s.client}`,
        client_user_id: s.client,
        coach_user_id: s.coach,
        package_id: 'pkg-old',
        purchase_id: `pur-${s.client}`,
        trial_days: 7,
        status: 'started',
        reserved_at: new Date(),
      });
    }
    const prisma = { packageTrialUsage: table };
    const trials = new TrialUsageService(
      stub<ConstructorParameters<typeof TrialUsageService>[0]>(prisma),
    );
    const pkg = {
      id: 'pkg-1',
      coach_id: 'coach-1',
      trial_days: 7,
      is_active: true,
      archived_at: null,
      published_at: new Date(),
    };
    const packages = {
      listPublicForCoach: jest.fn(async () => [pkg]),
      getById: jest.fn(async () => pkg),
    };
    const controller = new ClientPackagesController(
      stub<ConstructorParameters<typeof ClientPackagesController>[0]>(packages),
      {} as ConstructorParameters<typeof ClientPackagesController>[1],
      trials,
    );
    return controller;
  }
  const req = (id: string) =>
    stub<Parameters<ClientPackagesController['list']>[0]>({ user: { id, coach_id: 'coach-1' } });

  it('a new client sees the trial as available', async () => {
    const res = await build([]).list(req('client-1'));
    expect(res.packages[0].trial_offer).toEqual({
      trial_days: 7,
      available: true,
      reason: 'offered',
    });
  });

  it('a client who already had a trial with this coach sees it as used (list and detail)', async () => {
    const controller = build([{ client: 'client-1', coach: 'coach-1' }]);
    const list = await controller.list(req('client-1'));
    expect(list.packages[0].trial_offer).toEqual({
      trial_days: 7,
      available: false,
      reason: 'already_used',
    });
    const detail = await controller.detail(req('client-1'), 'pkg-1');
    expect(detail.trial_offer?.available).toBe(false);
  });
});

describe('B-TRIALS — migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../prisma/migrations/20270228000000_package_free_trials/migration.sql'),
    'utf8',
  );
  it('adds trial_days with default 0 and the database CHECK mirroring the service rules', () => {
    expect(sql).toMatch(
      /ALTER TABLE "CoachPackage" ADD COLUMN "trial_days" INTEGER NOT NULL DEFAULT 0;/,
    );
    expect(sql).toMatch(/"trial_days" BETWEEN 0 AND 30/);
    expect(sql).toMatch(/"billing_type" = 'recurring'/);
  });
  it('enforces one trial per client per coach with a unique index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "PackageTrialUsage_client_user_id_coach_user_id_key" ON "PackageTrialUsage"\("client_user_id", "coach_user_id"\);/,
    );
    expect(sql).toMatch(/CREATE UNIQUE INDEX "PackageTrialNotice_purchase_id_trial_ends_at_key"/);
  });
  it('enables RLS with anon deny on both new tables and leaves CoachPackage policies alone', () => {
    for (const t of ['PackageTrialUsage', 'PackageTrialNotice']) {
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON TABLE "${t}" FROM anon;`);
    }
    expect(sql).not.toMatch(/POLICY[^;]*ON "CoachPackage"/);
  });
});
