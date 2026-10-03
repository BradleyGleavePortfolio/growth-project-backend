/**
 * Fix round B607-3 — live RLS for the clinic onboarding intake tables, and
 * API/RLS audience parity for the coach consultation read.
 *
 * Runs in the rls-live-tests CI job against a real Postgres 15 with the
 * onboarding migration applied VERBATIM (see .github/workflows/ci.yml and
 * scripts/ci/onboarding-intake-live-*.sql). Every RLS assertion executes as
 * the non-bypass `authenticated` (or `anon`) role with the app.* GUCs the
 * RlsContextInterceptor sets in production; fixtures are written by the
 * privileged connection (the server path), exactly as the API writes them.
 *
 * Skip modes mirror test/rls/helper-functions.spec.ts:
 *   - no DB URL configured              -> describe.skip
 *   - DB URL configured but unreachable -> beforeAll throws (HARD FAIL)
 *
 * Parity: for every (reader, client) pair in the matrix, and again after each
 * tenancy change (transfer, sub-coach moved, assignment revoked, soft
 * delete), OnboardingService.canCoachRead (the API rule, run through a real
 * PrismaClient on this same database) must equal what RLS lets that reader
 * SELECT from BOTH ClientOnboardingIntake and ClientOnboardingIntakeRevision.
 * The platform owner (app role 'owner') is the one documented difference:
 * RLS admits it everywhere through app.is_owner() (support / owner
 * reporting), while the coach API only serves the client's coach audience.
 *
 * INT-607-1 (phantom chain): team membership is main's explicit rule (#597
 * C13 Opus A1). A coach is on head H's team only with role 'coach',
 * coach_id = H and an active TeamSubCoachAssignment(H, coach) or an open
 * SubCoachAssignment(H, coach); a bare coach_id stamped by an old guest
 * checkout is not membership. The SQL twin app.sub_coach_membership_head must
 * equal main's SubCoachScopeService.getHeadCoachIdForSubCoach (run here
 * through a real PrismaClient on this same database) for every fixture user
 * in every state.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { OnboardingService } from '../../src/onboarding/onboarding.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import type { PrismaService } from '../../src/prisma.service';
import type { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('postgresql://test:test@')
    ? process.env.DATABASE_URL
    : '');

const dbAvailable = Boolean(DB_URL);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}
function asBuilder(m: object): WorkoutBuilderService {
  return m as WorkoutBuilderService;
}

const P = 'onbrls-';
const HEAD_A = `${P}head-a`;
const HEAD_B = `${P}head-b`;
const COACH_A2 = `${P}coach-a2`; // Team Mode member of head A who owns a roster
const SUB_A = `${P}sub-a`;
const SUB_B = `${P}sub-b`;
const FOREIGN = `${P}foreign`;
const OWNER = `${P}platform-owner`;
const CLIENT1 = `${P}client-1`; // coach = HEAD_A, sub SUB_A assigned by HEAD_A
const CLIENT2 = `${P}client-2`; // coach = COACH_A2 (head A)
const CLIENT3 = `${P}client-3`; // coach = HEAD_B, STALE assignment SUB_A by HEAD_A
const OTHER = `${P}other-client`;
// INT-607-1 phantom chain. SELLER sold a package to BUYER (a self-serve coach)
// through an old guest checkout that stamped BUYER.coach_id = SELLER with NO
// membership row. SELLER_SUB is SELLER's real Team Mode member and holds a
// stale open assignment from SELLER on BUYER's client.
const SELLER = `${P}seller`; // phantom head
const BUYER = `${P}buyer`; // phantom sub-coach (bare coach_id)
const SELLER_SUB = `${P}seller-sub`;
const CLIENT4 = `${P}client-4`; // coach = BUYER
// A real head whose own row also carries a stamped coach_id = SELLER (no
// membership): main treats it as the head of its own team.
const TAGGED = `${P}tagged`;
const TAGGED_SUB = `${P}tagged-sub`; // Team Mode member of TAGGED
const CLIENT5 = `${P}client-5`; // coach = TAGGED_SUB

const USERS: Array<[string, string, string | null]> = [
  [HEAD_A, 'coach', null],
  [HEAD_B, 'coach', null],
  [FOREIGN, 'coach', null],
  [OWNER, 'owner', null],
  [COACH_A2, 'coach', HEAD_A],
  [SUB_A, 'coach', HEAD_A],
  [SUB_B, 'coach', HEAD_B],
  [CLIENT1, 'student', HEAD_A],
  [CLIENT2, 'student', COACH_A2],
  [CLIENT3, 'student', HEAD_B],
  [OTHER, 'student', HEAD_A],
  [SELLER, 'coach', null],
  [BUYER, 'coach', SELLER],
  [SELLER_SUB, 'coach', SELLER],
  [CLIENT4, 'student', BUYER],
  [TAGGED, 'coach', SELLER],
  [TAGGED_SUB, 'coach', TAGGED],
  [CLIENT5, 'student', TAGGED_SUB],
];
// Explicit Team Mode seats (head, sub). BUYER and TAGGED deliberately have none.
const SEATS: Array<[string, string, string]> = [
  [`${P}seat-a2`, HEAD_A, COACH_A2],
  [`${P}seat-seller-sub`, SELLER, SELLER_SUB],
  [`${P}seat-tagged-sub`, TAGGED, TAGGED_SUB],
];
const CLIENTS = [CLIENT1, CLIENT2, CLIENT3, CLIENT4, CLIENT5];
const READERS = [
  HEAD_A,
  HEAD_B,
  COACH_A2,
  SUB_A,
  SUB_B,
  FOREIGN,
  OTHER,
  SELLER,
  BUYER,
  SELLER_SUB,
  TAGGED,
  TAGGED_SUB,
];
const ROLE_OF: Record<string, string> = Object.fromEntries(USERS.map(([id, r]) => [id, r]));

type Table = 'ClientOnboardingIntake' | 'ClientOnboardingIntakeRevision';

(dbAvailable ? describe : describe.skip)('clinic onboarding intake RLS (live DB)', () => {
  let prisma: PrismaClient;
  let svc: OnboardingService;
  let scope: SubCoachScopeService;

  /** Run `fn` as a non-bypass DB role with the production RLS GUCs. */
  async function as<T>(
    reader: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    dbRole: 'authenticated' | 'anon' = 'authenticated',
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${dbRole}`);
      if (reader) {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          ROLE_OF[reader] ?? 'student',
        );
      }
      return fn(tx);
    });
  }

  async function rlsSees(reader: string, table: Table, clientId: string): Promise<boolean> {
    return as(reader, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE client_id = $1`,
        clientId,
      );
      return Number(rows[0].n) > 0;
    });
  }

  async function expectParity(expected: Record<string, string[]>) {
    for (const client of CLIENTS) {
      for (const reader of READERS) {
        if (reader === client) continue;
        const want = (expected[client] ?? []).includes(reader);
        const api = await svc.canCoachRead(reader, client);
        const intake = await rlsSees(reader, 'ClientOnboardingIntake', client);
        const rev = await rlsSees(reader, 'ClientOnboardingIntakeRevision', client);
        expect({ reader, client, api, intake, rev }).toEqual({
          reader,
          client,
          api: want,
          intake: want,
          rev: want,
        });
      }
    }
  }

  async function exec(sql: string, ...args: unknown[]) {
    await prisma.$executeRawUnsafe(sql, ...args);
  }

  async function cleanup() {
    const ids = USERS.map(([id]) => id);
    await exec(
      `DELETE FROM "ClientOnboardingIntakeRevision" WHERE client_id = ANY($1::text[])`,
      ids,
    );
    await exec(`DELETE FROM "ClientOnboardingIntake" WHERE client_id = ANY($1::text[])`, ids);
    await exec(`DELETE FROM "SubCoachAssignment" WHERE client_id = ANY($1::text[])`, ids);
    await exec(
      `DELETE FROM "TeamSubCoachAssignment" WHERE head_coach_id = ANY($1::text[]) OR sub_coach_id = ANY($1::text[])`,
      ids,
    );
    await exec(`UPDATE "User" SET coach_id = NULL WHERE id = ANY($1::text[])`, ids);
    await exec(`DELETE FROM "User" WHERE id = ANY($1::text[])`, ids);
  }

  async function seed() {
    await cleanup();
    for (const [id, role] of USERS) {
      await exec(`INSERT INTO "User" (id, role) VALUES ($1, $2)`, id, role);
    }
    for (const [id, , coach] of USERS) {
      if (coach) await exec(`UPDATE "User" SET coach_id = $1 WHERE id = $2`, coach, id);
    }
    await exec(
      `INSERT INTO "SubCoachAssignment" (id, head_coach_id, sub_coach_id, client_id) VALUES
         ($1, $2, $3, $4), ($5, $2, $3, $6), ($7, $8, $9, $4)`,
      `${P}sca-1`,
      HEAD_A,
      SUB_A,
      CLIENT1,
      `${P}sca-stale`,
      CLIENT3,
      `${P}sca-cross`,
      HEAD_B,
      SUB_B,
    );
    // The stale assignment written while the old scope trusted the phantom.
    await exec(
      `INSERT INTO "SubCoachAssignment" (id, head_coach_id, sub_coach_id, client_id) VALUES ($1, $2, $3, $4)`,
      `${P}sca-phantom`,
      SELLER,
      SELLER_SUB,
      CLIENT4,
    );
    for (const [id, head, sub] of SEATS) {
      await exec(
        `INSERT INTO "TeamSubCoachAssignment" (id, head_coach_id, sub_coach_id) VALUES ($1, $2, $3)`,
        id,
        head,
        sub,
      );
    }
    for (const c of CLIENTS) {
      await exec(
        `INSERT INTO "ClientOnboardingIntake" (id, client_id, version, answers, current_revision, updated_at)
         VALUES ($1, $2, 'consult-v1', '{"P1":"yes","P1_note":"synthetic"}'::jsonb, 1, now())`,
        `${c}-intake`,
        c,
      );
      await exec(
        `INSERT INTO "ClientOnboardingIntakeRevision" (id, intake_id, client_id, revision, version, answers, cause)
         VALUES ($1, $2, $3, 1, 'consult-v1', '{"P1":"yes"}'::jsonb, 'save')`,
        `${c}-rev-1`,
        `${c}-intake`,
        c,
      );
    }
  }

  // The consultation's current-tenancy coach audience.
  const BASELINE: Record<string, string[]> = {
    [CLIENT1]: [HEAD_A, SUB_A],
    [CLIENT2]: [COACH_A2, HEAD_A],
    [CLIENT3]: [HEAD_B],
    // INT-607-1: only the buyer coach; never SELLER or SELLER_SUB.
    [CLIENT4]: [BUYER],
    [CLIENT5]: [TAGGED_SUB, TAGGED],
  };

  async function sqlMembershipHead(userId: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<Array<{ h: string | null }>>(
      `SELECT app.sub_coach_membership_head($1) AS h`,
      userId,
    );
    return rows[0].h;
  }

  /** SQL twin == main's SubCoachScopeService for every fixture user. */
  async function expectMembershipParity() {
    for (const [id] of USERS) {
      const sql = await sqlMembershipHead(id);
      const main = await scope.getHeadCoachIdForSubCoach(id);
      expect({ id, sql }).toEqual({ id, sql: main });
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch (err) {
      throw new Error(
        `[B607-3] DATABASE_URL/TEST_DATABASE_URL is set but unreachable. Refusing to skip. ${errorMessage(err)}`,
      );
    }
    // No scope injected: the service builds main's SubCoachScopeService over
    // the same client, exactly like the production fallback.
    svc = new OnboardingService(asPrisma(prisma), asBuilder({}));
    scope = new SubCoachScopeService(asPrisma(prisma));
  });

  beforeEach(seed);

  afterAll(async () => {
    if (prisma) {
      try {
        await cleanup();
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  it('RLS is enabled and forced on both intake tables, with the audience helper pinned', async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ relname: string; on: boolean; forced: boolean }>
    >(
      `SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
        WHERE relname IN ('ClientOnboardingIntake', 'ClientOnboardingIntakeRevision', 'ClinicProgramSet')
        ORDER BY relname`,
    );
    expect(rows).toHaveLength(3);
    rows.forEach((r) => expect(r).toMatchObject({ on: true, forced: true }));
    const fn = await prisma.$queryRawUnsafe<
      Array<{ name: string; secdef: boolean; cfg: string[] | null }>
    >(
      `SELECT p.proname AS name, p.prosecdef AS secdef, p.proconfig AS cfg FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('can_read_client_consultation', 'sub_coach_membership_head')
        ORDER BY p.proname`,
    );
    expect(fn.map((f) => f.name)).toEqual([
      'can_read_client_consultation',
      'sub_coach_membership_head',
    ]);
    for (const f of fn) {
      expect(f.secdef).toBe(true);
      expect((f.cfg ?? []).join(',')).toMatch(/search_path=/);
    }
  });

  it('INT-607-1: the membership helper is internal (authenticated and anon cannot EXECUTE it)', async () => {
    for (const dbRole of ['authenticated', 'anon'] as const) {
      await expect(
        as(
          CLIENT1,
          (tx) => tx.$queryRawUnsafe(`SELECT app.sub_coach_membership_head($1) AS h`, SUB_A),
          dbRole,
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("INT-607-1: app.sub_coach_membership_head == main's SubCoachScopeService in every state", async () => {
    // Baseline values, spelled out: seats and delegations are membership,
    // a bare coach_id is not.
    expect(await sqlMembershipHead(COACH_A2)).toBe(HEAD_A); // Team Mode seat
    expect(await sqlMembershipHead(SUB_A)).toBe(HEAD_A); // open delegation
    expect(await sqlMembershipHead(SELLER_SUB)).toBe(SELLER);
    expect(await sqlMembershipHead(BUYER)).toBeNull(); // phantom
    expect(await sqlMembershipHead(TAGGED)).toBeNull(); // stamped head
    expect(await sqlMembershipHead(HEAD_A)).toBeNull();
    expect(await sqlMembershipHead(CLIENT1)).toBeNull();
    await expectMembershipParity();
    // Archived seat, revoked delegations, an explicit seat for the phantom,
    // and a sub_coach-role row (main counts only role 'coach').
    await exec(
      `UPDATE "TeamSubCoachAssignment" SET archived_at = now() WHERE id = $1`,
      `${P}seat-a2`,
    );
    await exec(
      `UPDATE "SubCoachAssignment" SET unassigned_at = now() WHERE sub_coach_id = $1`,
      SUB_A,
    );
    await exec(
      `INSERT INTO "TeamSubCoachAssignment" (id, head_coach_id, sub_coach_id) VALUES ($1, $2, $3)`,
      `${P}seat-buyer`,
      SELLER,
      BUYER,
    );
    await exec(`UPDATE "User" SET role = 'sub_coach' WHERE id = $1`, SUB_B);
    expect(await sqlMembershipHead(COACH_A2)).toBeNull();
    expect(await sqlMembershipHead(SUB_A)).toBeNull();
    expect(await sqlMembershipHead(BUYER)).toBe(SELLER);
    expect(await sqlMembershipHead(SUB_B)).toBeNull();
    await expectMembershipParity();
  });

  it('INT-607-1: the phantom head and its real sub-coach read nothing of the buyer coach clients', async () => {
    for (const reader of [SELLER, SELLER_SUB]) {
      const api = await svc.canCoachRead(reader, CLIENT4);
      const intake = await rlsSees(reader, 'ClientOnboardingIntake', CLIENT4);
      const rev = await rlsSees(reader, 'ClientOnboardingIntakeRevision', CLIENT4);
      expect({ reader, api, intake, rev }).toEqual({
        reader,
        api: false,
        intake: false,
        rev: false,
      });
    }
    expect(await svc.canCoachRead(BUYER, CLIENT4)).toBe(true);
    expect(await rlsSees(BUYER, 'ClientOnboardingIntake', CLIENT4)).toBe(true);
    // The API itself answers 404 to the phantom head.
    await expect(svc.getCoachConsultation(SELLER, CLIENT4)).rejects.toMatchObject({ status: 404 });
  });

  it('INT-607-1: the phantom becomes a team member only with an explicit seat', async () => {
    await exec(
      `INSERT INTO "TeamSubCoachAssignment" (id, head_coach_id, sub_coach_id) VALUES ($1, $2, $3)`,
      `${P}seat-buyer`,
      SELLER,
      BUYER,
    );
    // SELLER is now BUYER's head; SELLER_SUB's assignment is from that head.
    await expectParity({ ...BASELINE, [CLIENT4]: [BUYER, SELLER, SELLER_SUB] });
  });

  it("INT-607-1: archiving a Team Mode seat removes the head's read in the same statement", async () => {
    await exec(
      `UPDATE "TeamSubCoachAssignment" SET archived_at = now() WHERE id = $1`,
      `${P}seat-a2`,
    );
    await expectParity({ ...BASELINE, [CLIENT2]: [COACH_A2] });
  });

  it("INT-607-1: a sub_coach-role row is not a team member (main's rule), on API and RLS alike", async () => {
    await exec(`UPDATE "User" SET role = 'sub_coach' WHERE id = $1`, SUB_A);
    await expectParity({ ...BASELINE, [CLIENT1]: [HEAD_A] });
  });

  it('baseline: API audience == RLS audience on intake AND revisions for every reader x client', async () => {
    await expectParity(BASELINE);
  });

  it('the client reads only their own rows; another client reads nothing', async () => {
    expect(await rlsSees(CLIENT1, 'ClientOnboardingIntake', CLIENT1)).toBe(true);
    expect(await rlsSees(CLIENT1, 'ClientOnboardingIntakeRevision', CLIENT1)).toBe(true);
    expect(await rlsSees(CLIENT1, 'ClientOnboardingIntake', CLIENT2)).toBe(false);
    expect(await rlsSees(OTHER, 'ClientOnboardingIntake', CLIENT1)).toBe(false);
    // The client is never the coach audience through the API either.
    expect(await svc.canCoachRead(CLIENT1, CLIENT1)).toBe(false);
  });

  it('A607-1: the stale cross-head assignment (SUB_A on CLIENT3, issued by head A) grants nothing', async () => {
    expect(await svc.canCoachRead(SUB_A, CLIENT3)).toBe(false);
    expect(await rlsSees(SUB_A, 'ClientOnboardingIntake', CLIENT3)).toBe(false);
    // A sub-coach of head B holding an assignment from head B for a head-A client is refused.
    expect(await svc.canCoachRead(SUB_B, CLIENT1)).toBe(false);
    expect(await rlsSees(SUB_B, 'ClientOnboardingIntake', CLIENT1)).toBe(false);
  });

  it('transfer: moving CLIENT1 to head B removes head A and SUB_A immediately, adds head B', async () => {
    await exec(`UPDATE "User" SET coach_id = $1 WHERE id = $2`, HEAD_B, CLIENT1);
    // SUB_B's assignment was issued by head B, which is now the current head.
    await expectParity({ ...BASELINE, [CLIENT1]: [HEAD_B, SUB_B] });
  });

  it('sub-coach moved to another team loses access although the assignment row is still open', async () => {
    await exec(`UPDATE "User" SET coach_id = $1 WHERE id = $2`, HEAD_B, SUB_A);
    await expectParity({ ...BASELINE, [CLIENT1]: [HEAD_A] });
  });

  it('revoked assignment loses access immediately', async () => {
    await exec(`UPDATE "SubCoachAssignment" SET unassigned_at = now() WHERE id = $1`, `${P}sca-1`);
    await expectParity({ ...BASELINE, [CLIENT1]: [HEAD_A] });
  });

  it('soft-deleted client, coach or reader: no audience', async () => {
    await exec(`UPDATE "User" SET deleted_at = now() WHERE id = $1`, SUB_A);
    await exec(`UPDATE "User" SET deleted_at = now() WHERE id = $1`, COACH_A2);
    await exec(`UPDATE "User" SET deleted_at = now() WHERE id = $1`, CLIENT3);
    await expectParity({
      [CLIENT1]: [HEAD_A],
      [CLIENT2]: [],
      [CLIENT3]: [],
      [CLIENT4]: [BUYER],
      [CLIENT5]: [TAGGED_SUB, TAGGED],
    });
  });

  it('platform owner: RLS admits through app.is_owner(); the coach API does not (documented)', async () => {
    expect(await rlsSees(OWNER, 'ClientOnboardingIntake', CLIENT1)).toBe(true);
    expect(await svc.canCoachRead(OWNER, CLIENT1)).toBe(false);
  });

  it('anon is denied (RESTRICTIVE policy), with or without GUCs', async () => {
    // Denied means zero visible rows OR a permission error (anon cannot even
    // EXECUTE the app.* helpers); either way nothing is readable.
    const tryRead = async (reader: string | null): Promise<number | 'permission_denied'> => {
      try {
        return await as(
          reader,
          async (tx) => {
            const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
              `SELECT count(*)::int AS n FROM "ClientOnboardingIntake"`,
            );
            return Number(rows[0].n);
          },
          'anon',
        );
      } catch (err) {
        expect(errorMessage(err)).toMatch(/permission denied/i);
        return 'permission_denied';
      }
    };
    expect([0, 'permission_denied']).toContain(await tryRead(null));
    expect([0, 'permission_denied']).toContain(await tryRead(CLIENT1));
  });

  it('INSERT: client-self only; a coach cannot create or forge a client intake or revision', async () => {
    await exec(`DELETE FROM "ClientOnboardingIntakeRevision" WHERE client_id = $1`, CLIENT1);
    await exec(`DELETE FROM "ClientOnboardingIntake" WHERE client_id = $1`, CLIENT1);
    await expect(
      as(HEAD_A, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "ClientOnboardingIntake" (id, client_id, version, answers, updated_at)
           VALUES ($1, $2, 'consult-v1', '{}'::jsonb, now())`,
          `${P}forged`,
          CLIENT1,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      as(OTHER, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "ClientOnboardingIntake" (id, client_id, version, answers, updated_at)
           VALUES ($1, $2, 'consult-v1', '{}'::jsonb, now())`,
          `${P}forged-2`,
          CLIENT1,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      as(CLIENT1, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "ClientOnboardingIntake" (id, client_id, version, answers, updated_at)
           VALUES ($1, $2, 'consult-v1', '{}'::jsonb, now())`,
          `${CLIENT1}-intake`,
          CLIENT1,
        ),
      ),
    ).resolves.toBe(1);
    await expect(
      as(HEAD_A, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "ClientOnboardingIntakeRevision" (id, intake_id, client_id, revision, version, answers, cause)
           VALUES ($1, $2, $3, 9, 'consult-v1', '{}'::jsonb, 'save')`,
          `${P}forged-rev`,
          `${CLIENT2}-intake`,
          CLIENT2,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('UPDATE: coaches are read-only; a client cannot re-own its row', async () => {
    const coachUpdated = await as(HEAD_A, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "ClientOnboardingIntake" SET version = 'tampered' WHERE client_id = $1`,
        CLIENT1,
      ),
    );
    expect(coachUpdated).toBe(0);
    await expect(
      as(CLIENT1, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "ClientOnboardingIntake" SET client_id = $1 WHERE client_id = $2`,
          OTHER,
          CLIENT1,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('revisions are immutable for every non-service role: UPDATE and DELETE affect 0 rows', async () => {
    for (const reader of [CLIENT1, HEAD_A, SUB_A]) {
      const upd = await as(reader, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "ClientOnboardingIntakeRevision" SET cause = 'tampered' WHERE client_id = $1`,
          CLIENT1,
        ),
      );
      const del = await as(reader, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM "ClientOnboardingIntakeRevision" WHERE client_id = $1`,
          CLIENT1,
        ),
      );
      expect({ reader, upd, del }).toEqual({ reader, upd: 0, del: 0 });
    }
    const left = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "ClientOnboardingIntakeRevision" WHERE client_id = $1 AND cause = 'save'`,
      CLIENT1,
    );
    expect(Number(left[0].n)).toBe(1);
  });

  it('ClinicProgramSet has no public write path', async () => {
    await expect(
      as(HEAD_A, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "ClinicProgramSet" (id, coach_id, fixture_version, fixture_sha256, approval_status,
             workspace_id, all_members_cohort_id, programs, materialisation, updated_at)
           VALUES ($1, $2, 'v', 'x', 'draft', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, now())`,
          `${P}set`,
          HEAD_A,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
