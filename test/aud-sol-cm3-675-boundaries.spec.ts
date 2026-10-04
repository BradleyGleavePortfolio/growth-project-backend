/**
 * Independent CM2 acceptance probe. Disposable PostgreSQL in this CI runner,
 * actual Prisma, actual package controller/service and actual authorization
 * guards. Only JWKS verification and advisory PTM delivery are synthetic.
 * Not a production, migration/RLS, pooler or device acceptance test.
 */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import {
  BadRequestException, Controller, HttpException, INestApplication, Post,
  UnprocessableEntityException, UseFilters, ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { SubscriptionGuard } from '../src/billing/subscription.guard';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { PackagesService } from '../src/packages/packages.service';
import { CoachPackagesController } from '../src/packages/packages.controller';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { PackageValidationFilter } from '../src/packages/package-validation.filter';

let thrown: unknown;
@Controller('audit-old-packages')
@UseFilters(PackageValidationFilter)
class OldPackagesErrors {
  @Post()
  error() { throw thrown; }
}
@Controller('audit-unrelated')
class UnrelatedErrors {
  @Post()
  error() { throw thrown; }
}

jest.setTimeout(180000);

const BODY = {
  name: 'Synthetic monthly package',
  amount_cents: 4900,
  billing_type: 'recurring',
  billing_interval: 'month',
  billing_interval_count: 1,
};
const INPUT = {
  name: BODY.name,
  amount_cents: BODY.amount_cents,
  billing_type: 'recurring' as const,
  interval: 'month' as const,
  interval_count: 1,
};

describe('CM2 disposable PostgreSQL and HTTP acceptance', () => {
  const container = `aud-sol-cm2-${process.pid}`;
  let app: INestApplication;
  let prisma: PrismaService;
  let scope: SubCoachScopeService;
  let origin: string;
  let started = false;
  const previousDb = process.env.DATABASE_URL;
  const previousDirect = process.env.DIRECT_URL;

  beforeAll(async () => {
    execFileSync('docker', [
      'run', '--detach', '--name', container,
      '-e', 'POSTGRES_PASSWORD=cm2_synthetic_only',
      '-e', 'POSTGRES_DB=cm2',
      '-p', '127.0.0.1:0:5432', 'postgres:17-alpine',
    ], { timeout: 120000 });
    started = true;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], {
          stdio: 'pipe', timeout: 3000,
        });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    expect(ready).toBe(true);
    const mapped = execFileSync('docker', ['port', container, '5432/tcp']).toString().trim();
    const port = mapped.split(':').pop();
    const url = `postgresql://postgres:cm2_synthetic_only@127.0.0.1:${port}/cm2`;
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    // Schema from the exact candidate; do not execute production migrations.
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe', timeout: 90000,
    });
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.user.createMany({
      data: [
        { id: 'audit-coach-1', supabase_id: 'audit-coach-1', email: 'coach1@example.invalid', name: 'Synthetic Coach', role: 'coach' },
        { id: 'audit-coach-2', supabase_id: 'audit-coach-2', email: 'coach2@example.invalid', name: 'Other Coach', role: 'coach' },
        { id: 'audit-student', supabase_id: 'audit-student', email: 'student@example.invalid', name: 'Synthetic Student', role: 'student' },
        { id: 'audit-deleted', supabase_id: 'audit-deleted', email: 'deleted@example.invalid', name: 'Synthetic Deleted', role: 'coach', deleted_at: new Date() },
      ],
    });
    scope = new SubCoachScopeService(prisma);
    const jwt = Reflect.construct(JwtAuthGuard, [
      prisma, { verify: async (token: string) => ({ sub: token }) },
      new Reflector(), { emit: () => undefined },
    ]);
    const subscription = new SubscriptionGuard(prisma, new Reflector());
    const module = await Test.createTestingModule({
      controllers: [CoachPackagesController, OldPackagesErrors, UnrelatedErrors],
      providers: [
        PackagesService, SubCoachScopeService,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(jwt)
      .overrideGuard(SubscriptionGuard).useValue(subscription)
      .compile();
    app = module.createNestApplication();
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = 'audit-fixed-request-id';
      next();
    });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({
      transform: true, whitelist: true, forbidNonWhitelisted: true,
    }));
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await prisma.coachPackage.deleteMany();
    await prisma.workoutBuilderIdempotencyKey.deleteMany();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    if (started) execFileSync('docker', ['rm', '--force', container], { stdio: 'pipe' });
    if (previousDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDb;
    if (previousDirect === undefined) delete process.env.DIRECT_URL;
    else process.env.DIRECT_URL = previousDirect;
  });

  async function post(key: string | undefined, token = 'audit-coach-1', body = BODY) {
    const response = await fetch(`${origin}/v1/coach/packages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  // Dynamic invocation keeps this entire file compilable at the old B-641-5
  // head. The baseline lane selects only the same-key HTTP test.
  function create(
    service: PackagesService,
    key: string,
    input: Parameters<PackagesService['create']>[1] = INPUT,
  ) {
    const method = Reflect.get(service, 'createIdempotent');
    if (typeof method !== 'function') throw new Error('createIdempotent unavailable');
    return Reflect.apply(method, service, ['audit-coach-1', input, key]) as Promise<{
      pkg: { id: string };
      replayed: boolean;
    }>;
  }

  function fence(rollBack: boolean) {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atCommit = new Promise<void>((resolve) => (entered = resolve));
    const client = {
      coachPackage: prisma.coachPackage,
      workoutBuilderIdempotencyKey: prisma.workoutBuilderIdempotencyKey,
      $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          const value = await callback(tx);
          entered();
          await gate;
          if (rollBack) throw new Error('Synthetic pre-commit abort');
          return value;
        }, { timeout: 15000, maxWait: 15000 }),
    };
    const service: PackagesService = Reflect.construct(PackagesService, [client, scope]);
    return { service, release, atCommit };
  }

  it('same-key HTTP creates survive a lost response: one database row and replay header', async () => {
    const first = await post('audit-key-lost-response');
    expect(first.status).toBe(201);
    const second = await post('audit-key-lost-response');
    expect(second.status).toBe(201);
    // Deliberately assert the persisted invariant before response headers.
    expect(await prisma.coachPackage.count()).toBe(1);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await prisma.workoutBuilderIdempotencyKey.count()).toBe(1);
  });

  it('same key waits on a real uncommitted unique claim and replays after commit', async () => {
    const held = fence(false);
    const first = create(held.service, 'audit-key-concurrent-commit');
    await held.atCommit;
    let settled = false;
    const second = create(new PackagesService(prisma, scope), 'audit-key-concurrent-commit')
      .then((value) => { settled = true; return value; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      expect(await prisma.coachPackage.count()).toBe(0);
    } finally {
      held.release();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(b.pkg.id).toBe(a.pkg.id);
    expect(b.replayed).toBe(true);
    expect(await prisma.coachPackage.count()).toBe(1);
  });

  it('a waiting same-key request creates once if the first transaction rolls back', async () => {
    const held = fence(true);
    const first = create(held.service, 'audit-key-concurrent-rollback')
      .catch((error: unknown) => error);
    await held.atCommit;
    const second = create(new PackagesService(prisma, scope), 'audit-key-concurrent-rollback');
    held.release();
    expect(await first).toEqual(new Error('Synthetic pre-commit abort'));
    const result = await second;
    expect(result.replayed).toBe(false);
    expect(await prisma.coachPackage.count()).toBe(1);
    expect(await prisma.workoutBuilderIdempotencyKey.count()).toBe(1);
  });

  it('mismatched details are 422 and cannot insert a second package', async () => {
    const a = await post('audit-key-mismatch');
    const b = await post('audit-key-mismatch', 'audit-coach-1', { ...BODY, amount_cents: 5900 });
    expect(b.status).toBe(422);
    expect(b.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(b.body.package_id).toBe(a.body.id);
    expect(await prisma.coachPackage.count()).toBe(1);
  });

  it('defaulted optional fields normalize to the same fingerprint', async () => {
    const service = new PackagesService(prisma, scope);
    const a = await create(service, 'audit-key-defaults');
    const b = await create(service, 'audit-key-defaults', { ...INPUT, currency: 'USD', description: null });
    expect(b.pkg.id).toBe(a.pkg.id);
    expect(b.replayed).toBe(true);
  });

  it('the same key for another authenticated coach never replays the first tenant', async () => {
    const a = await post('audit-key-two-tenants');
    const b = await post('audit-key-two-tenants', 'audit-coach-2');
    expect(b.status).toBe(201);
    expect(b.body.coach_id).toBe('audit-coach-2');
    expect(b.body.id).not.toBe(a.body.id);
    expect(await prisma.coachPackage.count()).toBe(2);
  });

  it('denied authentication, role and deleted-account requests write neither row', async () => {
    expect((await post('audit-key-no-auth', '')).status).toBe(401);
    expect((await post('audit-key-student', 'audit-student')).status).toBe(403);
    expect((await post('audit-key-deleted', 'audit-deleted')).status).toBe(403);
    expect(await prisma.coachPackage.count()).toBe(0);
    expect(await prisma.workoutBuilderIdempotencyKey.count()).toBe(0);
  });

  it('invalid header and invalid pricing do not burn a valid retry key', async () => {
    expect((await post('bad key')).status).toBe(400);
    expect((await post('audit-key-price', 'audit-coach-1', { ...BODY, amount_cents: 10 })).status).toBe(400);
    expect(await prisma.workoutBuilderIdempotencyKey.count()).toBe(0);
    expect((await post('audit-key-price')).status).toBe(201);
    expect(await prisma.coachPackage.count()).toBe(1);
  });

  it('physically removed package returns 410 without minting a replacement', async () => {
    await post('audit-key-removed');
    await prisma.coachPackage.deleteMany();
    const replay = await post('audit-key-removed');
    expect(replay.status).toBe(410);
    expect(replay.body.code).toBe('IDEMPOTENT_PACKAGE_REMOVED');
    expect(await prisma.coachPackage.count()).toBe(0);
  });

  async function request(method: string, path: string, body?: object) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer audit-coach-1',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  it('new scoped filter leaves all other error bodies equal to the old controller envelope', async () => {
    const service = app.get(PackagesService);
    const fail = jest.spyOn(service, 'createIdempotent');
    const cases: unknown[] = [
      new BadRequestException({ message: ['name must be a string'], error: 'Bad Request' }),
      ...[400, 401, 403, 404, 409, 410, 422, 429, 500].map((status) =>
        new HttpException({
          code: `AUDIT_${status}`, message: ['Unchanged message'], error: 'Unchanged error',
          package_id: '11111111-1111-4111-8111-111111111111', private_extra: 'not-on-wire',
        }, status),
      ),
      new UnprocessableEntityException('Plain 422'),
      new UnprocessableEntityException({
        code: 'OTHER_CODE', package_id: '11111111-1111-4111-8111-111111111111',
        message: 'Other 422',
      }),
      new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED', package_id: 'not-a-uuid', message: 'Malformed identifier',
      }),
      new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED', package_id: '11111111-1111-4111-8111-111111111111',
        message: 'Must be sanitized',
      }, { cause: Object.assign(new Error('Synthetic database diagnostic'), {
        name: 'PrismaClientValidationError',
      }) }),
    ];
    const normalized = (body: Record<string, unknown>) => {
      const { timestamp, path, ...rest } = body;
      expect(typeof timestamp).toBe('string');
      return rest;
    };
    for (const error of cases) {
      thrown = error;
      fail.mockRejectedValue(error);
      const control = await request('POST', '/audit-old-packages');
      const actual = await post('audit-key-filter-parity');
      expect(actual.status).toBe(control.status);
      expect(normalized(actual.body)).toEqual(normalized(control.body));
      expect(actual.body.request_id).toBe('audit-fixed-request-id');
      expect(actual.body).not.toHaveProperty('package_id');
      expect(actual.body).not.toHaveProperty('private_extra');
    }
  });

  it('the package-id extension cannot appear on an unrelated controller', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    thrown = new UnprocessableEntityException({
      code: 'IDEMPOTENCY_KEY_REUSED', package_id: id, message: 'Adopt current package',
      private_extra: 'not-on-wire',
    });
    const service = app.get(PackagesService);
    jest.spyOn(service, 'createIdempotent').mockRejectedValue(thrown);
    const scoped = await post('audit-key-only-scoped');
    const unrelated = await request('POST', '/audit-unrelated');
    expect(scoped.body.package_id).toBe(id);
    expect(scoped.body.request_id).toBe('audit-fixed-request-id');
    expect(unrelated.status).toBe(422);
    expect(unrelated.body).not.toHaveProperty('package_id');
    expect(scoped.body).not.toHaveProperty('private_extra');
    expect(unrelated.body).not.toHaveProperty('private_extra');
  });

  it('archive replay is 410 for equal or changed details, then a fresh key creates one new row', async () => {
    const first = await post('audit-key-archive');
    const archived = await request('DELETE', `/v1/coach/packages/${first.body.id}`);
    expect(archived.status).toBe(200);
    for (const input of [BODY, { ...BODY, amount_cents: 5900 }]) {
      const retry = await post('audit-key-archive', 'audit-coach-1', input);
      expect(retry.status).toBe(410);
      expect(retry.body.code).toBe('IDEMPOTENT_PACKAGE_REMOVED');
      expect(retry.body.message).toMatch(/archived.*new request/i);
      expect(retry.body).not.toHaveProperty('package_id');
      expect(retry.headers.get('Idempotent-Replayed')).toBeNull();
    }
    const fresh = await post('audit-key-archive-fresh');
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(first.body.id);
    expect(await prisma.coachPackage.count()).toBe(2);
  });

  it('a durable actor claim cannot expose a package after its effective catalog changes', async () => {
    const first = await post('audit-key-catalog-moved');
    const service = app.get(PackagesService);
    jest.spyOn(service, 'resolveEffectiveCoachId').mockResolvedValue('audit-coach-2');
    for (const input of [BODY, { ...BODY, amount_cents: 5900 }]) {
      const moved = await post('audit-key-catalog-moved', 'audit-coach-1', input);
      expect(moved.status).toBe(410);
      expect(moved.body.code).toBe('IDEMPOTENT_PACKAGE_REMOVED');
      expect(JSON.stringify(moved.body)).not.toContain(first.body.id);
      expect(moved.headers.get('Idempotent-Replayed')).toBeNull();
    }
    const fresh = await post('audit-key-catalog-fresh');
    expect(fresh.body.coach_id).toBe('audit-coach-2');
    expect(fresh.body.id).not.toBe(first.body.id);
  });

  it('pre-trial persistent keys replay after the trial default is added, but non-default terms do not collide', async () => {
    const first = await post('audit-key-default-added');
    const service = app.get(PackagesService);
    const original = Reflect.get(service, 'createData') as (
      coach: string, input: Record<string, unknown>
    ) => Record<string, unknown>;
    Reflect.set(service, 'createData', (coach: string, input: Record<string, unknown>) => ({
      ...original.call(service, coach, input),
      trial_days: input.trial_days ?? 0,
    }));
    try {
      const replay = await post('audit-key-default-added');
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
      const explicit = await service.createIdempotent(
        'audit-coach-1', { ...INPUT, trial_days: 0 } as typeof INPUT, 'audit-key-default-added',
      );
      expect(explicit.pkg.id).toBe(first.body.id);
      const changed = await service.createIdempotent(
        'audit-coach-1', { ...INPUT, trial_days: 7 } as typeof INPUT, 'audit-key-default-added',
      ).catch((error: unknown) => error);
      expect(changed).toBeInstanceOf(UnprocessableEntityException);
      expect((changed as UnprocessableEntityException).getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED', package_id: first.body.id,
      });
      expect(await prisma.coachPackage.count()).toBe(1);
    } finally {
      Reflect.set(service, 'createData', original);
    }
  });
});
