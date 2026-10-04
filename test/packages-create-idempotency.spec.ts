/**
 * OR-112-16 / B-641-5 (S-COACH-3, agent 113): POST /v1/coach/packages is
 * idempotent per coach and Idempotency-Key, end to end.
 *
 * The Prisma double below models what matters for the guarantee:
 *  - the WorkoutBuilderIdempotencyKey unique index (user_id, route_key,
 *    idempotency_key), including Postgres's behaviour that an INSERT which
 *    collides with an UNCOMMITTED row in another transaction WAITS for that
 *    transaction, then fails (P2002) if it committed or proceeds if it rolled
 *    back;
 *  - interactive transactions that commit or roll back as a unit.
 * Every test here fails at bb17e19a (create ignored the key: two rows).
 */
import { BadRequestException, GoneException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CoachPackagesController } from '../src/packages/packages.controller';
import {
  PACKAGE_CREATE_ROUTE_KEY,
  PackagesService,
  packageCreateFingerprint,
  packageCreateHash,
} from '../src/packages/packages.service';

type Row = Record<string, unknown> & { id: string };

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makeDb() {
  const packages: Row[] = [];
  const ledger: Row[] = [];
  let seq = 0;
  // S-COACH-BE-4: lets a test make the PACKAGE insert hit a unique index.
  const flags = { packageUniqueViolation: false };
  // key -> promise resolved when the transaction holding it ends
  const pendingKeys = new Map<string, Promise<void>>();
  const ledgerKey = (d: Record<string, unknown>) =>
    `${String(d.user_id)}|${String(d.route_key)}|${String(d.idempotency_key)}`;

  /** A client bound to one transaction's private write set. */
  function client(tx: { pkgs: Row[]; led: Row[]; held: string[]; done: Promise<void> } | null) {
    const allLedger = () => [...ledger, ...(tx ? tx.led : [])];
    const allPkgs = () => [...packages, ...(tx ? tx.pkgs : [])];
    return {
      coachPackage: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (flags.packageUniqueViolation) throw p2002();
          const row: Row = { ...data, id: `pkg-${++seq}`, created_at: new Date() };
          if (tx) tx.pkgs.push(row);
          else packages.push(row);
          return { ...row };
        }),
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const r = allPkgs().find((p) => Object.entries(where).every(([k, v]) => p[k] === v));
          return r ? { ...r } : null;
        }),
      },
      workoutBuilderIdempotencyKey: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const k = ledgerKey(data);
          // Another open transaction holds this key: wait for it to end.
          while (pendingKeys.has(k) && !(tx && tx.held.includes(k))) {
            await pendingKeys.get(k);
          }
          if (allLedger().some((r) => ledgerKey(r) === k)) throw p2002();
          const row: Row = { ...data, id: `led-${++seq}` };
          if (tx) {
            tx.led.push(row);
            tx.held.push(k);
            pendingKeys.set(k, tx.done);
          } else ledger.push(row);
          return { ...row };
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const r = allLedger().find((x) => x.id === where.id);
            if (!r) throw new Error('ledger row not found');
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
            const k = ledgerKey(where.WorkoutBuilderIdempotencyKey_user_route_key_key);
            const r = allLedger().find((x) => ledgerKey(x) === k);
            return r ? { ...r } : null;
          },
        ),
      },
    };
  }

  const root = {
    ...client(null),
    // Hooks a test can use to pause a transaction mid-flight.
    beforeCommit: null as null | (() => Promise<void>),
    failInsideTx: false,
    $transaction: jest.fn(async <T>(cb: (tx: ReturnType<typeof client>) => Promise<T>) => {
      let end: () => void = () => undefined;
      const done = new Promise<void>((r) => (end = r));
      const tx = { pkgs: [] as Row[], led: [] as Row[], held: [] as string[], done };
      try {
        const out = await cb(client(tx));
        if (root.beforeCommit) await root.beforeCommit();
        if (root.failInsideTx) throw new Error('connection reset');
        packages.push(...tx.pkgs);
        ledger.push(...tx.led);
        return out;
      } finally {
        for (const k of tx.held) pendingKeys.delete(k);
        end();
      }
    }),
  };
  return { root, packages, ledger, flags };
}

const INPUT = {
  name: 'North coaching',
  description: 'Coaching for strength.',
  amount_cents: 4900,
  currency: 'usd',
  billing_type: 'recurring' as const,
  interval: 'month' as const,
  interval_count: 1,
};

function service(db: ReturnType<typeof makeDb>) {
  // Structural doubles (only the delegates create() touches).
  const prisma: any = db.root;
  const subCoachScope: any = {
    getHeadCoachIdForSubCoach: jest.fn(async (id: string) => (id === 'sub-1' ? 'coach-1' : null)),
  };
  return new PackagesService(prisma, subCoachScope);
}

describe('OR-112-16 package create is idempotent per Idempotency-Key', () => {
  it('two sequential creates with one key make one package and return the same id', async () => {
    const db = makeDb();
    const svc = service(db);
    const a = await svc.createIdempotent('coach-1', INPUT, 'key-aaaaaaaa');
    const b = await svc.createIdempotent('coach-1', INPUT, 'key-aaaaaaaa');
    expect(db.packages).toHaveLength(1);
    expect(b.pkg.id).toBe(a.pkg.id);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(db.ledger[0]).toMatchObject({
      route_key: PACKAGE_CREATE_ROUTE_KEY,
      user_id: 'coach-1',
      status: 'completed',
      status_code: 201,
    });
  });

  it('a retry that arrives while the first request is still running waits and gets the same package', async () => {
    const db = makeDb();
    const svc = service(db);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    db.root.beforeCommit = async () => {
      db.root.beforeCommit = null; // only the first transaction pauses
      await gate;
    };
    const first = svc.createIdempotent('coach-1', INPUT, 'key-bbbbbbbb');
    await new Promise((r) => setImmediate(r));
    const second = svc.createIdempotent('coach-1', INPUT, 'key-bbbbbbbb');
    await new Promise((r) => setImmediate(r));
    // Nothing committed yet: the device would see an empty list here.
    expect(db.packages).toHaveLength(0);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(db.packages).toHaveLength(1);
    expect(b.pkg.id).toBe(a.pkg.id);
  });

  it('concurrent identical drafts with DIFFERENT keys are two packages (the key, not the content, is the identity)', async () => {
    const db = makeDb();
    const svc = service(db);
    await Promise.all([
      svc.createIdempotent('coach-1', INPUT, 'key-cccccccc'),
      svc.createIdempotent('coach-1', INPUT, 'key-dddddddd'),
    ]);
    expect(db.packages).toHaveLength(2);
  });

  it('a request that fails mid-transaction leaves no package and no claim, so the retry creates it once', async () => {
    const db = makeDb();
    const svc = service(db);
    db.root.failInsideTx = true;
    await expect(svc.createIdempotent('coach-1', INPUT, 'key-eeeeeeee')).rejects.toThrow(
      'connection reset',
    );
    expect(db.packages).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
    db.root.failInsideTx = false;
    const r = await svc.createIdempotent('coach-1', INPUT, 'key-eeeeeeee');
    expect(r.replayed).toBe(false);
    expect(db.packages).toHaveLength(1);
  });

  it('the same key with different details is 422 IDEMPOTENCY_KEY_REUSED naming the original package', async () => {
    const db = makeDb();
    const svc = service(db);
    const a = await svc.createIdempotent('coach-1', INPUT, 'key-ffffffff');
    const err = await svc
      .createIdempotent('coach-1', { ...INPUT, amount_cents: 5900 }, 'key-ffffffff')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      package_id: a.pkg.id,
    });
    expect(db.packages).toHaveLength(1);
  });

  it('keys are per coach: another coach with the same key gets their own package', async () => {
    const db = makeDb();
    const svc = service(db);
    const a = await svc.createIdempotent('coach-1', INPUT, 'key-gggggggg');
    const b = await svc.createIdempotent('coach-2', INPUT, 'key-gggggggg');
    expect(b.pkg.id).not.toBe(a.pkg.id);
    expect(b.pkg.coach_id).toBe('coach-2');
  });

  it('a pricing error is refused before the key is claimed, so the fixed retry can reuse it', async () => {
    const db = makeDb();
    const svc = service(db);
    await expect(
      svc.createIdempotent('coach-1', { ...INPUT, amount_cents: 10 }, 'key-hhhhhhhh'),
    ).rejects.toThrow();
    expect(db.ledger).toHaveLength(0);
    const ok = await svc.createIdempotent('coach-1', INPUT, 'key-hhhhhhhh');
    expect(ok.replayed).toBe(false);
  });

  it('a malformed key is a specific 400; no key keeps the old behaviour', async () => {
    const db = makeDb();
    const svc = service(db);
    const err = await svc.createIdempotent('coach-1', INPUT, 'bad key!').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
    await svc.createIdempotent('coach-1', INPUT, undefined);
    await svc.createIdempotent('coach-1', INPUT, undefined);
    expect(db.packages).toHaveLength(2);
    expect(db.ledger).toHaveLength(0);
  });

  it('a replay whose package was since removed is 410, so the app starts a fresh create', async () => {
    const db = makeDb();
    const svc = service(db);
    await svc.createIdempotent('coach-1', INPUT, 'key-iiiiiiii');
    db.packages.splice(0, 1);
    await expect(svc.createIdempotent('coach-1', INPUT, 'key-iiiiiiii')).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('C-675-3: a replay whose package the coach archived is 410 with a next action, never the archived row', async () => {
    const db = makeDb();
    const svc = service(db);
    await svc.createIdempotent('coach-1', INPUT, 'key-archived-1');
    // DELETE /v1/coach/packages/:id archives (is_active=false, archived_at set).
    Object.assign(db.packages[0], { archived_at: new Date(), is_active: false });
    for (const input of [INPUT, { ...INPUT, amount_cents: 5900 }]) {
      const err = await svc
        .createIdempotent('coach-1', input, 'key-archived-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoneException);
      const body = (err as GoneException).getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'IDEMPOTENT_PACKAGE_REMOVED' });
      expect(body).not.toHaveProperty('package_id');
      expect(String(body.message)).toBe(
        'The package this request created has since been archived. Send a new request to create it again.',
      );
    }
    expect(db.packages).toHaveLength(1);
  });

  it("B-675-1: the 422 names a package only in the caller's current catalog; a moved sub-coach gets 410", async () => {
    const db = makeDb();
    const svc = service(db);
    // sub-1 created on coach-1's catalog, then moved to coach-2.
    const made = await svc.createIdempotent('coach-1', INPUT, 'key-moved-01', 'sub-1');
    expect(made.pkg.coach_id).toBe('coach-1');
    for (const input of [INPUT, { ...INPUT, amount_cents: 5900 }]) {
      const err = await svc
        .createIdempotent('coach-2', input, 'key-moved-01', 'sub-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoneException);
      const body = (err as GoneException).getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'IDEMPOTENT_PACKAGE_REMOVED' });
      expect(JSON.stringify(body)).not.toContain(made.pkg.id);
    }
  });

  it('a unique violation from the package insert itself is surfaced, never reported as "still being saved"', async () => {
    const db = makeDb();
    const svc = service(db);
    db.flags.packageUniqueViolation = true;
    const err = await svc
      .createIdempotent('coach-1', INPUT, 'key-jjjjjjjj')
      .catch((e: unknown) => e);
    // The claim rolled back with the package, so no key is burned and the
    // error is the real constraint error, not 409 IDEMPOTENCY_IN_PROGRESS.
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(db.ledger).toHaveLength(0);
    db.flags.packageUniqueViolation = false;
    const ok = await svc.createIdempotent('coach-1', INPUT, 'key-jjjjjjjj');
    expect(ok.replayed).toBe(false);
    expect(db.packages).toHaveLength(1);
  });

  it('the request hash is over the normalised body (case of currency does not matter)', () => {
    const h = (c: string) =>
      packageCreateHash({ coach_id: 'c', currency: c.toLowerCase(), amount_cents: 1 });
    expect(h('USD')).toBe(h('usd'));
    expect(packageCreateHash({ a: 1, b: 2 })).toBe(packageCreateHash({ b: 2, a: 1 }));
  });

  it('a body that leaves out a defaulted field replays the key a body that set it to the default claimed', async () => {
    const db = makeDb();
    const svc = service(db);
    const { description: _d, interval_count: _c, currency: _cur, ...bare } = INPUT;
    const a = await svc.createIdempotent(
      'coach-1',
      { ...bare, description: null, currency: 'USD', interval_count: 1, duration_periods: null },
      'key-defaults-1',
    );
    const b = await svc.createIdempotent('coach-1', bare, 'key-defaults-1');
    expect(b.replayed).toBe(true);
    expect(b.pkg.id).toBe(a.pkg.id);
    expect(db.packages).toHaveLength(1);
  });

  it('C-675-2: a column the server adds later with a default leaves old hashes alone; a non-default value is different details', async () => {
    const db = makeDb();
    const svc = service(db);
    const made = await svc.createIdempotent('coach-1', INPUT, 'key-trial-01');
    // The trials piece adds `trial_days: input.trial_days ?? 0` to the row.
    const original = Reflect.get(svc, 'createData') as (
      coach: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown>;
    Reflect.set(
      svc,
      'createData',
      function (this: PackagesService, coach: string, input: Record<string, unknown>) {
        return { ...original.call(this, coach, input), trial_days: input.trial_days ?? 0 };
      },
    );
    const same = await svc.createIdempotent('coach-1', INPUT, 'key-trial-01');
    expect(same).toMatchObject({ replayed: true, pkg: { id: made.pkg.id } });
    const explicitDefault = await svc.createIdempotent(
      'coach-1',
      { ...INPUT, trial_days: 0 } as typeof INPUT,
      'key-trial-01',
    );
    expect(explicitDefault.pkg.id).toBe(made.pkg.id);
    const err = await svc
      .createIdempotent('coach-1', { ...INPUT, trial_days: 7 } as typeof INPUT, 'key-trial-01')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      package_id: made.pkg.id,
    });
    expect(db.packages).toHaveLength(1);
  });

  it('C-675-2: the fingerprint drops only optional columns at their default and keeps the identity', () => {
    const defaults = {
      coach_id: 'c',
      name: 'N',
      amount_cents: 4900,
      currency: 'usd',
      trial_days: 0,
    };
    const row = { ...defaults, interval: 'month' };
    expect(packageCreateFingerprint(row, defaults)).toEqual({
      coach_id: 'c',
      name: 'N',
      amount_cents: 4900,
      interval: 'month',
    });
    const before = packageCreateFingerprint(
      { coach_id: 'c', name: 'N', amount_cents: 4900, currency: 'usd' },
      { coach_id: 'c', name: 'N', amount_cents: 4900, currency: 'usd' },
    );
    expect(packageCreateHash(packageCreateFingerprint(defaults, defaults))).toBe(
      packageCreateHash(before),
    );
    expect(
      packageCreateHash(packageCreateFingerprint({ ...defaults, trial_days: 7 }, defaults)),
    ).not.toBe(packageCreateHash(before));
    // null and absent are the same value, as in packageCreateHash.
    expect(packageCreateFingerprint({ ...defaults, description: null }, defaults)).toEqual(
      packageCreateFingerprint(defaults, defaults),
    );
    // Identity keys always count, even though they equal their own defaults row.
    const named = (name: string, amount: number) => {
      const d = { ...defaults, name, amount_cents: amount };
      return packageCreateHash(packageCreateFingerprint(d, d));
    };
    expect(packageCreateFingerprint(defaults, defaults)).toEqual({
      coach_id: 'c',
      name: 'N',
      amount_cents: 4900,
    });
    expect(named('M', 4900)).not.toBe(named('N', 4900));
    expect(named('N', 5900)).not.toBe(named('N', 4900));
  });
});

describe('OR-112-16 controller forwards Idempotency-Key and marks replays', () => {
  function controllerWith(db: ReturnType<typeof makeDb>) {
    return new CoachPackagesController(service(db));
  }
  // Structural doubles for the authed request and validated DTO.
  const req: any = { user: { id: 'coach-1' } };
  // The wire DTO names the cadence billing_interval / billing_interval_count.
  const body: any = {
    name: INPUT.name,
    description: INPUT.description,
    amount_cents: INPUT.amount_cents,
    currency: INPUT.currency,
    billing_type: 'recurring',
    billing_interval: 'month',
    billing_interval_count: 1,
  };

  it('same key twice: one package, the replay carries Idempotent-Replayed', async () => {
    const db = makeDb();
    const ctl = controllerWith(db);
    const res1 = { setHeader: jest.fn() };
    const res2 = { setHeader: jest.fn() };
    const a = await ctl.create(req, body, 'key-jjjjjjjj', res1);
    const b = await ctl.create(req, body, 'key-jjjjjjjj', res2);
    expect(b.id).toBe(a.id);
    expect(db.packages).toHaveLength(1);
    expect(res1.setHeader).not.toHaveBeenCalled();
    expect(res2.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
  });

  it('a combo package (one-time + recurring companion) replays the same row', async () => {
    const db = makeDb();
    const ctl = controllerWith(db);
    const combo: any = {
      name: 'Kickoff plus monthly',
      amount_cents: 9900,
      billing_type: 'one_time',
      recurring_amount_cents: 4900,
      recurring_interval: 'month',
      recurring_interval_count: 1,
    };
    const res = { setHeader: jest.fn() };
    const a = await ctl.create(req, combo, 'key-kkkkkkkk', res);
    const b = await ctl.create(req, combo, 'key-kkkkkkkk', res);
    expect(b.id).toBe(a.id);
    expect(db.packages).toHaveLength(1);
  });
});

describe('OR-112-16 keys are scoped to the authenticated caller', () => {
  it('a sub-coach creating on the head coach catalog has their own key space', async () => {
    const db = makeDb();
    const ctl = new CoachPackagesController(service(db));
    const res = { setHeader: jest.fn() };
    const body: any = {
      name: INPUT.name,
      amount_cents: INPUT.amount_cents,
      billing_type: 'recurring',
      billing_interval: 'month',
      billing_interval_count: 1,
    };
    const asUser = (id: string): any => ({ user: { id } });
    const head = await ctl.create(asUser('coach-1'), body, 'key-llllllll', res);
    const sub = await ctl.create(asUser('sub-1'), body, 'key-llllllll', res);
    // Both packages belong to the head coach, but the sub-coach's key never
    // replays the head coach's request.
    expect(head.coach_id).toBe('coach-1');
    expect(sub.coach_id).toBe('coach-1');
    expect(sub.id).not.toBe(head.id);
    expect(db.ledger.map((r) => r.user_id).sort()).toEqual(['coach-1', 'sub-1']);
    // And the sub-coach's own retry replays their own package.
    const again = await ctl.create(asUser('sub-1'), body, 'key-llllllll', res);
    expect(again.id).toBe(sub.id);
  });
});
