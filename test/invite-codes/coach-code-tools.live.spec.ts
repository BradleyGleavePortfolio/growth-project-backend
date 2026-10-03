/**
 * A2 coach code tools — live proof on a database migrated with the real
 * chain (`prisma migrate deploy`, CI job community-live-tests), including
 * 20270302000000_coach_code_tools:
 *
 *  - exact counts: every NEW attach writes one InviteRedemption row; the
 *    signups breakdown equals `SELECT code, count(*) ... GROUP BY code`;
 *  - rotation never breaks a client's coach link; the old code answers
 *    code_revoked to a new signup, and a revoked code too;
 *  - tenancy: another coach cannot rotate or revoke the code (404) and the
 *    ledger RLS (as the non-BYPASSRLS `authenticated` / `anon` roles) shows a
 *    coach only their own rows, a client none, anon none, and refuses every
 *    non-service write.
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged reason
 * when unset; never a silent pass). The CI job sets it.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { InviteCodesService } from '../../src/invite-codes/invite-codes.service';
import { CoachCodeToolsService } from '../../src/invite-codes/coach-code-tools.service';

const url = process.env.COMMUNITY_TEST_DATABASE_URL;
const itLive = url ? describe : describe.skip;
if (!url) {
  // eslint-disable-next-line no-console
  console.warn('[coach-code-tools.live] COMMUNITY_TEST_DATABASE_URL not set — live spec skipped.');
}

itLive('A2 coach code tools on the real migration (live DB)', () => {
  let prisma: PrismaClient;
  let invites: InviteCodesService;
  let tools: CoachCodeToolsService;
  const tag = randomUUID()
    .slice(0, 6)
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, 'X');
  const id = {
    coachA: randomUUID(),
    coachB: randomUUID(),
    s1: randomUUID(),
    s2: randomUUID(),
    s3: randomUUID(),
    late: randomUUID(),
  };
  const linkCode = `GP-L${tag}`.slice(0, 12);
  const A = { id: id.coachA, role: 'coach', email: null };
  const B = { id: id.coachB, role: 'coach', email: null };

  async function as<T>(
    role: 'authenticated' | 'anon',
    userId: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      if (userId) {
        await tx.$queryRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
        await tx.$queryRaw`SELECT set_config('app.current_user_role', 'coach', true)`;
      }
      return fn(tx);
    });
  }
  const visible = (role: 'authenticated' | 'anon', userId: string | null) =>
    as(role, userId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM "InviteRedemption" WHERE coach_id = ${id.coachA}`;
      return Number(rows[0].n);
    });

  async function attachErr(userId: string, code: string): Promise<string | null> {
    try {
      await invites.attachUserToCoachByCode(userId, code);
      return null;
    } catch (e) {
      const body = (e as { getResponse?: () => { code?: string } }).getResponse?.();
      return body?.code ?? 'unknown';
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: url as string } } });
    await prisma.$connect();
    // Supabase grants table privileges by default; the bare CI Postgres does
    // not. Grant broadly so RLS (not a missing GRANT) is what decides.
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO authenticated, anon');
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "InviteRedemption" TO authenticated, anon',
    );

    const users: Array<[string, Role]> = [
      [id.coachA, 'coach'],
      [id.coachB, 'coach'],
      [id.s1, 'student'],
      [id.s2, 'student'],
      [id.s3, 'student'],
      [id.late, 'student'],
    ];
    for (const [uid, role] of users) {
      await prisma.user.create({
        data: {
          id: uid,
          supabase_id: `a2-live-${uid}`,
          email: `a2-live-${uid}@example.test`,
          role,
          name: `A2 ${role}`,
        },
      });
    }
    for (const c of [id.coachA, id.coachB]) {
      await prisma.coachSubscription.create({ data: { coach_id: c, status: 'active' } });
    }
    await prisma.coachProfile.create({
      data: { user_id: id.coachA, invite_code: linkCode, timezone: 'America/New_York' },
    });

    const svcPrisma: any = prisma;
    const stub: any = {
      capture: jest.fn(),
      identify: jest.fn(),
      send: jest.fn(),
      write: jest.fn(async () => undefined),
    };
    invites = new InviteCodesService(svcPrisma, stub, stub, stub);
    tools = new CoachCodeToolsService(svcPrisma, invites, stub);
  });

  afterAll(async () => {
    if (!prisma) return;
    const coaches = [id.coachA, id.coachB];
    await prisma.inviteRedemption.deleteMany({ where: { coach_id: { in: coaches } } });
    await prisma.inviteCode.updateMany({
      where: { coach_id: { in: coaches } },
      data: { rotated_from_id: null },
    });
    await prisma.inviteCode.deleteMany({ where: { coach_id: { in: coaches } } });
    await prisma.coachProfile.deleteMany({ where: { user_id: { in: coaches } } });
    await prisma.coachSubscription.deleteMany({ where: { coach_id: { in: coaches } } });
    await prisma.user.updateMany({
      where: { id: { in: Object.values(id) } },
      data: { coach_id: null },
    });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(id) } } });
    await prisma.$disconnect();
  });

  let clinicId = '';
  let clinicCode = '';

  it('every new attach writes exactly one ledger row; counts equal the database', async () => {
    const { code } = await tools.create(A, { label: 'Clinic' }, `a2-live-${tag}`);
    clinicId = code.id;
    clinicCode = code.code;
    await invites.attachUserToCoachByCode(id.s1, clinicCode);
    await invites.attachUserToCoachByCode(id.s2, clinicCode);
    await invites.attachUserToCoachByCode(id.s3, linkCode);
    await invites.attachUserToCoachByCode(id.s1, clinicCode); // replay: no row

    const db = await prisma.$queryRaw<Array<{ code: string; n: bigint }>>`
      SELECT code, count(*)::bigint AS n FROM "InviteRedemption" WHERE coach_id = ${id.coachA} GROUP BY code`;
    const fromDb = Object.fromEntries(db.map((r) => [r.code, Number(r.n)]));
    expect(fromDb).toEqual({ [clinicCode]: 2, [linkCode]: 1 });

    const out = await tools.signups(id.coachA, 7);
    expect(out.timezone).toBe('America/New_York');
    expect(out.total).toBe(3);
    const byCode = Object.fromEntries(
      out.by_code.filter((c) => c.total > 0).map((c) => [c.code, c.total]),
    );
    expect(byCode).toEqual(fromDb);
    const list = await tools.list(id.coachA);
    expect(list.codes.find((c) => c.id === clinicId)).toMatchObject({
      signups_total: 2,
      used_count: 2,
    });
  });

  it('rotation keeps every attached client on the coach; the old code answers code_revoked', async () => {
    const rotated = await tools.rotate(A, clinicId, 0);
    expect(rotated.previous?.status).toBe('revoked');
    const coaches = await prisma.user.findMany({
      where: { id: { in: [id.s1, id.s2, id.s3] } },
      select: { coach_id: true },
    });
    expect(coaches.every((u) => u.coach_id === id.coachA)).toBe(true);
    expect(await attachErr(id.late, clinicCode)).toBe('code_revoked');
    expect(await attachErr(id.s1, clinicCode)).toBeNull(); // replay by an attached client stays a success

    await tools.revoke(A, rotated.code.id);
    expect(await attachErr(id.late, rotated.code.code)).toBe('code_revoked');
  });

  it("another coach cannot rotate or revoke this coach's code", async () => {
    await expect(tools.rotate(B, clinicId, 0)).rejects.toMatchObject({
      response: { code: 'code_not_found' },
    });
    await expect(tools.revoke(B, clinicId)).rejects.toMatchObject({
      response: { code: 'code_not_found' },
    });
    const { codes } = await tools.list(id.coachB);
    expect(codes.map((c) => c.code)).not.toContain(clinicCode);
  });

  it('ledger RLS: the coach sees own rows; another coach, the client and anon see none', async () => {
    expect(await visible('authenticated', id.coachA)).toBe(3);
    expect(await visible('authenticated', id.coachB)).toBe(0);
    expect(await visible('authenticated', id.s1)).toBe(0);
    // anon: the RESTRICTIVE deny-all leaves nothing, or the role is refused
    // before any row is read; either way it never sees a row.
    const anon = await visible('anon', null).then(
      (n) => n,
      (e: unknown) => (/permission denied|42501/.test(String(e)) ? 0 : -1),
    );
    expect(anon).toBe(0);
  });

  it('ledger RLS: no non-service role can write, edit or delete a row', async () => {
    await expect(
      as(
        'authenticated',
        id.coachA,
        (tx) =>
          tx.$executeRaw`INSERT INTO "InviteRedemption" (id, coach_id, client_user_id, code, source)
          VALUES (${randomUUID()}, ${id.coachA}, ${id.late}, 'GP-FAKE22', 'invite_code')`,
      ),
    ).rejects.toThrow(/42501|row-level security/);
    const edited = await as(
      'authenticated',
      id.coachA,
      (tx) =>
        tx.$executeRaw`UPDATE "InviteRedemption" SET code = 'GP-EDIT22' WHERE coach_id = ${id.coachA}`,
    );
    expect(edited).toBe(0);
    const removed = await as(
      'authenticated',
      id.coachA,
      (tx) => tx.$executeRaw`DELETE FROM "InviteRedemption" WHERE coach_id = ${id.coachA}`,
    );
    expect(removed).toBe(0);
    expect(await prisma.inviteRedemption.count({ where: { coach_id: id.coachA } })).toBe(3);
  });
});
