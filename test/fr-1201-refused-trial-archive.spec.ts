// FR-1201 (LS-1201 B2) — a refused web trial is not an active subscriber.
//
// refuseSecondTrial moves the row to conversion_failed_terminal with
// last_error 'trial_already_used' and cancels the subscription; it never
// creates a purchase or an account link (created_user_id stays null). Its
// subscription cannot bill either way: a web trial is created with
// cancel_at_period_end and trial_settings missing_payment_method=cancel
// (test/b-recur-subscription-wire.spec.ts, test/b-trials-package-rules.spec.ts),
// and only the winning conversion lifts that end (attachGuestTrialCard runs
// after the claim, never for a refused row). So the coach may archive.
//
// Every other guest row with a live subscription id keeps the gate: a paid
// or retrying row, a held-for-refund row (paid, the subscription still
// bills), a row whose retries ran out, and a terminal row with no reason.
//
// The in-memory Prisma here evaluates where clauses the way Postgres does
// (AND, OR, NOT, not, in, notIn; a comparison with NULL is unknown and an
// unknown row is not counted), so a filter that drops NULL rows by accident
// fails here too.
import { ConflictException } from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';

type Row = Record<string, unknown>;

function cast<T>(v: unknown): T {
  return v as T;
}
type Tri = boolean | null;

const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not = (x: Tri): Tri => (x === null ? null : !x);

function field(value: unknown, cond: unknown): Tri {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date || typeof cond !== 'object') {
    if (value === null || value === undefined) return null;
    return value instanceof Date && cond instanceof Date ? value.getTime() === cond.getTime() : value === cond;
  }
  const ops = cond as Record<string, unknown>;
  const parts: Tri[] = [];
  for (const [op, arg] of Object.entries(ops)) {
    if (op === 'equals') parts.push(field(value, arg));
    else if (op === 'not') parts.push(arg === null ? value !== null && value !== undefined : not(field(value, arg)));
    else if (op === 'in' || op === 'notIn') {
      const hit: Tri = value === null || value === undefined ? null : (arg as unknown[]).includes(value);
      parts.push(op === 'in' ? hit : not(hit));
    } else throw new Error(`unmodelled operator ${op}`);
  }
  return and(parts);
}

function evalWhere(row: Row, where: Record<string, unknown>): Tri {
  const parts: Tri[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') parts.push(and((Array.isArray(v) ? v : [v]).map((w) => evalWhere(row, w))));
    else if (k === 'OR') parts.push(or((v as Record<string, unknown>[]).map((w) => evalWhere(row, w))));
    else if (k === 'NOT') parts.push(and((Array.isArray(v) ? v : [v]).map((w) => not(evalWhere(row, w)))));
    else parts.push(field(row[k], v));
  }
  return and(parts);
}

const RECURRING = { id: 'pkg-recurring', coach_id: 'coach-1', archived_at: null, is_active: true, pricing_type: 'recurring' };
const COMBO = { id: 'pkg-combo', coach_id: 'coach-1', archived_at: null, is_active: true, pricing_type: 'combo' };

function world(guests: Row[], purchases: Row[] = []) {
  const packages: Row[] = [{ ...RECURRING }, { ...COMBO }];
  const count = (rows: Row[]) =>
    jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => evalWhere(r, where) === true).length);
  const db = {
    coachPackage: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        packages.find((p) => evalWhere(p, where) === true) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const p = packages.find((x) => x.id === where.id) as Row;
        Object.assign(p, data);
        return p;
      }),
    },
    clientPurchase: { count: count(purchases) },
    guestCheckout: { count: count(guests) },
  };
  return {
    db,
    service: new PackagesService(cast<ConstructorParameters<typeof PackagesService>[0]>(db), cast<ConstructorParameters<typeof PackagesService>[1]>({})),
  };
}

let seq = 0;
function guest(over: Row): Row {
  seq += 1;
  return {
    id: `gc-${seq}`,
    package_id: RECURRING.id,
    created_user_id: null,
    stripe_subscription_id: `sub_fr1201_${seq}`,
    status: 'paid',
    last_error: null,
    ...over,
  };
}

const REFUSED = { status: 'conversion_failed_terminal', last_error: 'trial_already_used' };

async function archiveResult(packageId: string, guests: Row[], purchases: Row[] = []) {
  const { service, db } = world(guests, purchases);
  try {
    await service.archive('coach-1', packageId);
    return { archived: true, count: 0, updates: db.coachPackage.update.mock.calls.length };
  } catch (err) {
    if (!(err instanceof ConflictException)) throw err;
    const body = err.getResponse() as { code: string; active_subscriber_count: number };
    expect(body.code).toBe('PACKAGE_HAS_ACTIVE_SUBSCRIBERS');
    return { archived: false, count: body.active_subscriber_count, updates: db.coachPackage.update.mock.calls.length };
  }
}

describe('FR-1201 F2 — a refused web trial does not block archiving its package', () => {
  it('a refused trial on a recurring package: the coach can archive', async () => {
    const r = await archiveResult(RECURRING.id, [guest(REFUSED)]);
    expect(r).toEqual({ archived: true, count: 0, updates: 1 });
  });

  it('a refused-trial row on a combo package: the coach can archive (web combos never trial; same rule)', async () => {
    const r = await archiveResult(COMBO.id, [guest({ ...REFUSED, package_id: COMBO.id })]);
    expect(r).toEqual({ archived: true, count: 0, updates: 1 });
  });

  it('two refused buyers on one package: still archivable', async () => {
    const r = await archiveResult(RECURRING.id, [guest(REFUSED), guest(REFUSED)]);
    expect(r.archived).toBe(true);
  });

  it('a refused trial plus a converted paying client: the client still blocks (count 1)', async () => {
    const purchases = [{ package_id: RECURRING.id, entitlement_active: true, stripe_subscription_id: 'sub_live', status: 'active' }];
    const r = await archiveResult(RECURRING.id, [guest(REFUSED)], purchases);
    expect(r).toEqual({ archived: false, count: 1, updates: 0 });
  });
});

describe('FR-1201 F2 — every other guest row with a subscription keeps the gate', () => {
  it.each<[string, Row]>([
    ['paid, conversion not yet run', { status: 'paid' }],
    ['conversion retrying', { status: 'conversion_failed_retryable', last_error: 'user_create_failed' }],
    ['held for refund (paid, other coach; the subscription still bills)', { status: 'conversion_failed_terminal', last_error: 'buyer_has_other_coach' }],
    ['retries ran out (paid, no account)', { status: 'conversion_failed_terminal', last_error: 'user_create_failed' }],
    ['terminal with no reason (NULL last_error)', { status: 'conversion_failed_terminal', last_error: null }],
    ['pending sentinel with a subscription', { status: 'pending' }],
    ['the refusal reason on a non-terminal row', { status: 'conversion_failed_retryable', last_error: 'trial_already_used' }],
  ])('%s: archive is refused', async (_label, over) => {
    const r = await archiveResult(RECURRING.id, [guest(over)]);
    expect(r).toEqual({ archived: false, count: 1, updates: 0 });
  });

  it('the same on a combo package: a held-for-refund combo row blocks', async () => {
    const r = await archiveResult(COMBO.id, [
      guest({ package_id: COMBO.id, status: 'conversion_failed_terminal', last_error: 'buyer_has_other_coach' }),
    ]);
    expect(r).toEqual({ archived: false, count: 1, updates: 0 });
  });

  it('a refused trial beside a held-for-refund row: only the held row counts', async () => {
    const r = await archiveResult(RECURRING.id, [
      guest(REFUSED),
      guest({ status: 'conversion_failed_terminal', last_error: 'buyer_has_other_coach' }),
    ]);
    expect(r).toEqual({ archived: false, count: 1, updates: 0 });
  });

  it('unchanged: a failed row and a row with no subscription never counted', async () => {
    const r = await archiveResult(RECURRING.id, [guest({ status: 'failed' }), guest({ stripe_subscription_id: null })]);
    expect(r.archived).toBe(true);
  });

  it('unchanged: a guest row linked to an account is counted through its purchase, not here', async () => {
    const r = await archiveResult(RECURRING.id, [guest({ ...REFUSED, created_user_id: 'user-1', status: 'converted', last_error: null })]);
    expect(r.archived).toBe(true);
  });
});
