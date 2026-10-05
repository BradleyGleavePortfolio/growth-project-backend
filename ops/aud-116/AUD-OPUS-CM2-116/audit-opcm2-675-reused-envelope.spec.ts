/**
 * AUD-OPUS-CM2-116 probe (never merge) — backend #675 @ d1c98430.
 *
 * B-675-1: the 422 IDEMPOTENCY_KEY_REUSED body is documented to name the
 * package the key made ("so the app can adopt it"), and the mobile create
 * path (packageCreateIntent.reusedPackageId) reads `package_id` from it.
 * The service puts `package_id` on the exception, but the global
 * HttpExceptionFilter (src/main.ts useGlobalFilters) rebuilds every error
 * body through buildErrorEnvelope, which keeps only statusCode / code /
 * message / error / timestamp / path / request_id. This probe pushes the
 * real exception through the real filter and reads the wire body.
 *
 * C-675-3: a replay whose package the coach archived (DELETE :id is the
 * only "remove" a coach has) comes back as a 201 replay of the archived
 * row, not 410 IDEMPOTENT_PACKAGE_REMOVED, so the app adopts a package
 * that is off the storefront.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { HttpException } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { PackagesService } from '../src/packages/packages.service';

type Row = Record<string, unknown> & { id: string };

function makeDb() {
  const packages: Row[] = [];
  const ledger: Row[] = [];
  let seq = 0;
  const client = () => ({
    coachPackage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { ...data, id: `pkg-${++seq}`, archived_at: null };
        packages.push(row);
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = packages.find((p) => Object.entries(where).every(([k, v]) => p[k] === v));
        return r ? { ...r } : null;
      }),
    },
    workoutBuilderIdempotencyKey: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const dup = ledger.some(
          (r) =>
            r.user_id === data.user_id &&
            r.route_key === data.route_key &&
            r.idempotency_key === data.idempotency_key,
        );
        if (dup) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Prisma } = require('@prisma/client');
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'probe',
          });
        }
        const row: Row = { ...data, id: `led-${++seq}` };
        ledger.push(row);
        return { ...row };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = ledger.find((x) => x.id === where.id)!;
          Object.assign(r, data);
          return { ...r };
        },
      ),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { WorkoutBuilderIdempotencyKey_user_route_key_key: Record<string, unknown> };
        }) => {
          const w = where.WorkoutBuilderIdempotencyKey_user_route_key_key;
          const r = ledger.find(
            (x) =>
              x.user_id === w.user_id &&
              x.route_key === w.route_key &&
              x.idempotency_key === w.idempotency_key,
          );
          return r ? { ...r } : null;
        },
      ),
    },
  });
  const root = {
    ...client(),
    $transaction: jest.fn(async <T>(cb: (tx: ReturnType<typeof client>) => Promise<T>) =>
      cb(client()),
    ),
  };
  return { root, packages };
}

function service(db: ReturnType<typeof makeDb>): PackagesService {
  const subCoachScope = { getHeadCoachIdForSubCoach: jest.fn(async () => null) };
  return Reflect.construct(PackagesService, [db.root, subCoachScope]);
}

const INPUT = {
  name: 'North coaching',
  amount_cents: 4900,
  currency: 'usd',
  billing_type: 'recurring' as const,
  interval: 'month' as const,
  interval_count: 1,
};

/** The JSON body the real global filter writes for this exception. */
function wireBody(exception: unknown): { status: number; body: Record<string, unknown> } {
  const out = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: Record<string, unknown>) {
      out.body = b;
      return res;
    },
  };
  const req = { url: '/v1/coach/packages', method: 'POST', route: { path: '/v1/coach/packages' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  new HttpExceptionFilter().catch(exception, host as never);
  return out;
}

describe('AUD-OPUS-CM2-116 probe — #675 wire contract', () => {
  it('control: main.ts registers HttpExceptionFilter globally (the envelope every 422 goes through)', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toMatch(/useGlobalFilters\(new HttpExceptionFilter\(\)/);
  });

  it('B-675-1: the 422 IDEMPOTENCY_KEY_REUSED wire body names the package the key made', async () => {
    const db = makeDb();
    const svc = service(db);
    const first = await svc.createIdempotent('coach-1', INPUT, 'key-probe-0001');
    const err = await svc
      .createIdempotent('coach-1', { ...INPUT, amount_cents: 5900 }, 'key-probe-0001')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    // The exception itself carries it (what the PR's spec checks) ...
    expect((err as HttpException).getResponse()).toMatchObject({ package_id: first.pkg.id });
    // ... but the client receives the global envelope.
    const wire = wireBody(err);
    expect(wire.status).toBe(422);
    expect(wire.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(wire.body.package_id).toBe(first.pkg.id);
  });

  it('C-675-3: a replay whose package the coach archived is 410 IDEMPOTENT_PACKAGE_REMOVED', async () => {
    const db = makeDb();
    const svc = service(db);
    const first = await svc.createIdempotent('coach-1', INPUT, 'key-probe-0002');
    // DELETE /v1/coach/packages/:id archives (is_active=false, archived_at set).
    db.packages[0].archived_at = new Date('2026-10-03T00:00:00Z');
    db.packages[0].is_active = false;
    const replay = await svc
      .createIdempotent('coach-1', INPUT, 'key-probe-0002')
      .catch((e: unknown) => e);
    // At d1c98430 this is { pkg: <archived row>, replayed: true } (201).
    expect(replay).toBeInstanceOf(HttpException);
    expect((replay as HttpException).getStatus()).toBe(410);
    expect(first.pkg.id).toBe('pkg-1');
  });
});
