/**
 * AUD-OPUS-INV5-122 probe (lens only, never merged) — growth-project-backend#658 @ 4bb177c7 (copy of AUD-OPUS-INV3-121 probe; P1 must pass, P3 now asserts the refusal).
 *
 * B-658-9: the B-658-1 fix lets an active team sub-coach bind the HEAD coach's
 * package (free or prepaid) to a code through POST /coach/codes, so every
 * signup with that code receives the head coach's package for $0. On main the
 * only way to bind a package to a code is InviteGrantService.setBinding, which
 * refuses a sub-coach (binding.coach_id = head != caller -> 404), and every
 * financial surface refuses active sub-coaches (NoActiveSubCoachGuard).
 *
 *   P1 (expected to FAIL at 4de7a6dc): a sub-coach create with the head's
 *       package is refused and writes no code.
 *   P2 (passes): legacy setBinding refuses the same sub-coach on the same code.
 *   P3 (passes, shows the consequence): the code the sub-coach created grants
 *       the head's $500 package at amount_cents 0, source invite_grant:free.
 *
 * Real CoachCodeToolsService, InviteCodesService and InviteGrantService over a
 * small in-memory Prisma double (same approach as test/coach-code-tools.service.spec.ts).
 */
import { CoachCodeToolsService } from '../src/invite-codes/coach-code-tools.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteGrantService } from '../src/invite-grant/invite-grant.service';

type Row = Record<string, any>;

const HEAD = 'head-1';
const SUB = 'sub-1';
const CLIENT = 'client-1';
const HEAD_PKG = '11111111-1111-4111-8111-111111111111';

function world() {
  const codes: Row[] = [];
  const profiles: Row[] = [];
  const purchases: Row[] = [];
  const packages: Row[] = [
    {
      id: HEAD_PKG,
      coach_id: HEAD,
      name: 'Head coach 12 weeks',
      amount_cents: 50000,
      currency: 'usd',
      billing_type: 'one_time',
      duration_periods: null,
      interval: null,
      interval_count: 1,
      is_active: true,
      archived_at: null,
      requires_contract: false,
      contract_template_id: null,
    },
  ];
  const seats: Row[] = [{ head_coach_id: HEAD, sub_coach_id: SUB, archived_at: null }];
  const users: Row[] = [
    { id: CLIENT, role: 'student', coach_id: HEAD, email: 'c@example.test', name: 'C' },
  ];
  let seq = 0;
  const eq = (r: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && !(v instanceof Date) ? true : r[k] === v,
    );
  const rel = (r: Row) => ({ ...r, rotated_from: null, rotated_to: null });
  const db: Row = {
    inviteCode: {
      findUnique: jest.fn(async ({ where }: Row) => {
        const k = where.coach_id_idempotency_key;
        const r = k
          ? codes.find((c) => c.coach_id === k.coach_id && c.idempotency_key === k.idempotency_key)
          : codes.find((c) => eq(c, where));
        return r ? rel(r) : null;
      }),
      findMany: jest.fn(async ({ where }: Row) => codes.filter((c) => eq(c, where)).map(rel)),
      create: jest.fn(async ({ data }: Row) => {
        const row = {
          id: `ic-${++seq}`,
          created_at: new Date(),
          used_count: 0,
          revoked: false,
          revoked_at: null,
          expires_at: null,
          max_uses: null,
          label: null,
          intended_email: null,
          invited_by_user_id: null,
          package_id: null,
          grant_mode: 'none',
          rotated_from_id: null,
          idempotency_key: null,
          successor_code: null,
          accepted_by_user_id: null,
          ...data,
        };
        codes.push(row);
        return rel(row);
      }),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: Row) => profiles.find((x) => eq(x, where)) ?? null),
      create: jest.fn(async ({ data }: Row) => {
        const row = {
          id: `cp-${++seq}`,
          invite_code_package_id: null,
          invite_code_grant_mode: 'none',
          created_at: new Date(),
          ...data,
        };
        profiles.push(row);
        return row;
      }),
    },
    coachPackage: {
      findUnique: jest.fn(async ({ where }: Row) => packages.find((p) => p.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: Row) => packages.filter((p) => where.id.in.includes(p.id))),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async ({ where }: Row) => seats.find((s) => eq(s, where)) ?? null),
    },
    teamAuditEvent: { create: jest.fn(async () => ({})) },
    inviteRedemption: { groupBy: jest.fn(async () => []) },
    user: { findUnique: jest.fn(async ({ where }: Row) => users.find((u) => u.id === where.id) ?? null) },
    clientPurchase: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: Row) => {
        const row = { id: `cp-${++seq}`, entitlement_active: create.entitlement_active, ...create };
        purchases.push(row);
        return row;
      }),
    },
  };
  db.$transaction = jest.fn(async (fn: (tx: Row) => Promise<unknown>) => fn(db));
  const prisma: any = db;
  const audit: any = { write: jest.fn(async () => undefined) };
  const stub: any = { capture: jest.fn(), send: jest.fn() };
  const grants = new InviteGrantService(prisma, audit);
  const invites = new InviteCodesService(prisma, stub, stub, audit, grants);
  const tools = new CoachCodeToolsService(prisma, invites, audit, grants);
  return { codes, purchases, grants, tools };
}

const status = async (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: { getStatus?: () => number }) => e.getStatus?.() ?? 'threw',
  );

describe('AUD-OPUS-INV5-122 probe — B-658-9 sub-coach binds the head coach package', () => {
  const sub = { id: SUB, role: 'coach', email: null };
  const prevContracts = process.env.FEATURE_CONTRACTS_ENABLED;
  beforeAll(() => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
  });
  afterAll(() => {
    if (prevContracts === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prevContracts;
  });

  it('P1: a sub-coach cannot bind the head coach package to a code (must PASS at 4bb177c7)', async () => {
    const w = world();
    const out = await status(w.tools.create(sub, { package_id: HEAD_PKG, grant_mode: 'free' }, null));
    // eslint-disable-next-line no-console
    console.log('P1 outcome', out, 'stored codes', JSON.stringify(w.codes.map((c) => ({
      coach_id: c.coach_id, invited_by_user_id: c.invited_by_user_id, package_id: c.package_id, grant_mode: c.grant_mode,
    }))));
    expect(out).toBe(403);
    expect(w.codes).toHaveLength(0);
  });

  it('P2: legacy setBinding refuses the same sub-coach on a sub-issued head-tenant code', async () => {
    const w = world();
    const { code } = await w.tools.create(sub, {}, null);
    await expect(
      w.grants.setBinding(sub, { code: code.code, package_id: HEAD_PKG, grant_mode: 'free' }),
    ).rejects.toMatchObject({ response: { error: 'INVITE_CODE_NOT_FOUND' } });
  });

  it('P4 (B-658-1 replay): a sub-coach cannot see, rotate or revoke the head coach own code', async () => {
    const w = world();
    const head = { id: HEAD, role: 'coach', email: null };
    const { code } = await w.tools.create(head, { label: 'Head front desk' }, null);
    const mine = await w.tools.create(sub, {}, null);
    const subList = (await w.tools.list(SUB)).codes.map((c) => c.id);
    expect(subList).toEqual([mine.code.id]);
    expect(await status(w.tools.rotate(sub, code.id, 0))).toBe(404);
    expect(await status(w.tools.revoke(sub, code.id))).toBe(404);
    expect(w.codes.find((c) => c.id === code.id)).toMatchObject({ revoked: false });
    const headList = (await w.tools.list(HEAD)).codes.map((c) => c.id).sort();
    expect(headList).toEqual(['coach-link', code.id, mine.code.id].sort());
  });

  it('P3 (refused as intended): the sub-coach code with the head package is never created, so no $0 grant exists', async () => {
    const w = world();
    for (const input of [
      { package_id: HEAD_PKG, grant_mode: 'free' as const },
      { package_id: HEAD_PKG, grant_mode: 'prepaid' as const },
      { package_id: HEAD_PKG },
      { grant_mode: 'free' as const },
    ])
      expect(await status(w.tools.create(sub, input, 'opus-inv5-key-01'))).toBe(403);
    expect(w.codes).toHaveLength(0);
    expect(w.purchases).toHaveLength(0);
  });

  it('P5 (head path intact): the head coach still binds its own package and a signup gets it', async () => {
    const w = world();
    const head = { id: HEAD, role: 'coach', email: null };
    const { code } = await w.tools.create(head, { package_id: HEAD_PKG, grant_mode: 'free' }, null);
    expect(code).toMatchObject({ package: { id: HEAD_PKG }, grant_mode: 'free' });
    const binding = await w.grants.resolveBinding(code.code);
    const outcome = await w.grants.grantForAttachedCode({
      clientUserId: CLIENT,
      coachUserId: HEAD,
      binding: binding as NonNullable<typeof binding>,
      redemption: 'new',
    });
    expect(outcome).toMatchObject({ status: 'created' });
    expect(w.purchases).toEqual([
      expect.objectContaining({ package_id: HEAD_PKG, coach_user_id: HEAD, source: 'invite_grant:free' }),
    ]);
  });
});
