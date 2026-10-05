/**
 * A2 coach code tools — service rules (failing before: none of these routes,
 * the ledger, or the specific refusals existed on main 53b6d472).
 *
 * A small in-memory Prisma double keeps state across calls, so rotate /
 * revoke / idempotency are proven against stored rows, not stubbed returns.
 * The live-DB twin (test/invite-codes/coach-code-tools.live.spec.ts) proves
 * RLS and exact counts against the real migration.
 */
import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import {
  COACH_LINK_ID,
  CoachCodeToolsService,
  codeStatus,
  dateRange,
  isUnusualToday,
  joinUrlFor,
  localDate,
  normaliseIdempotencyKey,
} from '../src/invite-codes/coach-code-tools.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteGrantService } from '../src/invite-grant/invite-grant.service';
import {
  assertCoachCodeToolsEnabled,
  coachCodeToolsEnabled,
} from '../src/invite-codes/coach-code-tools.feature';

type Row = Record<string, any>;

function p2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function makeDb() {
  const codes: Row[] = [];
  const profiles: Row[] = [];
  const redemptions: Row[] = [];
  const packages: Row[] = [
    {
      id: 'pkg-1',
      name: 'Clinic 12 weeks',
      coach_id: 'coach-a',
      is_active: true,
      archived_at: null,
    },
  ];
  const seats: Row[] = []; // TeamSubCoachAssignment
  const teamAudit: Row[] = [];
  let seq = 0;
  const withRelations = (r: Row) => ({
    ...r,
    rotated_from: r.rotated_from_id
      ? (({ id, code }) => ({ id, code }))(codes.find((c) => c.id === r.rotated_from_id) as Row)
      : null,
    rotated_to: (() => {
      const s = codes.find((c) => c.rotated_from_id === r.id);
      return s ? { id: s.id, code: s.code } : null;
    })(),
  });
  const matches = (r: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return (v.in as unknown[]).includes(r[k]);
        if ('is' in v) return codes.some((c) => c.id === r.invite_code_id && matches(c, v.is));
        if ('gte' in v || 'lte' in v) return (!v.gte || r[k] >= v.gte) && (!v.lte || r[k] <= v.lte);
      }
      return r[k] === v;
    });
  const inviteCode = {
    findUnique: jest.fn(async ({ where }: Row) => {
      let r: Row | undefined;
      if (where.coach_id_idempotency_key) {
        const { coach_id, idempotency_key } = where.coach_id_idempotency_key;
        r = codes.find((c) => c.coach_id === coach_id && c.idempotency_key === idempotency_key);
      } else r = codes.find((c) => matches(c, where));
      return r ? withRelations(r) : null;
    }),
    findMany: jest.fn(async ({ where }: Row) =>
      codes.filter((c) => matches(c, where)).map(withRelations),
    ),
    create: jest.fn(async ({ data }: Row) => {
      if (codes.some((c) => c.code === data.code)) throw p2002(['code']);
      if (data.rotated_from_id && codes.some((c) => c.rotated_from_id === data.rotated_from_id))
        throw p2002(['rotated_from_id']);
      if (
        data.idempotency_key &&
        codes.some(
          (c) => c.coach_id === data.coach_id && c.idempotency_key === data.idempotency_key,
        )
      )
        throw p2002(['coach_id', 'idempotency_key']);
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
        ...data,
      };
      codes.push(row);
      return withRelations(row);
    }),
    update: jest.fn(async ({ where, data }: Row) => {
      const r = codes.find((c) => c.id === where.id) as Row;
      Object.assign(r, data);
      return withRelations(r);
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const hit = codes.filter((c) => matches(c, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    delete: jest.fn(async ({ where }: Row) => {
      const i = codes.findIndex((c) => c.id === where.id);
      return codes.splice(i, 1)[0];
    }),
  };
  const coachProfile = {
    findUnique: jest.fn(async ({ where }: Row) => profiles.find((p) => matches(p, where)) ?? null),
    create: jest.fn(async ({ data }: Row) => {
      const row = {
        id: `cp-${++seq}`,
        timezone: null,
        invite_code_package_id: null,
        invite_code_grant_mode: 'none',
        created_at: new Date(),
        ...data,
      };
      profiles.push(row);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const hit = profiles.filter((p) => matches(p, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
  const inviteRedemption = {
    findMany: jest.fn(async ({ where }: Row) => redemptions.filter((r) => matches(r, where))),
    groupBy: jest.fn(async ({ where }: Row) => {
      const m = new Map<string, number>();
      for (const r of redemptions.filter((x) => matches(x, where)))
        m.set(r.code, (m.get(r.code) ?? 0) + 1);
      return [...m.entries()].map(([code, n]) => ({ code, _count: { _all: n } }));
    }),
  };
  const coachPackage = {
    findMany: jest.fn(async ({ where }: Row) => packages.filter((p) => where.id.in.includes(p.id))),
    findUnique: jest.fn(async ({ where }: Row) => packages.find((p) => p.id === where.id) ?? null),
  };
  const teamSubCoachAssignment = {
    findFirst: jest.fn(async ({ where }: Row) => seats.find((r) => matches(r, where)) ?? null),
  };
  const teamAuditEvent = { create: jest.fn(async ({ data }: Row) => teamAudit.push(data)) };
  const db: Row = {
    inviteCode,
    coachProfile,
    inviteRedemption,
    coachPackage,
    teamSubCoachAssignment,
    teamAuditEvent,
  };
  db.$transaction = jest.fn(async (fn: (tx: Row) => Promise<unknown>) => {
    const snapshot = codes.map((c) => ({ ...c }));
    const profSnap = profiles.map((p) => ({ ...p }));
    try {
      return await fn(db);
    } catch (err) {
      codes.splice(0, codes.length, ...snapshot);
      profiles.splice(0, profiles.length, ...profSnap);
      throw err;
    }
  });
  return { db, codes, profiles, redemptions, seats, teamAudit };
}

function build(opts: { grants?: Row } = {}) {
  const store = makeDb();
  const audit = { write: jest.fn(async () => undefined) };
  // Typed doubles: the in-memory store implements exactly the delegate
  // methods these services call (annotation, not a cast).
  const prisma: any = store.db;
  const analytics: any = { capture: jest.fn() };
  const email: any = { send: jest.fn() };
  const auditDouble: any = audit;
  const grants: any = opts.grants ?? new InviteGrantService(prisma, auditDouble);
  const inviteCodes = new InviteCodesService(prisma, analytics, email, auditDouble);
  const tools = new CoachCodeToolsService(prisma, inviteCodes, auditDouble, grants);
  return { ...store, audit, tools, inviteCodes };
}

const coachA = { id: 'coach-a', role: 'coach', email: 'a@example.test' };
const coachB = { id: 'coach-b', role: 'coach', email: 'b@example.test' };

async function errCode(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus: () => number; getResponse: () => { code: string } };
    return { status: err.getStatus(), code: err.getResponse().code };
  }
  throw new Error('expected a refusal');
}

describe('A2 kill switch (FEATURE_COACH_CODE_TOOLS, default OFF)', () => {
  const prev = process.env.FEATURE_COACH_CODE_TOOLS;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEATURE_COACH_CODE_TOOLS;
    else process.env.FEATURE_COACH_CODE_TOOLS = prev;
  });
  it('is off when unset or any value other than "true"', () => {
    delete process.env.FEATURE_COACH_CODE_TOOLS;
    expect(coachCodeToolsEnabled()).toBe(false);
    for (const v of ['1', 'on', 'yes', 'TRUE '])
      expect(coachCodeToolsEnabled({ FEATURE_COACH_CODE_TOOLS: v })).toBe(v === 'TRUE ');
    expect(() => assertCoachCodeToolsEnabled()).toThrow(NotFoundException);
    try {
      assertCoachCodeToolsEnabled();
    } catch (e) {
      expect((e as NotFoundException).getResponse()).toMatchObject({
        code: 'coach_code_tools_disabled',
      });
    }
  });
  it('passes when "true"', () => {
    process.env.FEATURE_COACH_CODE_TOOLS = 'true';
    expect(() => assertCoachCodeToolsEnabled()).not.toThrow();
  });
});

describe('QR payload and helpers', () => {
  it('QR encodes the universal join link for the code', () => {
    expect(joinUrlFor('GP-ABC234', {})).toBe('https://app.trygrowthproject.com/join/GP-ABC234');
    expect(joinUrlFor('GP-ABC234', { PUBLIC_INVITE_BASE_URL: 'https://x.test/join/' })).toBe(
      'https://x.test/join/GP-ABC234',
    );
  });
  it('local dates follow the zone across a DST change', () => {
    // 2026-03-08 is the US spring-forward day. 04:30Z is still 03-07 in New York.
    expect(localDate(new Date('2026-03-08T04:30:00Z'), 'America/New_York')).toBe('2026-03-07');
    expect(localDate(new Date('2026-03-08T05:30:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(dateRange('2026-03-09', 3)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });
  it('flags an unusual day only when it is both busy and well above the trailing week', () => {
    expect(isUnusualToday([0, 0, 0, 0, 0, 0, 0, 2])).toBe(false);
    expect(isUnusualToday([0, 0, 0, 0, 0, 0, 0, 3])).toBe(true);
    expect(isUnusualToday([4, 4, 4, 4, 4, 4, 4, 9])).toBe(false);
    expect(isUnusualToday([4, 4, 4, 4, 4, 4, 4, 12])).toBe(true);
  });
  it('Idempotency-Key is used only when well formed', () => {
    expect(normaliseIdempotencyKey('  abcdefgh  ')).toBe('abcdefgh');
    expect(normaliseIdempotencyKey('short')).toBeNull();
    expect(normaliseIdempotencyKey('has space inside')).toBeNull();
    expect(normaliseIdempotencyKey(undefined)).toBeNull();
  });
  it('status: retiring while a rotated code is inside its grace window', () => {
    const base = {
      revoked: false,
      expires_at: new Date(Date.now() + 3600_000),
      max_uses: null,
      used_count: 0,
    };
    const row = (over: Row): any => ({
      id: 'x',
      code: 'GP-X',
      label: null,
      created_at: new Date(),
      revoked_at: null,
      package_id: null,
      grant_mode: 'none',
      rotated_from: null,
      rotated_to: null,
      ...base,
      ...over,
    });
    expect(codeStatus(row({ rotated_to: { id: 'n', code: 'GP-N' } }))).toBe('retiring');
    expect(codeStatus(row({}))).toBe('active');
    expect(codeStatus(row({ max_uses: 2, used_count: 2 }))).toBe('used_up');
  });
});

describe('create', () => {
  it('mints a GP- code, unlimited and open-ended by default, with an audit row', async () => {
    const { tools, audit } = build();
    const { code, replayed } = await tools.create(
      coachA,
      { label: '  Clinic   front desk ' },
      null,
    );
    expect(replayed).toBe(false);
    expect(code.code).toMatch(/^GP-[2-9A-HJKMNP-Z]{6}$/);
    expect(code).toMatchObject({
      label: 'Clinic front desk',
      max_uses: null,
      expires_at: null,
      status: 'active',
    });
    expect(code.qr_payload).toBe(code.join_url);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invite_code.created', tenantCoachId: 'coach-a' }),
    );
  });

  it('a retried create with the same Idempotency-Key returns the first code, never a second', async () => {
    const { tools, codes } = build();
    const first = await tools.create(coachA, {}, 'key-12345678');
    const second = await tools.create(coachA, {}, 'key-12345678');
    expect(second.replayed).toBe(true);
    expect(second.code.id).toBe(first.code.id);
    expect(codes).toHaveLength(1);
    // Keys are per coach: another coach's identical key is a different code.
    await tools.create(coachB, {}, 'key-12345678');
    expect(codes).toHaveLength(2);
  });

  it('a refused package binding leaves no half-made code and returns a specific code', async () => {
    const { tools, codes } = build(); // real InviteGrantService rules; pkg-x does not exist
    expect(
      await errCode(tools.create(coachA, { package_id: 'pkg-x', grant_mode: 'free' }, null)),
    ).toEqual({
      status: 404,
      code: 'package_not_found',
    });
    expect(codes).toHaveLength(0);
  });

  it('refuses an expiry in the past and a package without a grant mode', async () => {
    const { tools } = build();
    expect(
      (await errCode(tools.create(coachA, { expires_at: '2020-01-01T00:00:00Z' }, null))).code,
    ).toBe('expiry_in_past');
    expect((await errCode(tools.create(coachA, { package_id: 'pkg-1' }, null))).code).toBe(
      'grant_mode_required',
    );
  });
});

describe('rotate', () => {
  it('grace 0: successor keeps every setting, old code is revoked now, lineage is linked', async () => {
    const { tools, codes, audit } = build();
    const { code: old } = await tools.create(coachA, { label: 'Clinic', max_uses: 500 }, null);
    codes[0].package_id = 'pkg-1';
    codes[0].grant_mode = 'prepaid';
    codes[0].used_count = 41;
    const res = await tools.rotate(coachA, old.id, 0);
    expect(res.code).toMatchObject({
      label: 'Clinic',
      max_uses: 500,
      used_count: 0,
      grant_mode: 'prepaid',
      status: 'active',
    });
    expect(res.code.package).toEqual({ id: 'pkg-1', name: 'Clinic 12 weeks' });
    expect(res.code.rotated_from).toEqual({ id: old.id, code: old.code });
    expect(res.previous).toMatchObject({ id: old.id, status: 'revoked' });
    expect(codes.find((c) => c.id === old.id)?.revoked_at).toBeInstanceOf(Date);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invite_code.rotated' }),
    );
  });

  it('grace 24h: old code keeps working until the window ends, then expires', async () => {
    const { tools, codes } = build();
    const { code: old } = await tools.create(coachA, {}, null);
    const before = Date.now();
    const res = await tools.rotate(coachA, old.id, 24);
    const stored = codes.find((c) => c.id === old.id) as Row;
    expect(stored.revoked).toBe(false);
    expect(stored.expires_at.getTime()).toBeGreaterThanOrEqual(before + 24 * 3600_000);
    expect(stored.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    expect(res.previous?.status).toBe('retiring');
  });

  it('a retried rotate returns the existing successor instead of minting another', async () => {
    const { tools, codes } = build();
    const { code: old } = await tools.create(coachA, {}, null);
    const first = await tools.rotate(coachA, old.id, 24);
    const again = await tools.rotate(coachA, old.id, 24);
    expect(again.replayed).toBe(true);
    expect(again.code.id).toBe(first.code.id);
    expect(codes).toHaveLength(2);
  });

  it("tenancy: another coach's code is a non-leaking 404 and is left untouched", async () => {
    const { tools, codes } = build();
    const { code } = await tools.create(coachA, {}, null);
    expect(await errCode(tools.rotate(coachB, code.id, 0))).toEqual({
      status: 404,
      code: 'code_not_found',
    });
    expect(await errCode(tools.revoke(coachB, code.id))).toEqual({
      status: 404,
      code: 'code_not_found',
    });
    expect(codes).toHaveLength(1);
    expect(codes[0].revoked).toBe(false);
  });

  it('a revoked code cannot be rotated', async () => {
    const { tools } = build();
    const { code } = await tools.create(coachA, {}, null);
    await tools.revoke(coachA, code.id);
    expect((await errCode(tools.rotate(coachA, code.id, 0))).code).toBe('code_already_revoked');
  });

  it('coach link: rotating archives the old link code as a revoked row (so it answers code_revoked)', async () => {
    const { tools, profiles, codes } = build();
    profiles.push({
      id: 'cp',
      user_id: 'coach-a',
      invite_code: 'GP-OLD234',
      invite_code_package_id: 'pkg-1',
      invite_code_grant_mode: 'free',
      timezone: null,
      created_at: new Date(),
    });
    const res = await tools.rotate(coachA, COACH_LINK_ID, 0, {}, 'GP-OLD234');
    expect(res.code.kind).toBe('coach_link');
    expect(res.code.code).not.toBe('GP-OLD234');
    expect(profiles[0].invite_code).toBe(res.code.code);
    expect(codes).toEqual([
      expect.objectContaining({
        code: 'GP-OLD234',
        coach_id: 'coach-a',
        revoked: true,
        package_id: 'pkg-1',
        grant_mode: 'free',
        label: 'Previous coach link',
      }),
    ]);
    expect(res.previous?.status).toBe('revoked');
  });
});

describe('revoke', () => {
  it('turns a code off once (idempotent), with one audit row', async () => {
    const { tools, audit } = build();
    const { code } = await tools.create(coachA, {}, null);
    audit.write.mockClear();
    const first = await tools.revoke(coachA, code.id);
    const second = await tools.revoke(coachA, code.id);
    expect(first).toMatchObject({ replayed: false, code: { status: 'revoked' } });
    expect(second.replayed).toBe(true);
    expect(audit.write).toHaveBeenCalledTimes(1);
  });
  it('the coach link can only be rotated, never revoked', async () => {
    const { tools } = build();
    expect(await errCode(tools.revoke(coachA, COACH_LINK_ID))).toEqual({
      status: 409,
      code: 'coach_link_not_revocable',
    });
  });
});

describe('list', () => {
  it('coach link first, own shareable codes only, with exact ledger usage', async () => {
    const { tools, codes, redemptions, profiles } = build();
    profiles.push({
      id: 'cp',
      user_id: 'coach-a',
      invite_code: 'GP-LNK234',
      invite_code_package_id: null,
      invite_code_grant_mode: 'none',
      timezone: null,
      created_at: new Date(),
    });
    const { code } = await tools.create(coachA, { label: 'Clinic' }, null);
    await tools.create(coachB, { label: 'Other coach' }, null);
    codes.push({
      ...codes[0],
      id: 'ic-personal',
      code: 'GP-PER234',
      intended_email: 'x@example.test',
      rotated_from_id: null,
      idempotency_key: null,
    });
    const old = new Date(Date.now() - 10 * 24 * 3600_000);
    redemptions.push(
      { coach_id: 'coach-a', code: code.code, redeemed_at: new Date() },
      { coach_id: 'coach-a', code: code.code, redeemed_at: old },
      { coach_id: 'coach-a', code: 'GP-LNK234', redeemed_at: new Date() },
      { coach_id: 'coach-b', code: code.code, redeemed_at: new Date() },
    );
    const { codes: views } = await tools.list('coach-a');
    expect(views.map((v) => v.code)).toEqual(['GP-LNK234', code.code]);
    expect(views[0]).toMatchObject({ id: COACH_LINK_ID, signups_total: 1, signups_7d: 1 });
    expect(views[1]).toMatchObject({ signups_total: 2, signups_7d: 1 });
  });
});

describe('signups (daily, coach time zone)', () => {
  it('buckets by local calendar day, zero-fills, splits by code and package, and matches the rows exactly', async () => {
    const { tools, redemptions, profiles, codes } = build();
    profiles.push({
      id: 'cp',
      user_id: 'coach-a',
      invite_code: 'GP-LNK234',
      timezone: 'America/New_York',
      invite_code_package_id: null,
      invite_code_grant_mode: 'none',
      created_at: new Date(),
    });
    codes.push({
      id: 'ic-1',
      code: 'GP-CLN234',
      coach_id: 'coach-a',
      label: 'Clinic',
      revoked: false,
      intended_email: null,
    });
    const now = new Date('2026-03-09T16:00:00Z'); // 12:00 in New York
    const at = (iso: string, code: string, pkg: string | null) =>
      redemptions.push({
        coach_id: 'coach-a',
        code,
        package_id: pkg,
        invite_code_id: code === 'GP-CLN234' ? 'ic-1' : null,
        redeemed_at: new Date(iso),
      });
    at('2026-03-08T04:30:00Z', 'GP-CLN234', 'pkg-1'); // 03-07 23:30 local
    at('2026-03-08T05:30:00Z', 'GP-CLN234', 'pkg-1'); // 03-08 00:30 local (DST day)
    at('2026-03-09T03:59:00Z', 'GP-LNK234', null); // 03-08 23:59 local
    at('2026-03-09T15:00:00Z', 'GP-CLN234', 'pkg-1'); // 03-09 local
    at('2026-03-09T17:00:00Z', 'GP-CLN234', 'pkg-1'); // future relative to now: excluded
    redemptions.push({
      coach_id: 'coach-b',
      code: 'GP-CLN234',
      package_id: null,
      redeemed_at: new Date('2026-03-09T15:00:00Z'),
    });

    const out = await tools.signups('coach-a', 3, now);
    expect(out).toMatchObject({
      timezone: 'America/New_York',
      timezone_source: 'profile',
      from: '2026-03-07',
      to: '2026-03-09',
      total: 4,
      today: 1,
    });
    expect(out.days).toEqual([
      { date: '2026-03-07', count: 1 },
      { date: '2026-03-08', count: 2 },
      { date: '2026-03-09', count: 1 },
    ]);
    const clinic = out.by_code.find((c) => c.code === 'GP-CLN234');
    const link = out.by_code.find((c) => c.code === 'GP-LNK234');
    expect(clinic).toMatchObject({ id: 'ic-1', label: 'Clinic', total: 3 });
    expect(clinic?.days.map((d) => d.count)).toEqual([1, 1, 1]);
    expect(link).toMatchObject({ id: COACH_LINK_ID, kind: 'coach_link', total: 1 });
    expect(out.by_package).toEqual([
      expect.objectContaining({ package_id: 'pkg-1', package_name: 'Clinic 12 weeks', total: 3 }),
      expect.objectContaining({ package_id: null, package_name: null, total: 1 }),
    ]);
    // Sum of every breakdown equals the total row count in the window.
    expect(out.by_code.reduce((a, c) => a + c.total, 0)).toBe(out.total);
    expect(out.by_package.reduce((a, c) => a + c.total, 0)).toBe(out.total);
  });

  it('falls back to the platform zone when the profile zone is missing or invalid', async () => {
    const { tools, profiles } = build();
    profiles.push({
      id: 'cp',
      user_id: 'coach-a',
      invite_code: 'GP-LNK234',
      timezone: 'Mars/Olympus',
      created_at: new Date(),
    });
    const out = await tools.signups('coach-a', 7, new Date('2026-03-09T16:00:00Z'));
    expect(out).toMatchObject({
      timezone: 'America/Los_Angeles',
      timezone_source: 'default',
      total: 0,
    });
    expect(out.days).toHaveLength(7);
    expect(out.by_code).toEqual([expect.objectContaining({ code: 'GP-LNK234', total: 0 })]);
  });
});

describe('fix round 1 (agent 120): team attribution, atomic binding, coach link retries', () => {
  const sub1 = { id: 'sub-1', role: 'coach', email: null };
  const sub2 = { id: 'sub-2', role: 'coach', email: null };
  const team = () => {
    const t = build();
    for (const id of ['sub-1', 'sub-2'])
      t.seats.push({ head_coach_id: 'coach-a', sub_coach_id: id, archived_at: null });
    return t;
  };
  const ids = async (t: ReturnType<typeof build>, who: string) =>
    (await t.tools.list(who)).codes.filter((c) => c.kind === 'invite_code').map((c) => c.id);

  it('B-658-1: a sub-coach code lives in the head tenant, scoped to its issuer', async () => {
    const t = team();
    const { code } = await t.tools.create(sub1, { package_id: 'pkg-1', grant_mode: 'free' }, null);
    expect(t.codes[0]).toMatchObject({
      coach_id: 'coach-a',
      invited_by_user_id: 'sub-1',
      package_id: 'pkg-1', // the head coach's package
    });
    expect(code.issued_by_user_id).toBe('sub-1');
    expect(t.teamAudit).toEqual([
      expect.objectContaining({ head_coach_id: 'coach-a', actor_user_id: 'sub-1' }),
    ]);
    expect(await ids(t, 'coach-a')).toEqual([code.id]);
    expect((await t.tools.list('sub-1')).codes.map((c) => c.id)).toEqual([code.id]); // no link
    expect(await ids(t, 'sub-2')).toEqual([]);
    for (const p of [t.tools.rotate(sub2, code.id, 0), t.tools.revoke(sub2, code.id)])
      expect(await errCode(p)).toEqual({ status: 404, code: 'code_not_found' });
    const next = await t.tools.rotate(sub1, code.id, 0);
    expect(t.codes.find((c) => c.id === next.code.id)).toMatchObject({
      coach_id: 'coach-a',
      invited_by_user_id: 'sub-1',
    });
    expect((await t.tools.revoke(coachA, next.code.id)).code.status).toBe('revoked');
    t.redemptions.push(
      { coach_id: 'coach-a', code: code.code, invite_code_id: code.id, redeemed_at: new Date() },
      { coach_id: 'coach-a', code: 'GP-LNK234', invite_code_id: null, redeemed_at: new Date() },
    );
    expect((await t.tools.signups('sub-1', 7)).total).toBe(1);
    expect((await t.tools.signups('coach-a', 7)).total).toBe(2);
    expect(await errCode(t.tools.rotate(sub1, COACH_LINK_ID, 0, {}, 'GP-LNK234'))).toEqual({
      status: 403,
      code: 'coach_link_head_coach_only',
    });
  });

  const gated = () => {
    let release: (ok: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((r) => (release = r));
    const decide = async () => {
      if (!(await gate)) throw new NotFoundException({ error: 'PACKAGE_NOT_FOUND' });
      return 'pkg-1';
    };
    // setBinding = the pre-fix path; assertBindablePackage = the fixed path.
    const t = build({
      grants: { setBinding: jest.fn(decide), assertBindablePackage: jest.fn(decide) },
    });
    const input = { package_id: 'pkg-1', grant_mode: 'prepaid' as const };
    const first = t.tools.create(coachA, input, 'bind-key-0001');
    return { t, input, first, release: (ok: boolean) => release(ok) };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it('B-658-6: while the package is undecided no caller sees the code; a refusal leaves nothing', async () => {
    const { t, input, first, release } = gated();
    await tick();
    expect(await ids(t, 'coach-a')).toEqual([]);
    const retry = t.tools.create(coachA, input, 'bind-key-0001');
    await tick();
    release(false);
    expect(await errCode(first)).toEqual({ status: 404, code: 'package_not_found' });
    expect(await errCode(retry)).toEqual({ status: 404, code: 'package_not_found' });
    expect(t.codes).toHaveLength(0);
  });

  it('B-658-6: an overlapping retry gets the same, fully bound code', async () => {
    const { t, input, first, release } = gated();
    await tick();
    const retry = t.tools.create(coachA, input, 'bind-key-0001');
    await tick();
    release(true);
    const [a, b] = await Promise.all([first, retry]);
    expect(b.code.id).toBe(a.code.id);
    for (const r of [a, b])
      expect(r.code).toMatchObject({ package: { id: 'pkg-1' }, grant_mode: 'prepaid' });
    expect(t.codes).toHaveLength(1);
  });

  it('C-658-5: a malformed Idempotency-Key is refused, not ignored', async () => {
    const { tools, codes } = build();
    expect(await errCode(tools.create(coachA, {}, 'short'))).toEqual({
      status: 400,
      code: 'idempotency_key_invalid',
    });
    expect(codes).toHaveLength(0);
  });

  it('B-658-7: a retried coach link rotation returns the first successor and changes nothing', async () => {
    const t = build();
    t.profiles.push({
      id: 'cp',
      user_id: 'coach-a',
      invite_code: 'GP-OLD234',
      created_at: new Date(),
    });
    const first = await t.tools.rotate(coachA, COACH_LINK_ID, 0, {}, 'GP-OLD234');
    const retry = await t.tools.rotate(coachA, COACH_LINK_ID, 0, {}, 'GP-OLD234');
    expect(first.replayed).toBe(false);
    expect(retry).toMatchObject({
      replayed: true,
      code: { kind: 'coach_link', code: first.code.code },
    });
    expect(t.profiles[0].invite_code).toBe(first.code.code);
    expect(t.codes.map((c) => c.code)).toEqual(['GP-OLD234']);
    // An intentional rotation of the link now on screen still works (grace 24h).
    const second = await t.tools.rotate(coachA, COACH_LINK_ID, 24, {}, first.code.code);
    expect(second.replayed).toBe(false);
    expect(second.previous).toMatchObject({ code: first.code.code, status: 'retiring' });
    // A late retry of the first rotation returns that first successor as it stands now.
    const late = await t.tools.rotate(coachA, COACH_LINK_ID, 0, {}, 'GP-OLD234');
    expect(late).toMatchObject({
      replayed: true,
      code: { code: first.code.code, status: 'retiring' },
    });
    expect(t.profiles[0].invite_code).toBe(second.code.code);
    expect(await errCode(t.tools.rotate(coachA, COACH_LINK_ID, 0))).toEqual({
      status: 400,
      code: 'expected_code_required',
    });
  });
});
