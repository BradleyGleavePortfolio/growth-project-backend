/**
 * S8-D3 — person-owned schema: role × owner-state RLS matrix and constraint proofs
 * (docs/decisions/2026-09-26-s8d-person-link.md §2.1, §2.2 items 1-4, §2.5, §2.9; migrations
 * 20270125000000..20270125000010).
 *
 * Runs against a REAL PostgreSQL on which the FULL migration chain was deployed
 * (`prisma migrate deploy` after prisma/migrations/_supabase_bootstrap.sql) — the
 * `person-owned-rls-live-tests` CI job. No mocks; nothing here is asserted from the schema text.
 *
 * What it proves, one case per cell of the §2.2 item 4 matrix, both USING and WITH CHECK:
 *   A. Every non-owner policy branch on the eight tables denies a PERSON-OWNED row to every
 *      principal — including the Person's own coach, the row the T4 review found exposed
 *      (CheckIn.check_in_coach_select, ClientWorkoutAssignment.assignment_coach_manage).
 *   B. USER-owned rows keep today's behaviour for the client, the current coach and the owner.
 *      (ExerciseSet / HabitLog: the "current coach" branch is shadowed by the PARENT's RLS — the
 *      policy's EXISTS over WorkoutSession / Habit runs as the caller, and those parents' policies
 *      are owner-only, so the coach never sees the parent row. That is the pre-existing production
 *      posture (the parents' RLS came from the out-of-band file); S8-D3 states it in-tree and this
 *      matrix asserts it rather than the policy text's intent.)
 *   C. The owner role's stated exception: it reaches person-owned rows on ExerciseSet, HabitLog,
 *      CheckIn and the snapshot (existing FOR ALL owner branch, unchanged) and NOT on
 *      WorkoutSession, WeightLog, Habit (no owner branch exists).
 *   D. No non-bypass principal can flip a row to person-owned or insert a person-owned row
 *      (WITH CHECK), except the owner on CheckIn through its unchanged owner branch (stated).
 *   E. As service_role-equivalent (BYPASSRLS): the XOR CHECKs, the CheckIn coach CHECK, the
 *      composite tenant FK (a person-owned check-in naming another coach fails the FK, not a
 *      policy), the person-owned one-per-day partial unique, the PersonLink active uniques and the
 *      30-day undo CHECK; and that every S8-D3 constraint is VALIDATED (step 11 ran).
 *   F. The five new tables: RLS enabled + forced, service_role permissive + RESTRICTIVE deny-all
 *      policies present, API-role privileges revoked, and a direct authenticated read is refused.
 *
 * Harness notes (orchestrator decision 2026-09-29, fix round 1 of PR #587 — correctness fixes, not
 * weakening; every other assertion is unchanged):
 *   - Parent DELETE cells on WorkoutSession / Habit: the fixtures carry a child row (ExerciseSet /
 *     HabitLog) and both child FKs are ON DELETE RESTRICT (baseline migration), so an ADMITTED parent
 *     delete ends in 23503 instead of a row count and the cell cannot tell "policy admitted the row"
 *     from a refusal. Those cells first remove the child rows as the BYPASSRLS connection owner inside
 *     the same rolled-back transaction (before SET LOCAL ROLE), then run the DELETE as the principal:
 *     the cell measures the parent's DELETE policy alone. The child tables' own policies are measured
 *     in their own rows of the matrix.
 *   - 23505 assertions: Prisma surfaces PostgreSQL's DETAIL line for unique violations (the violated
 *     key columns and values), never the index name. The constraint is identified by its key columns
 *     AND by its definition read from pg_indexes, which is at least as strict as a name match.
 *
 * Principals are Postgres roles + the GUCs the helpers read (app.current_user_id /
 * app.current_user_role) and, for the auth.uid()-keyed assignment policies, request.jwt.claim.sub
 * (Supabase's classic auth.uid() reads that claim; the CI bootstrap stub returns NULL, so this spec
 * installs the claim-reading form on the disposable database — test environment only).
 *
 * D8 (owner decision 2026-09-29; migration 20270125000012, stacked on #587): `assignment_coach_manage`
 * now applies the application's coach-client tenancy rule (WorkoutBuilderService.assertCanAccessClient:
 * client.coach_id = caller, OR caller is a sub-coach with an OPEN SubCoachAssignment to that live
 * student) in BOTH USING and WITH CHECK, and re-keys the policy and both of its helpers on ONE
 * identity, the backend GUC app.current_user_id() (the identity every repo tenancy helper and the
 * other S8-D3 tenant policies use; the 20260702000000 auth.uid() keying was the outlier).
 * The block "D8 — coach-client tenancy" below proves the
 * positive paths (head coach, owner-as-coach, sub-coach with open delegation), the negative paths
 * (cross-tenant INSERT, UPDATE re-pointing client_id, SELECT, DELETE; closed delegation; non-student
 * target) and that the composed policy still never recurses (42P17). One pre-D8 assertion in the
 * 20270125000011 block flipped from allow to deny: coach B assigning their own plan to coach A's
 * client — that was the gap D8 closes.
 *
 * Connection: S8D3_RLS_TEST_DATABASE_URL > TEST_DATABASE_URL. Skipped when neither is set (the
 * default jest lane never selects this file); HARD-FAILS when set but unreachable.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const TEST_DB_URL = process.env.S8D3_RLS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || '';
const describeLive = TEST_DB_URL ? describe : describe.skip;

const SINGLE_CONN_URL = TEST_DB_URL.includes('connection_limit=')
  ? TEST_DB_URL
  : TEST_DB_URL + (TEST_DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const prisma = new PrismaClient({ datasources: { db: { url: SINGLE_CONN_URL } } });

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

class Rollback extends Error {}

type Principal = {
  label: string;
  role: 'anon' | 'authenticated';
  userId?: string;
  userRole?: 'student' | 'coach' | 'owner';
  supabaseId?: string;
};

type Outcome = { ok: true; count: number } | { ok: false; sqlstate: string; message: string };

function sqlstate(e: unknown): string {
  const err = e as { meta?: { code?: string }; message?: string; code?: string };
  if (err?.meta?.code) return String(err.meta.code);
  const m = /code:\s*"?([0-9A-Z]{5})"?/.exec(err?.message ?? '');
  if (m) return m[1];
  return String(err?.code ?? 'UNKNOWN');
}

/**
 * Run `stmt` as `p` inside ONE transaction and ALWAYS roll back. Returns the affected/visible row
 * count, or the SQLSTATE of the refusal. SET LOCAL ROLE + set_config(..., is_local) vanish with
 * the rollback, so every cell is independent and the fixtures are never mutated.
 */
async function attempt(
  p: Principal,
  stmt: string,
  mode: 'count' | 'exec' = 'exec',
  /** Run BEFORE `SET LOCAL ROLE`, as the BYPASSRLS connection owner, in the same rolled-back transaction. */
  bypassSetup: string[] = [],
): Promise<Outcome> {
  let out: Outcome = { ok: false, sqlstate: 'NORUN', message: 'did not run' };
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const s of bypassSetup) await tx.$executeRawUnsafe(s);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${p.role}`);
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', ${lit(p.userId ?? '')}, true)`,
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', ${lit(p.userRole ?? '')}, true)`,
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('request.jwt.claim.sub', ${lit(p.supabaseId ?? '')}, true)`,
        );
        try {
          if (mode === 'count') {
            const rows = (await tx.$queryRawUnsafe(stmt)) as Array<{ n: bigint | number }>;
            out = { ok: true, count: Number(rows[0]?.n ?? 0) };
          } else {
            out = { ok: true, count: await tx.$executeRawUnsafe(stmt) };
          }
        } catch (e) {
          out = {
            ok: false,
            sqlstate: sqlstate(e),
            message: String((e as Error).message).slice(0, 300),
          };
        }
        throw new Rollback();
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

async function asAdmin(stmt: string): Promise<Outcome> {
  let out: Outcome = { ok: false, sqlstate: 'NORUN', message: 'did not run' };
  try {
    await prisma.$transaction(
      async (tx) => {
        try {
          out = { ok: true, count: await tx.$executeRawUnsafe(stmt) };
        } catch (e) {
          out = {
            ok: false,
            sqlstate: sqlstate(e),
            message: String((e as Error).message).slice(0, 300),
          };
        }
        throw new Rollback();
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await prisma.$queryRawUnsafe(sql)) as T[];
}

// ─── Fixtures (synthetic; ids carry a run-unique prefix; removed in afterAll) ─────────────────
const RUN = `s8d3-${randomUUID().slice(0, 8)}`;
const id = (s: string) => `${RUN}-${s}`;

const users = {
  coachA: {
    id: id('coach-a'),
    supabase: randomUUID(),
    role: 'coach',
    coach_id: null as string | null,
  },
  coachB: {
    id: id('coach-b'),
    supabase: randomUUID(),
    role: 'coach',
    coach_id: null as string | null,
  },
  owner: {
    id: id('owner'),
    supabase: randomUUID(),
    role: 'owner',
    coach_id: null as string | null,
  },
  s1: { id: id('student-1'), supabase: randomUUID(), role: 'student', coach_id: id('coach-a') },
  s2: { id: id('student-2'), supabase: randomUUID(), role: 'student', coach_id: id('coach-a') },
  s3: { id: id('student-3'), supabase: randomUUID(), role: 'student', coach_id: id('coach-b') },
  // D8 fixtures. Sub-coach SC is on coach A's team (role coach, coach_id = A) exactly as
  // SubCoachScopeService defines a sub-coach; S4 is the owner user's own client (owner-as-coach).
  subCoach: {
    id: id('sub-coach'),
    supabase: randomUUID(),
    role: 'coach',
    coach_id: id('coach-a') as string | null,
  },
  s4: { id: id('student-4'), supabase: randomUUID(), role: 'student', coach_id: id('owner') },
};
const PERSON = id('person');
const PLAN = id('plan');
/** A plan owned by coach B: proves coach A cannot assign a plan that is not theirs. */
const PLAN_B = id('plan-b');
/** D8: a plan owned by the sub-coach, and one owned by the owner user. */
const PLAN_SC = id('plan-sc');
const PLAN_O = id('plan-o');
/** D8: SubCoachAssignment rows — SC -> S1 OPEN; SC -> S2 CLOSED (unassigned_at set). */
const SCA = { open: id('sca-open'), closed: id('sca-closed') };
const ROWS = {
  ws: { user: id('ws-user'), person: id('ws-person') },
  es: { user: id('es-user'), person: id('es-person') },
  wl: { user: id('wl-user'), person: id('wl-person') },
  habit: { user: id('habit-user'), person: id('habit-person') },
  hl: { user: id('hl-user'), person: id('hl-person') },
  ci: { user: id('ci-user'), person: id('ci-person') },
  cwa: {
    user: id('cwa-user'),
    person: id('cwa-person'),
    personBare: id('cwa-person-bare'),
    /** D8: assigned by the sub-coach (own plan) to S1, whom SC holds an open delegation for. */
    subOwn: id('cwa-sub-own'),
    /** D8: a pre-D8 cross-tenant row — assigned by coach B (own plan) to coach A's client S1. */
    crossTenant: id('cwa-cross-tenant'),
  },
  snap: { user: id('snap-user'), person: id('snap-person') },
};

const P: Record<string, Principal> = {
  anon: { label: 'anon (no principal)', role: 'anon' },
  s1: {
    label: 'the client (S1, coach A)',
    role: 'authenticated',
    userId: users.s1.id,
    userRole: 'student',
    supabaseId: users.s1.supabase,
  },
  s2: {
    label: 'same-coach other student (S2)',
    role: 'authenticated',
    userId: users.s2.id,
    userRole: 'student',
    supabaseId: users.s2.supabase,
  },
  s3: {
    label: 'unrelated student (S3, coach B)',
    role: 'authenticated',
    userId: users.s3.id,
    userRole: 'student',
    supabaseId: users.s3.supabase,
  },
  coachA: {
    label: "the Person's coach (A)",
    role: 'authenticated',
    userId: users.coachA.id,
    userRole: 'coach',
    supabaseId: users.coachA.supabase,
  },
  coachB: {
    label: 'a different coach (B)',
    role: 'authenticated',
    userId: users.coachB.id,
    userRole: 'coach',
    supabaseId: users.coachB.supabase,
  },
  owner: {
    label: 'owner role',
    role: 'authenticated',
    userId: users.owner.id,
    userRole: 'owner',
    supabaseId: users.owner.supabase,
  },
};

type Verb = 'select' | 'update' | 'delete';
type TableCase = {
  table: string;
  rows: { user: string; person: string };
  /** UPDATE statement fragment: SET ... (no WHERE). */
  set: string;
  /** Expected allow-set for the USER-owned row (today's behaviour), per verb. */
  userAllow: Record<Verb, string[]>;
  /** Expected allow-set for the PERSON-owned row, per verb (owner exception only). */
  personAllow: Record<Verb, string[]>;
  /** INSERT that creates a person-owned row (parents) or a child under the person-owned parent. */
  insertPersonOwned: string;
  /** Principals expected to be allowed that insert (owner exception only). */
  insertPersonAllow: string[];
  /**
   * Parents with ON DELETE RESTRICT children: removes the fixture child rows of `rowId`; run as the
   * BYPASSRLS owner before the principal's DELETE (see header) so the cell measures the parent policy.
   */
  childDelete?: (rowId: string) => string;
};

const NONE: string[] = [];
const OWNER = ['owner'];

const TABLES: TableCase[] = [
  {
    table: 'WorkoutSession',
    rows: ROWS.ws,
    set: `SET "notes" = 'x'`,
    userAllow: { select: ['s1'], update: ['s1'], delete: ['s1'] },
    personAllow: { select: NONE, update: NONE, delete: NONE },
    insertPersonOwned: `INSERT INTO public."WorkoutSession" ("id","person_id","date","workout_name","workout_type") VALUES (${lit(id('ws-new'))}, ${lit(PERSON)}, DATE '2024-01-03', 'w', 't')`,
    insertPersonAllow: NONE,
    childDelete: (rowId) => `DELETE FROM public."ExerciseSet" WHERE "workout_id" = ${lit(rowId)}`,
  },
  {
    table: 'ExerciseSet',
    rows: ROWS.es,
    set: `SET "notes" = 'x'`,
    // coach branch shadowed by WorkoutSession's owner-only policy (see header, B).
    userAllow: { select: ['s1', 'owner'], update: ['s1', 'owner'], delete: ['s1', 'owner'] },
    personAllow: { select: OWNER, update: OWNER, delete: OWNER },
    insertPersonOwned: `INSERT INTO public."ExerciseSet" ("id","workout_id","exercise_name","muscle_group","sets_completed","reps_per_set","weight_per_set") VALUES (${lit(id('es-new'))}, ${lit(ROWS.ws.person)}, 'e', 'chest', 1, ARRAY[1], ARRAY[1.0::double precision])`,
    insertPersonAllow: OWNER,
  },
  {
    table: 'WeightLog',
    rows: ROWS.wl,
    set: `SET "notes" = 'x'`,
    userAllow: { select: ['s1'], update: ['s1'], delete: ['s1'] },
    personAllow: { select: NONE, update: NONE, delete: NONE },
    insertPersonOwned: `INSERT INTO public."WeightLog" ("id","person_id","date","weight_lbs") VALUES (${lit(id('wl-new'))}, ${lit(PERSON)}, DATE '2024-01-03', 100)`,
    insertPersonAllow: NONE,
  },
  {
    table: 'Habit',
    rows: ROWS.habit,
    set: `SET "unit" = 'x'`,
    userAllow: { select: ['s1'], update: ['s1'], delete: ['s1'] },
    personAllow: { select: NONE, update: NONE, delete: NONE },
    insertPersonOwned: `INSERT INTO public."Habit" ("id","person_id","name") VALUES (${lit(id('habit-new'))}, ${lit(PERSON)}, 'h')`,
    insertPersonAllow: NONE,
    childDelete: (rowId) => `DELETE FROM public."HabitLog" WHERE "habit_id" = ${lit(rowId)}`,
  },
  {
    table: 'HabitLog',
    rows: ROWS.hl,
    set: `SET "value" = 2`,
    // coach branch shadowed by Habit's owner-only policy (see header, B).
    userAllow: { select: ['s1', 'owner'], update: ['s1', 'owner'], delete: ['s1', 'owner'] },
    personAllow: { select: OWNER, update: OWNER, delete: OWNER },
    insertPersonOwned: `INSERT INTO public."HabitLog" ("id","habit_id","date") VALUES (${lit(id('hl-new'))}, ${lit(ROWS.habit.person)}, DATE '2024-01-03')`,
    insertPersonAllow: OWNER,
  },
  {
    table: 'CheckIn',
    rows: ROWS.ci,
    set: `SET "notes" = 'x'`,
    // owner_all; client_all; coach_select (coach_id = A); coach_update (coach_id = A AND current coach of S1).
    userAllow: {
      select: ['s1', 'coachA', 'owner'],
      update: ['s1', 'coachA', 'owner'],
      delete: ['s1', 'owner'],
    },
    personAllow: { select: OWNER, update: OWNER, delete: OWNER },
    insertPersonOwned: `INSERT INTO public."CheckIn" ("id","person_id","coach_id","date","soreness") VALUES (${lit(id('ci-new'))}, ${lit(PERSON)}, ${lit(users.coachA.id)}, DATE '2024-01-03', 1)`,
    insertPersonAllow: OWNER,
  },
  {
    table: 'ClientWorkoutAssignment',
    rows: ROWS.cwa,
    set: `SET "post_notes" = 'x'`,
    // assignment_coach_manage (assigned_by = A, role coach); assignment_client_read (client = S1).
    userAllow: { select: ['s1', 'coachA'], update: ['coachA'], delete: ['coachA'] },
    personAllow: { select: NONE, update: NONE, delete: NONE },
    insertPersonOwned: `INSERT INTO public."ClientWorkoutAssignment" ("id","workout_plan_id","person_id","assigned_by_coach_id","scheduled_for") VALUES (${lit(id('cwa-new'))}, ${lit(PLAN)}, ${lit(PERSON)}, ${lit(users.coachA.id)}, TIMESTAMP '2024-01-03 00:00:00')`,
    insertPersonAllow: NONE,
  },
  {
    table: 'ClientWorkoutAssignmentSnapshot',
    rows: ROWS.snap,
    set: `SET "plan_name" = 'x'`,
    userAllow: {
      select: ['s1', 'coachA', 'owner'],
      update: ['coachA', 'owner'],
      delete: ['coachA', 'owner'],
    },
    personAllow: { select: OWNER, update: OWNER, delete: OWNER },
    insertPersonOwned: `INSERT INTO public."ClientWorkoutAssignmentSnapshot" ("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version") VALUES (${lit(id('snap-new'))}, ${lit(ROWS.cwa.personBare)}, 'p', 'strength', '[]'::jsonb, ${lit(PLAN)}, 1)`,
    insertPersonAllow: OWNER,
  },
];

const PARENTS = [
  'WorkoutSession',
  'WeightLog',
  'Habit',
  'CheckIn',
  'ClientWorkoutAssignment',
] as const;
const OWNER_COL: Record<(typeof PARENTS)[number], string> = {
  WorkoutSession: 'user_id',
  WeightLog: 'user_id',
  Habit: 'user_id',
  CheckIn: 'user_id',
  ClientWorkoutAssignment: 'client_id',
};
const NEW_TABLES = [
  'PersonInvite',
  'PersonInviteChallenge',
  'PersonLink',
  'PersonLinkProposal',
  'PersonLinkOutbox',
];
const REWRITTEN_POLICIES: Array<[string, string]> = [
  ['WorkoutSession', 'workout_session_owner_access'],
  ['WeightLog', 'weight_log_owner_access'],
  ['Habit', 'habit_owner_access'],
  ['CheckIn', 'check_in_client_all'],
  ['CheckIn', 'check_in_coach_select'],
  ['CheckIn', 'check_in_current_coach_insert'],
  ['CheckIn', 'check_in_current_coach_update'],
  ['ClientWorkoutAssignment', 'assignment_coach_manage'],
  ['ClientWorkoutAssignment', 'assignment_client_read'],
  ['ExerciseSet', 'p_exerciseset_select'],
  ['ExerciseSet', 'p_exerciseset_insert'],
  ['ExerciseSet', 'p_exerciseset_update'],
  ['ExerciseSet', 'p_exerciseset_delete'],
  ['HabitLog', 'p_habitlog_select'],
  ['HabitLog', 'p_habitlog_insert'],
  ['HabitLog', 'p_habitlog_update'],
  ['HabitLog', 'p_habitlog_delete'],
  ['ClientWorkoutAssignmentSnapshot', 'p_clientworkoutassignmentsnapshot_select'],
  ['ClientWorkoutAssignmentSnapshot', 'p_clientworkoutassignmentsnapshot_insert'],
  ['ClientWorkoutAssignmentSnapshot', 'p_clientworkoutassignmentsnapshot_update'],
  ['ClientWorkoutAssignmentSnapshot', 'p_clientworkoutassignmentsnapshot_delete'],
];
const VALIDATED_CONSTRAINTS: Array<[string, string]> = [
  ['WorkoutSession', 'WorkoutSession_owner_xor_check'],
  ['WeightLog', 'WeightLog_owner_xor_check'],
  ['Habit', 'Habit_owner_xor_check'],
  ['CheckIn', 'CheckIn_owner_xor_check'],
  ['CheckIn', 'CheckIn_person_coach_check'],
  ['ClientWorkoutAssignment', 'ClientWorkoutAssignment_owner_xor_check'],
  ['CheckIn', 'CheckIn_person_id_coach_id_fkey'],
  ['PersonInvite', 'PersonInvite_person_id_coach_id_fkey'],
  ['PersonLink', 'PersonLink_person_id_coach_id_fkey'],
  ['PersonLinkProposal', 'PersonLinkProposal_person_id_coach_id_fkey'],
  ['WorkoutSession', 'WorkoutSession_person_id_fkey'],
  ['WeightLog', 'WeightLog_person_id_fkey'],
  ['Habit', 'Habit_person_id_fkey'],
  ['ClientWorkoutAssignment', 'ClientWorkoutAssignment_person_id_fkey'],
  ['ImportNativeProvenance', 'ImportNativeProvenance_person_id_fkey'],
  ['Person', 'Person_linked_user_id_fkey'],
];

async function insertFixtures(): Promise<void> {
  for (const u of Object.values(users)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User" ("id","supabase_id","email","name","role","coach_id") VALUES (${lit(u.id)}, ${lit(u.supabase)}, ${lit(`${u.id}@example.invalid`)}, 'fixture', ${lit(u.role)}::"Role", ${u.coach_id ? lit(u.coach_id) : 'NULL'})`,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."Person" ("id","coach_id","source_platform","source_person_id","display_name") VALUES (${lit(PERSON)}, ${lit(users.coachA.id)}, 'fixture', ${lit(id('src'))}, 'Imported Fixture')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."WorkoutPlan" ("id","coach_id","name","type","updated_at") VALUES
      (${lit(PLAN)}, ${lit(users.coachA.id)}, 'plan', 'strength', now()),
      (${lit(PLAN_B)}, ${lit(users.coachB.id)}, 'plan-b', 'strength', now()),
      (${lit(PLAN_SC)}, ${lit(users.subCoach.id)}, 'plan-sc', 'strength', now()),
      (${lit(PLAN_O)}, ${lit(users.owner.id)}, 'plan-o', 'strength', now())`,
  );
  // D8: sub-coach delegations — one open (S1), one closed (S2).
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."SubCoachAssignment" ("id","head_coach_id","sub_coach_id","client_id","assigned_at","unassigned_at") VALUES
      (${lit(SCA.open)}, ${lit(users.coachA.id)}, ${lit(users.subCoach.id)}, ${lit(users.s1.id)}, now(), NULL),
      (${lit(SCA.closed)}, ${lit(users.coachA.id)}, ${lit(users.subCoach.id)}, ${lit(users.s2.id)}, now() - interval '2 days', now() - interval '1 day')`,
  );
  // Five parents: one user-owned (S1) and one person-owned (P) row each; CheckIn rows name coach A.
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."WorkoutSession" ("id","user_id","person_id","date","workout_name","workout_type") VALUES
      (${lit(ROWS.ws.user)}, ${lit(users.s1.id)}, NULL, DATE '2024-01-01', 'w', 't'),
      (${lit(ROWS.ws.person)}, NULL, ${lit(PERSON)}, DATE '2024-01-02', 'w', 't')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."ExerciseSet" ("id","workout_id","exercise_name","muscle_group","sets_completed","reps_per_set","weight_per_set") VALUES
      (${lit(ROWS.es.user)}, ${lit(ROWS.ws.user)}, 'e', 'chest', 1, ARRAY[1], ARRAY[1.0::double precision]),
      (${lit(ROWS.es.person)}, ${lit(ROWS.ws.person)}, 'e', 'chest', 1, ARRAY[1], ARRAY[1.0::double precision])`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."WeightLog" ("id","user_id","person_id","date","weight_lbs") VALUES
      (${lit(ROWS.wl.user)}, ${lit(users.s1.id)}, NULL, DATE '2024-01-01', 100),
      (${lit(ROWS.wl.person)}, NULL, ${lit(PERSON)}, DATE '2024-01-02', 100)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."Habit" ("id","user_id","person_id","name") VALUES
      (${lit(ROWS.habit.user)}, ${lit(users.s1.id)}, NULL, 'h'),
      (${lit(ROWS.habit.person)}, NULL, ${lit(PERSON)}, 'h')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."HabitLog" ("id","habit_id","date") VALUES
      (${lit(ROWS.hl.user)}, ${lit(ROWS.habit.user)}, DATE '2024-01-01'),
      (${lit(ROWS.hl.person)}, ${lit(ROWS.habit.person)}, DATE '2024-01-01')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES
      (${lit(ROWS.ci.user)}, ${lit(users.s1.id)}, NULL, ${lit(users.coachA.id)}, DATE '2024-01-01', 1),
      (${lit(ROWS.ci.person)}, NULL, ${lit(PERSON)}, ${lit(users.coachA.id)}, DATE '2024-01-02', 1)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."ClientWorkoutAssignment" ("id","workout_plan_id","client_id","person_id","assigned_by_coach_id","scheduled_for") VALUES
      (${lit(ROWS.cwa.user)}, ${lit(PLAN)}, ${lit(users.s1.id)}, NULL, ${lit(users.coachA.id)}, TIMESTAMP '2024-01-01 00:00:00'),
      (${lit(ROWS.cwa.person)}, ${lit(PLAN)}, NULL, ${lit(PERSON)}, ${lit(users.coachA.id)}, TIMESTAMP '2024-01-02 00:00:00'),
      (${lit(ROWS.cwa.personBare)}, ${lit(PLAN)}, NULL, ${lit(PERSON)}, ${lit(users.coachA.id)}, TIMESTAMP '2024-01-04 00:00:00'),
      (${lit(ROWS.cwa.subOwn)}, ${lit(PLAN_SC)}, ${lit(users.s1.id)}, NULL, ${lit(users.subCoach.id)}, TIMESTAMP '2024-01-06 00:00:00'),
      (${lit(ROWS.cwa.crossTenant)}, ${lit(PLAN_B)}, ${lit(users.s1.id)}, NULL, ${lit(users.coachB.id)}, TIMESTAMP '2024-01-07 00:00:00')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."ClientWorkoutAssignmentSnapshot" ("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version") VALUES
      (${lit(ROWS.snap.user)}, ${lit(ROWS.cwa.user)}, 'p', 'strength', '[]'::jsonb, ${lit(PLAN)}, 1),
      (${lit(ROWS.snap.person)}, ${lit(ROWS.cwa.person)}, 'p', 'strength', '[]'::jsonb, ${lit(PLAN)}, 1)`,
  );
}

async function removeFixtures(): Promise<void> {
  const del = async (table: string, col: string, ids: string[]) => {
    if (!ids.length) return;
    await prisma.$executeRawUnsafe(
      `DELETE FROM public."${table}" WHERE "${col}" IN (${ids.map(lit).join(',')})`,
    );
  };
  await del('ClientWorkoutAssignmentSnapshot', 'id', [ROWS.snap.user, ROWS.snap.person]);
  await del('ClientWorkoutAssignment', 'id', [
    ROWS.cwa.user,
    ROWS.cwa.person,
    ROWS.cwa.personBare,
    ROWS.cwa.subOwn,
    ROWS.cwa.crossTenant,
  ]);
  await del('HabitLog', 'id', [ROWS.hl.user, ROWS.hl.person]);
  await del('Habit', 'id', [ROWS.habit.user, ROWS.habit.person]);
  await del('CheckIn', 'id', [ROWS.ci.user, ROWS.ci.person]);
  await del('WeightLog', 'id', [ROWS.wl.user, ROWS.wl.person]);
  await del('ExerciseSet', 'id', [ROWS.es.user, ROWS.es.person]);
  await del('WorkoutSession', 'id', [ROWS.ws.user, ROWS.ws.person]);
  await del('WorkoutPlan', 'id', [PLAN, PLAN_B, PLAN_SC, PLAN_O]);
  await del('SubCoachAssignment', 'id', [SCA.open, SCA.closed]);
  await del('Person', 'id', [PERSON]);
  await del(
    'User',
    'id',
    Object.values(users).map((u) => u.id),
  );
}

describeLive('S8-D3 person-owned schema — RLS role × owner-state matrix (live PG)', () => {
  beforeAll(async () => {
    await prisma.$connect();
    // Supabase's classic auth.uid() reads the JWT `sub` claim; the CI bootstrap stub returns NULL.
    // Install the claim-reading form so the auth.uid()-keyed assignment policies can be exercised.
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$`,
    );
    // Supabase's default privileges grant the API roles table access; a bare Postgres does not.
    // Grant on the tables under test (NOT on the five new tables: their REVOKE is part of the proof)
    // so every denial below is a POLICY denial, never a missing privilege.
    await prisma.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA public, app, auth TO anon, authenticated`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO anon, authenticated`,
    );
    await prisma.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated`);
    for (const t of [...TABLES.map((c) => c.table), 'User', 'WorkoutPlan', 'Person']) {
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public."${t}" TO anon, authenticated`,
      );
    }
    await insertFixtures();
  }, 120_000);

  afterAll(async () => {
    try {
      await removeFixtures();
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  // ── Schema facts ──────────────────────────────────────────────────────────────────────────
  describe('schema (all eleven S8-D3 directories applied; constraints validated; policies guarded)', () => {
    it('records the eleven S8-D3 migrations and the CWA policy-cycle fix as applied', async () => {
      const rows = await q<{ migration_name: string }>(
        `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE '20270125%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1`,
      );
      expect(rows.map((r) => r.migration_name)).toEqual([
        '20270125000000_scout_person_owned_schema',
        '20270125000001_scout_person_owned_index_person_tenant_key',
        '20270125000002_scout_person_owned_index_workout_session',
        '20270125000003_scout_person_owned_index_weight_log',
        '20270125000004_scout_person_owned_index_habit',
        '20270125000005_scout_person_owned_index_check_in_day_key',
        '20270125000006_scout_person_owned_index_assignment',
        '20270125000007_scout_person_owned_index_person_linked_user',
        '20270125000008_scout_person_owned_index_provenance',
        '20270125000009_scout_person_owned_keys',
        '20270125000010_scout_person_owned_validate',
        '20270125000011_cwa_coach_manage_plan_owner_helper',
        '20270125000012_cwa_coach_manage_client_tenancy',
      ]);
    });

    it('every S8-D3 CHECK and FK exists and is VALIDATED', async () => {
      for (const [table, name] of VALIDATED_CONSTRAINTS) {
        const rows = await q<{ convalidated: boolean }>(
          `SELECT convalidated FROM pg_constraint WHERE conrelid = 'public."${table}"'::regclass AND conname = ${lit(name)}`,
        );
        expect({ table, name, found: rows.length, valid: rows[0]?.convalidated }).toEqual({
          table,
          name,
          found: 1,
          valid: true,
        });
      }
    });

    it('Person(id, coach_id) is a unique constraint (promoted from the CONCURRENTLY index)', async () => {
      const rows = await q<{ contype: string; indisvalid: boolean }>(
        `SELECT c.contype, i.indisvalid FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid WHERE c.conrelid = 'public."Person"'::regclass AND c.conname = 'Person_id_coach_id_key'`,
      );
      expect(rows).toEqual([{ contype: 'u', indisvalid: true }]);
    });

    it('the five parents accept NULL in their user/client owner column', async () => {
      for (const t of PARENTS) {
        const rows = await q<{ attnotnull: boolean }>(
          `SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public."${t}"'::regclass AND attname = ${lit(OWNER_COL[t])} AND NOT attisdropped`,
        );
        expect({ t, notnull: rows[0]?.attnotnull }).toEqual({ t, notnull: false });
      }
    });

    it('the 21 rewritten policies exist and every non-owner branch carries person_id IS NULL', async () => {
      for (const [table, name] of REWRITTEN_POLICIES) {
        const rows = await q<{ qual: string | null; with_check: string | null; cmd: string }>(
          `SELECT qual, with_check, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${lit(table)} AND policyname = ${lit(name)}`,
        );
        expect({ table, name, n: rows.length }).toEqual({ table, name, n: 1 });
        const { qual, with_check, cmd } = rows[0];
        if (cmd !== 'INSERT')
          expect({ table, name, qual }).toMatchObject({
            qual: expect.stringMatching(/person_id IS NULL/),
          });
        if (cmd !== 'SELECT' && cmd !== 'DELETE')
          expect({ table, name, with_check }).toMatchObject({
            with_check: expect.stringMatching(/person_id IS NULL/),
          });
      }
    });

    it('RLS is enabled AND forced on the eight rewritten tables and the five new tables', async () => {
      for (const t of [...TABLES.map((c) => c.table), ...NEW_TABLES]) {
        const rows = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public."${t}"'::regclass`,
        );
        expect({ t, ...rows[0] }).toEqual({ t, relrowsecurity: true, relforcerowsecurity: true });
      }
    });

    it('the five new tables are service_role-only: deny-all policies present, API-role privileges revoked, direct read refused', async () => {
      for (const t of NEW_TABLES) {
        const pol = await q<{ policyname: string; permissive: string; roles: string[] }>(
          `SELECT policyname, permissive, roles FROM pg_policies WHERE schemaname = 'public' AND tablename = ${lit(t)} ORDER BY policyname`,
        );
        const byName = Object.fromEntries(pol.map((p) => [p.policyname, p]));
        const perms = pol.filter((p) => p.permissive === 'PERMISSIVE');
        expect(perms.map((p) => p.roles)).toEqual([['service_role']]);
        const restrictive = pol
          .filter((p) => p.permissive === 'RESTRICTIVE')
          .map((p) => p.roles.join(','));
        expect(restrictive.sort()).toEqual(['anon', 'authenticated']);
        expect(Object.keys(byName).length).toBe(3);
        for (const role of ['anon', 'authenticated']) {
          const priv = await q<{ ok: boolean }>(
            `SELECT has_table_privilege(${lit(role)}, 'public."${t}"', 'SELECT') AS ok`,
          );
          expect({ t, role, select: priv[0].ok }).toEqual({ t, role, select: false });
        }
        const read = await attempt(
          P.s1,
          `SELECT count(*)::bigint AS n FROM public."${t}"`,
          'count',
        );
        expect({ t, read }).toEqual({
          t,
          read: { ok: false, sqlstate: '42501', message: expect.any(String) },
        });
      }
    });
  });

  // ── Role × owner-state matrix ─────────────────────────────────────────────────────────────
  describe('matrix: USING (select / update / delete) per principal, user-owned vs person-owned row', () => {
    for (const c of TABLES) {
      for (const [key, p] of Object.entries(P)) {
        for (const verb of ['select', 'update', 'delete'] as Verb[]) {
          const stmt = (rowId: string) =>
            verb === 'select'
              ? `SELECT count(*)::bigint AS n FROM public."${c.table}" WHERE "id" = ${lit(rowId)}`
              : verb === 'update'
                ? `UPDATE public."${c.table}" ${c.set} WHERE "id" = ${lit(rowId)}`
                : `DELETE FROM public."${c.table}" WHERE "id" = ${lit(rowId)}`;
          const mode = verb === 'select' ? 'count' : 'exec';
          const setup = (rowId: string) =>
            verb === 'delete' && c.childDelete ? [c.childDelete(rowId)] : [];

          it(`${c.table} / ${p.label} / ${verb} / USER-owned row → ${c.userAllow[verb].includes(key) ? 'allow' : 'deny'}`, async () => {
            const out = await attempt(p, stmt(c.rows.user), mode, setup(c.rows.user));
            const expected = c.userAllow[verb].includes(key) ? 1 : 0;
            expect({ table: c.table, principal: p.label, verb, out }).toEqual({
              table: c.table,
              principal: p.label,
              verb,
              out: { ok: true, count: expected },
            });
          });

          it(`${c.table} / ${p.label} / ${verb} / PERSON-owned row → ${c.personAllow[verb].includes(key) ? 'allow (stated owner exception)' : 'deny'}`, async () => {
            const out = await attempt(p, stmt(c.rows.person), mode, setup(c.rows.person));
            const expected = c.personAllow[verb].includes(key) ? 1 : 0;
            expect({ table: c.table, principal: p.label, verb, out }).toEqual({
              table: c.table,
              principal: p.label,
              verb,
              out: { ok: true, count: expected },
            });
          });
        }
      }
    }
  });

  describe('matrix: WITH CHECK — person-owned inserts and owner flips are service-role only', () => {
    for (const c of TABLES) {
      for (const [key, p] of Object.entries(P)) {
        const allowed = c.insertPersonAllow.includes(key);
        it(`${c.table} / ${p.label} / INSERT ${(PARENTS as readonly string[]).includes(c.table) ? 'person-owned row' : 'child under person-owned parent'} → ${allowed ? 'allow (stated owner exception)' : 'deny'}`, async () => {
          const out = await attempt(p, c.insertPersonOwned);
          if (allowed) {
            expect({ table: c.table, principal: p.label, out }).toEqual({
              table: c.table,
              principal: p.label,
              out: { ok: true, count: 1 },
            });
          } else {
            expect({ table: c.table, principal: p.label, out }).toEqual({
              table: c.table,
              principal: p.label,
              out: { ok: false, sqlstate: '42501', message: expect.any(String) },
            });
          }
        });
      }
    }

    for (const t of PARENTS) {
      for (const key of ['s1', 'coachA'] as const) {
        const p = P[key];
        const rowId =
          t === 'WorkoutSession'
            ? ROWS.ws.user
            : t === 'WeightLog'
              ? ROWS.wl.user
              : t === 'Habit'
                ? ROWS.habit.user
                : t === 'CheckIn'
                  ? ROWS.ci.user
                  : ROWS.cwa.user;
        it(`${t} / ${p.label} / UPDATE flips the user-owned row to person-owned → deny (0 rows or 42501)`, async () => {
          const out = await attempt(
            p,
            `UPDATE public."${t}" SET "${OWNER_COL[t]}" = NULL, "person_id" = ${lit(PERSON)} WHERE "id" = ${lit(rowId)}`,
          );
          // Either the row is invisible to this principal (0 rows) or the new row fails WITH CHECK.
          const denied = (out.ok && out.count === 0) || (!out.ok && out.sqlstate === '42501');
          expect({ t, principal: p.label, out, denied }).toMatchObject({ denied: true });
        });
      }
    }
  });

  // ── 20270125000011: the WorkoutPlan <-> ClientWorkoutAssignment policy cycle is broken ───────
  describe('ClientWorkoutAssignment coach-manage write path (20270125000011 breaks the base policy cycle)', () => {
    const CWA = 'ClientWorkoutAssignment';
    const insertCwa = (planId: string, clientId: string, assignedBy: string) =>
      `INSERT INTO public."${CWA}" ("id","workout_plan_id","client_id","assigned_by_coach_id","scheduled_for") VALUES (${lit(id('cwa-x'))}, ${lit(planId)}, ${lit(clientId)}, ${lit(assignedBy)}, TIMESTAMP '2024-01-05 00:00:00')`;
    const DENY = { ok: false, sqlstate: '42501', message: expect.any(String) };

    it('the helper is SECURITY DEFINER, STABLE, search_path-pinned, PUBLIC-revoked, and the WITH CHECK uses it instead of an inline WorkoutPlan read', async () => {
      const fn = await q<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(
        `SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = to_regprocedure('app.current_user_owns_workout_plan(text)')`,
      );
      expect(fn).toEqual([{ prosecdef: true, provolatile: 's', proconfig: ['search_path=""'] }]);
      const pub = await q<{ ok: boolean }>(
        `SELECT has_function_privilege('public', 'app.current_user_owns_workout_plan(text)', 'EXECUTE') AS ok`,
      );
      expect(pub).toEqual([{ ok: false }]);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const r = await q<{ ok: boolean }>(
          `SELECT has_function_privilege(${lit(role)}, 'app.current_user_owns_workout_plan(text)', 'EXECUTE') AS ok`,
        );
        expect({ role, ...r[0] }).toEqual({ role, ok: true });
      }
      const pol = await q<{ qual: string; with_check: string }>(
        `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ${lit(CWA)} AND policyname = 'assignment_coach_manage'`,
      );
      expect(pol).toHaveLength(1);
      expect(pol[0].with_check).toMatch(/app\.current_user_owns_workout_plan\(workout_plan_id\)/);
      expect(pol[0].with_check).not.toMatch(/"WorkoutPlan"/);
      expect(pol[0].qual).not.toMatch(/"WorkoutPlan"/);
      // The other direction of the former cycle is untouched: WorkoutPlan's client read still
      // consults ClientWorkoutAssignment (its intent), and WorkoutPlan reads do not recurse.
      const wp = await q<{ qual: string }>(
        `SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'WorkoutPlan' AND policyname = 'client_read_assigned_plans'`,
      );
      expect(wp[0].qual).toMatch(/"ClientWorkoutAssignment"/);
      const planRead = await attempt(
        P.s1,
        `SELECT count(*)::bigint AS n FROM public."WorkoutPlan" WHERE "id" = ${lit(PLAN)}`,
        'count',
      );
      expect(planRead).toEqual({ ok: true, count: 1 });
    });

    it('no principal sees 42P17 on a ClientWorkoutAssignment write any more (the base defect)', async () => {
      for (const p of Object.values(P)) {
        const upd = await attempt(
          p,
          `UPDATE public."${CWA}" SET "post_notes" = 'x' WHERE "id" = 'no-such-row'`,
        );
        expect({ principal: p.label, upd }).toEqual({
          principal: p.label,
          upd: { ok: true, count: 0 },
        });
        const ins = await attempt(p, insertCwa(PLAN, users.s1.id, users.coachA.id));
        expect({ principal: p.label, sqlstate: ins.ok ? 'ok' : ins.sqlstate }).not.toEqual({
          principal: p.label,
          sqlstate: '42P17',
        });
      }
    });

    it('coach A can assign their OWN plan to their client (the designed coach-manage branch now works)', async () => {
      const ins = await attempt(P.coachA, insertCwa(PLAN, users.s1.id, users.coachA.id));
      expect(ins).toEqual({ ok: true, count: 1 });
      const upd = await attempt(
        P.coachA,
        `UPDATE public."${CWA}" SET "post_notes" = 'x' WHERE "id" = ${lit(ROWS.cwa.user)}`,
      );
      expect(upd).toEqual({ ok: true, count: 1 });
    });

    it("coach A cannot assign coach B's plan (plan ownership, WITH CHECK 42501)", async () => {
      expect(await attempt(P.coachA, insertCwa(PLAN_B, users.s1.id, users.coachA.id))).toEqual(
        DENY,
      );
      // ... nor re-point an existing own assignment at coach B's plan.
      expect(
        await attempt(
          P.coachA,
          `UPDATE public."${CWA}" SET "workout_plan_id" = ${lit(PLAN_B)} WHERE "id" = ${lit(ROWS.cwa.user)}`,
        ),
      ).toEqual(DENY);
    });

    it("coach A cannot forge assigned_by as coach B, and coach B cannot write on coach A's plan", async () => {
      expect(await attempt(P.coachA, insertCwa(PLAN, users.s1.id, users.coachB.id))).toEqual(DENY);
      expect(await attempt(P.coachB, insertCwa(PLAN, users.s3.id, users.coachB.id))).toEqual(DENY);
      // Pre-D8 this cell was ALLOWED (coach B's own plan, but coach A's client) — the tenancy gap
      // D8 closes. Coach B on their own plan for their OWN client is the allowed shape.
      expect(await attempt(P.coachB, insertCwa(PLAN_B, users.s1.id, users.coachB.id))).toEqual(DENY);
      expect(await attempt(P.coachB, insertCwa(PLAN_B, users.s3.id, users.coachB.id))).toEqual({
        ok: true,
        count: 1,
      });
    });

    it('clients, same-coach students, unrelated students and anon cannot write ClientWorkoutAssignment at all', async () => {
      for (const key of ['s1', 's2', 's3', 'anon'] as const) {
        const p = P[key];
        // Even naming themselves as the assigner on their own coach's plan (the IDOR 20260702 closed).
        const ins = await attempt(p, insertCwa(PLAN, users.s1.id, p.userId ?? users.s1.id));
        expect({ principal: p.label, ins }).toEqual({ principal: p.label, ins: DENY });
        const upd = await attempt(
          p,
          `UPDATE public."${CWA}" SET "post_notes" = 'x' WHERE "id" = ${lit(ROWS.cwa.user)}`,
        );
        expect({ principal: p.label, upd }).toEqual({
          principal: p.label,
          upd: { ok: true, count: 0 },
        });
      }
    });

    it('person-owned (unlinked Person) assignments stay service-role only: no principal can insert, update or flip one', async () => {
      for (const p of Object.values(P)) {
        const ins = await attempt(
          p,
          `INSERT INTO public."${CWA}" ("id","workout_plan_id","person_id","assigned_by_coach_id","scheduled_for") VALUES (${lit(id('cwa-x'))}, ${lit(PLAN)}, ${lit(PERSON)}, ${lit(users.coachA.id)}, TIMESTAMP '2024-01-05 00:00:00')`,
        );
        expect({ principal: p.label, ins }).toEqual({ principal: p.label, ins: DENY });
        const upd = await attempt(
          p,
          `UPDATE public."${CWA}" SET "post_notes" = 'x' WHERE "id" = ${lit(ROWS.cwa.person)}`,
        );
        expect({ principal: p.label, upd }).toEqual({
          principal: p.label,
          upd: { ok: true, count: 0 },
        });
        const flip = await attempt(
          p,
          `UPDATE public."${CWA}" SET "client_id" = NULL, "person_id" = ${lit(PERSON)} WHERE "id" = ${lit(ROWS.cwa.user)}`,
        );
        const denied = (flip.ok && flip.count === 0) || (!flip.ok && flip.sqlstate === '42501');
        expect({ principal: p.label, flip, denied }).toMatchObject({ denied: true });
      }
    });
  });

  // ── D8 (20270125000012): assignment_coach_manage applies the app's coach-client tenancy rule ──
  describe('D8 — coach-client tenancy on assignment_coach_manage (20270125000012)', () => {
    const CWA = 'ClientWorkoutAssignment';
    const DENY = { ok: false, sqlstate: '42501', message: expect.any(String) };
    const insertCwa = (planId: string, clientId: string, assignedBy: string) =>
      `INSERT INTO public."${CWA}" ("id","workout_plan_id","client_id","assigned_by_coach_id","scheduled_for") VALUES (${lit(id('cwa-d8'))}, ${lit(planId)}, ${lit(clientId)}, ${lit(assignedBy)}, TIMESTAMP '2024-01-08 00:00:00')`;
    const count = (rowId: string) =>
      `SELECT count(*)::bigint AS n FROM public."${CWA}" WHERE "id" = ${lit(rowId)}`;
    const touch = (rowId: string) =>
      `UPDATE public."${CWA}" SET "post_notes" = 'd8' WHERE "id" = ${lit(rowId)}`;
    const repoint = (rowId: string, clientId: string) =>
      `UPDATE public."${CWA}" SET "client_id" = ${lit(clientId)} WHERE "id" = ${lit(rowId)}`;
    const remove = (rowId: string) => `DELETE FROM public."${CWA}" WHERE "id" = ${lit(rowId)}`;
    /** Sub-coach on coach A's team (role coach, coach_id = A); open delegation to S1, closed to S2. */
    const SC: Principal = {
      label: 'sub-coach SC (team A; open delegation to S1)',
      role: 'authenticated',
      userId: users.subCoach.id,
      userRole: 'coach',
      supabaseId: users.subCoach.supabase,
    };
    const ALLOW_1 = { ok: true, count: 1 };
    const NONE_0 = { ok: true, count: 0 };

    it('the tenancy helper is SECURITY DEFINER, STABLE, search_path-pinned, PUBLIC-revoked, and BOTH USING and WITH CHECK call it (no inline User/SubCoachAssignment read; plan helper kept)', async () => {
      const fn = await q<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(
        `SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = to_regprocedure('app.current_user_coaches_client(text)')`,
      );
      expect(fn).toEqual([{ prosecdef: true, provolatile: 's', proconfig: ['search_path=""'] }]);
      // The re-keyed plan helper keeps 20270125000011's hardening and ACL.
      const planFn = await q<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(
        `SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = to_regprocedure('app.current_user_owns_workout_plan(text)')`,
      );
      expect(planFn).toEqual([{ prosecdef: true, provolatile: 's', proconfig: ['search_path=""'] }]);
      const pub = await q<{ ok: boolean }>(
        `SELECT has_function_privilege('public', 'app.current_user_coaches_client(text)', 'EXECUTE') AS ok`,
      );
      expect(pub).toEqual([{ ok: false }]);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const r = await q<{ ok: boolean }>(
          `SELECT has_function_privilege(${lit(role)}, 'app.current_user_coaches_client(text)', 'EXECUTE') AS ok`,
        );
        expect({ role, ...r[0] }).toEqual({ role, ok: true });
      }
      const pol = await q<{ qual: string; with_check: string; cmd: string; permissive: string }>(
        `SELECT qual, with_check, cmd, permissive FROM pg_policies WHERE schemaname = 'public' AND tablename = ${lit(CWA)} AND policyname = 'assignment_coach_manage'`,
      );
      expect(pol).toHaveLength(1);
      expect(pol[0].cmd).toBe('ALL');
      expect(pol[0].permissive).toBe('PERMISSIVE');
      for (const clause of [pol[0].qual, pol[0].with_check]) {
        expect(clause).toMatch(/app\.current_user_coaches_client\(client_id\)/);
        expect(clause).toMatch(/person_id IS NULL/);
        expect(clause).toMatch(/assigned_by_coach_id = /);
        expect(clause).toMatch(/sub_coach/);
        expect(clause).not.toMatch(/"SubCoachAssignment"/);
      }
      // #587's plan-ownership condition is preserved in WITH CHECK (and only there, as before).
      expect(pol[0].with_check).toMatch(/app\.current_user_owns_workout_plan\(workout_plan_id\)/);
      expect(pol[0].qual).not.toMatch(/current_user_owns_workout_plan/);
      // No other policy on the table changed: the client read branch is still present.
      const names = await q<{ policyname: string }>(
        `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ${lit(CWA)} ORDER BY 1`,
      );
      expect(names.map((r) => r.policyname)).toEqual(
        expect.arrayContaining(['assignment_client_read', 'assignment_coach_manage']),
      );
    });

    it('no principal (including the sub-coach) sees 42P17 on any ClientWorkoutAssignment statement with the composed policy', async () => {
      for (const p of [...Object.values(P), SC]) {
        const outs = [
          await attempt(p, count(ROWS.cwa.user), 'count'),
          await attempt(p, touch(ROWS.cwa.user)),
          await attempt(p, remove(ROWS.cwa.subOwn)),
          await attempt(p, insertCwa(PLAN, users.s1.id, users.coachA.id)),
        ];
        for (const out of outs) {
          expect({ principal: p.label, sqlstate: out.ok ? 'ok' : out.sqlstate }).not.toEqual({
            principal: p.label,
            sqlstate: '42P17',
          });
        }
      }
    });

    // (1) positive: a head coach on their OWN roster.
    it('head coach A: INSERT / SELECT / UPDATE / DELETE for their own clients (S1, S2) are allowed', async () => {
      expect(await attempt(P.coachA, insertCwa(PLAN, users.s1.id, users.coachA.id))).toEqual(ALLOW_1);
      expect(await attempt(P.coachA, insertCwa(PLAN, users.s2.id, users.coachA.id))).toEqual(ALLOW_1);
      expect(await attempt(P.coachA, count(ROWS.cwa.user), 'count')).toEqual(ALLOW_1);
      expect(await attempt(P.coachA, touch(ROWS.cwa.user))).toEqual(ALLOW_1);
      // Re-pointing between two of A's own clients passes WITH CHECK.
      expect(await attempt(P.coachA, repoint(ROWS.cwa.user, users.s2.id))).toEqual(ALLOW_1);
      expect(await attempt(P.coachA, remove(ROWS.cwa.user))).toEqual(ALLOW_1);
    });

    // (2) negative: another coach's client, or an unrelated user, as the assignee.
    it("cross-tenant INSERT: coach A cannot assign their own plan to coach B's client (S3), to the owner's client (S4), or to a user on nobody's roster of theirs (coach B)", async () => {
      for (const target of [users.s3.id, users.s4.id, users.coachB.id]) {
        expect({ target, out: await attempt(P.coachA, insertCwa(PLAN, target, users.coachA.id)) }).toEqual({
          target,
          out: DENY,
        });
      }
      // Coach B, symmetric.
      expect(await attempt(P.coachB, insertCwa(PLAN_B, users.s1.id, users.coachB.id))).toEqual(DENY);
      expect(await attempt(P.coachB, insertCwa(PLAN_B, users.s3.id, users.coachB.id))).toEqual(ALLOW_1);
    });

    it("roster branch mirrors the app exactly: a team sub-coach (User.coach_id = A) IS a valid target for head coach A, because assertCanAccessClient's direct branch does not test the target's role (stated, not widened)", async () => {
      // workout-builder.service.ts:842-849 returns as soon as client.coach_id === actingUserId.
      expect(await attempt(P.coachA, insertCwa(PLAN, users.subCoach.id, users.coachA.id))).toEqual(ALLOW_1);
      // ... and coach B, whose roster SC is not on, is denied the same target.
      expect(await attempt(P.coachB, insertCwa(PLAN_B, users.subCoach.id, users.coachB.id))).toEqual(DENY);
    });

    it('ONE identity: the policy is keyed on app.current_user_id() (the backend GUC) — a caller with only a Supabase JWT claim (auth.uid()) is denied, a caller with only the GUC is admitted', async () => {
      const gucOnly: Principal = { ...P.coachA, supabaseId: undefined };
      const claimOnly: Principal = { ...P.coachA, userId: undefined, userRole: undefined };
      expect(await attempt(gucOnly, insertCwa(PLAN, users.s1.id, users.coachA.id))).toEqual(ALLOW_1);
      expect(await attempt(gucOnly, count(ROWS.cwa.user), 'count')).toEqual(ALLOW_1);
      expect(await attempt(gucOnly, touch(ROWS.cwa.user))).toEqual(ALLOW_1);
      expect(await attempt(claimOnly, insertCwa(PLAN, users.s1.id, users.coachA.id))).toEqual(DENY);
      expect(await attempt(claimOnly, count(ROWS.cwa.user), 'count')).toEqual(NONE_0);
      expect(await attempt(claimOnly, touch(ROWS.cwa.user))).toEqual(NONE_0);
      expect(await attempt(claimOnly, remove(ROWS.cwa.user))).toEqual(NONE_0);
      // The role gate reads User.role for that id, not the app.current_user_role GUC.
      const wrongRoleGuc: Principal = { ...P.coachA, userRole: 'student' };
      expect(await attempt(wrongRoleGuc, count(ROWS.cwa.user), 'count')).toEqual(ALLOW_1);
      const studentWithCoachRoleGuc: Principal = { ...P.s3, userRole: 'coach' };
      expect(await attempt(studentWithCoachRoleGuc, insertCwa(PLAN_B, users.s3.id, users.s3.id))).toEqual(DENY);
      // Neither helper mentions auth.uid() any more; both read the GUC.
      const bodies = await q<{ proname: string; prosrc: string }>(
        `SELECT proname, prosrc FROM pg_proc WHERE oid IN (to_regprocedure('app.current_user_owns_workout_plan(text)'), to_regprocedure('app.current_user_coaches_client(text)'))`,
      );
      expect(bodies).toHaveLength(2);
      for (const b of bodies) {
        expect({ fn: b.proname, usesGuc: /app\.current_user_id\(\)/.test(b.prosrc), usesJwt: /auth\.uid/.test(b.prosrc) }).toEqual({ fn: b.proname, usesGuc: true, usesJwt: false });
      }
      const pol = await q<{ qual: string; with_check: string }>(
        `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ${lit(CWA)} AND policyname = 'assignment_coach_manage'`,
      );
      for (const clause of [pol[0].qual, pol[0].with_check]) {
        expect(clause).toMatch(/app\.current_user_id\(\)/);
        expect(clause).not.toMatch(/auth\.uid|supabase_id/);
      }
    });

    it("cross-tenant UPDATE: coach A cannot re-point their own assignment at coach B's client (S3) or at a non-student user (WITH CHECK 42501)", async () => {
      expect(await attempt(P.coachA, repoint(ROWS.cwa.user, users.s3.id))).toEqual(DENY);
      expect(await attempt(P.coachA, repoint(ROWS.cwa.user, users.s4.id))).toEqual(DENY);
      expect(await attempt(P.coachA, repoint(ROWS.cwa.user, users.coachB.id))).toEqual(DENY);
    });

    it('cross-tenant SELECT / UPDATE / DELETE: a pre-D8 row coach B created for coach A\'s client is invisible and immutable to coach B (USING), while coach A still cannot touch it either (assigned_by is B)', async () => {
      // Coach B assigned it, on their own plan, but S1 is coach A's client: 0 rows, never 42501.
      expect(await attempt(P.coachB, count(ROWS.cwa.crossTenant), 'count')).toEqual(NONE_0);
      expect(await attempt(P.coachB, touch(ROWS.cwa.crossTenant))).toEqual(NONE_0);
      expect(await attempt(P.coachB, repoint(ROWS.cwa.crossTenant, users.s3.id))).toEqual(NONE_0);
      expect(await attempt(P.coachB, remove(ROWS.cwa.crossTenant))).toEqual(NONE_0);
      // Coach A owns the client but did not assign it: assigned_by_coach_id = caller still governs.
      expect(await attempt(P.coachA, count(ROWS.cwa.crossTenant), 'count')).toEqual(NONE_0);
      expect(await attempt(P.coachA, touch(ROWS.cwa.crossTenant))).toEqual(NONE_0);
      expect(await attempt(P.coachA, remove(ROWS.cwa.crossTenant))).toEqual(NONE_0);
      // The client keeps reading it through assignment_client_read (unchanged).
      expect(await attempt(P.s1, count(ROWS.cwa.crossTenant), 'count')).toEqual(ALLOW_1);
      // The row still exists (nothing above was admitted; every cell rolled back anyway).
      const still = await q<{ n: bigint | number }>(count(ROWS.cwa.crossTenant));
      expect(Number(still[0].n)).toBe(1);
    });

    // (3) legitimate paths: owner-as-coach, sub-coach with an open delegation, person-owned unchanged.
    it('owner user acting as a coach: allowed for their own client (S4) on their own plan; denied for coach A\'s client', async () => {
      expect(await attempt(P.owner, insertCwa(PLAN_O, users.s4.id, users.owner.id))).toEqual(ALLOW_1);
      expect(await attempt(P.owner, insertCwa(PLAN_O, users.s1.id, users.owner.id))).toEqual(DENY);
      // The owner role has no admin bypass on this table: coach A's row stays 0 for the owner.
      expect(await attempt(P.owner, count(ROWS.cwa.user), 'count')).toEqual(NONE_0);
      expect(await attempt(P.owner, touch(ROWS.cwa.user))).toEqual(NONE_0);
    });

    it('sub-coach SC with an OPEN delegation to S1: INSERT (own plan) / SELECT / UPDATE / DELETE of their own assignment for S1 are allowed', async () => {
      expect(await attempt(SC, insertCwa(PLAN_SC, users.s1.id, users.subCoach.id))).toEqual(ALLOW_1);
      expect(await attempt(SC, count(ROWS.cwa.subOwn), 'count')).toEqual(ALLOW_1);
      expect(await attempt(SC, touch(ROWS.cwa.subOwn))).toEqual(ALLOW_1);
      expect(await attempt(SC, remove(ROWS.cwa.subOwn))).toEqual(ALLOW_1);
      // Head coach A does not see SC's row (assigned_by is SC) — unchanged assigned_by rule.
      expect(await attempt(P.coachA, count(ROWS.cwa.subOwn), 'count')).toEqual(NONE_0);
    });

    it("sub-coach SC: CLOSED delegation (S2), no delegation (S3), a non-student (coach A) and the head coach's plan are all denied", async () => {
      expect(await attempt(SC, insertCwa(PLAN_SC, users.s2.id, users.subCoach.id))).toEqual(DENY);
      expect(await attempt(SC, insertCwa(PLAN_SC, users.s3.id, users.subCoach.id))).toEqual(DENY);
      expect(await attempt(SC, insertCwa(PLAN_SC, users.coachA.id, users.subCoach.id))).toEqual(DENY);
      // Re-pointing SC's own S1 assignment at S2 (closed delegation) fails WITH CHECK.
      expect(await attempt(SC, repoint(ROWS.cwa.subOwn, users.s2.id))).toEqual(DENY);
      // Plan ownership (#587) still composes: SC cannot assign head coach A's plan even to S1.
      expect(await attempt(SC, insertCwa(PLAN, users.s1.id, users.subCoach.id))).toEqual(DENY);
      // And SC cannot forge assigned_by as A.
      expect(await attempt(SC, insertCwa(PLAN, users.s1.id, users.coachA.id))).toEqual(DENY);
    });

    it('closing the delegation (unassigned_at set) revokes the sub-coach through direct access; re-opening restores it — evaluated live, not cached', async () => {
      const close = `UPDATE public."SubCoachAssignment" SET "unassigned_at" = now() WHERE "id" = ${lit(SCA.open)}`;
      expect(await attempt(SC, count(ROWS.cwa.subOwn), 'count', [close])).toEqual(NONE_0);
      expect(await attempt(SC, touch(ROWS.cwa.subOwn), 'exec', [close])).toEqual(NONE_0);
      expect(await attempt(SC, insertCwa(PLAN_SC, users.s1.id, users.subCoach.id), 'exec', [close])).toEqual(DENY);
      const reopen = `UPDATE public."SubCoachAssignment" SET "unassigned_at" = NULL WHERE "id" = ${lit(SCA.closed)}`;
      expect(await attempt(SC, insertCwa(PLAN_SC, users.s2.id, users.subCoach.id), 'exec', [reopen])).toEqual(ALLOW_1);
    });

    it('a soft-deleted student is out of the sub-coach scope (deleted_at IS NULL), but stays on the head coach\'s roster branch — as the application evaluates it', async () => {
      const softDelete = `UPDATE public."User" SET "deleted_at" = now() WHERE "id" = ${lit(users.s1.id)}`;
      expect(await attempt(SC, insertCwa(PLAN_SC, users.s1.id, users.subCoach.id), 'exec', [softDelete])).toEqual(DENY);
      expect(await attempt(P.coachA, insertCwa(PLAN, users.s1.id, users.coachA.id), 'exec', [softDelete])).toEqual(ALLOW_1);
    });

    it('students and anon still cannot write, and person-owned rows remain service-role only under the composed policy', async () => {
      for (const key of ['s1', 's2', 's3', 'anon'] as const) {
        const p = P[key];
        expect({ principal: p.label, out: await attempt(p, insertCwa(PLAN, users.s1.id, p.userId ?? users.s1.id)) }).toEqual({
          principal: p.label,
          out: DENY,
        });
        expect({ principal: p.label, out: await attempt(p, remove(ROWS.cwa.user)) }).toEqual({
          principal: p.label,
          out: NONE_0,
        });
      }
      for (const p of [...Object.values(P), SC]) {
        expect({ principal: p.label, out: await attempt(p, touch(ROWS.cwa.person)) }).toEqual({
          principal: p.label,
          out: NONE_0,
        });
      }
    });

    it('down.sql text restores the 20270125000011 policy and drops only the D8 helper (reversibility contract, static)', async () => {
      // The live forward → down → forward parity proof runs in the Migration Dry-Run workflow; here we
      // pin the contract so a future edit to either file cannot silently diverge.
      const migrations = path.join(__dirname, '..', 'prisma', 'migrations');
      const down = fs.readFileSync(
        path.join(migrations, '20270125000012_cwa_coach_manage_client_tenancy', 'down.sql'),
        'utf8',
      );
      const prev = fs.readFileSync(
        path.join(migrations, '20270125000011_cwa_coach_manage_plan_owner_helper', 'migration.sql'),
        'utf8',
      );
      const policyOf = (sql: string) => {
        const m = /CREATE POLICY "assignment_coach_manage"[\s\S]*?\);/.exec(sql);
        return m ? m[0].replace(/\s+/g, ' ') : null;
      };
      const helperOf = (sql: string) => {
        const m = /CREATE OR REPLACE FUNCTION app\.current_user_owns_workout_plan[\s\S]*?\$\$;/.exec(sql);
        return m ? m[0] : null;
      };
      expect(policyOf(down)).not.toBeNull();
      expect(policyOf(down)).toBe(policyOf(prev));
      expect(helperOf(down)).not.toBeNull();
      expect(helperOf(down)).toBe(helperOf(prev));
      expect(down).toMatch(/DROP FUNCTION IF EXISTS app\.current_user_coaches_client\(text\);/);
      expect(down).not.toMatch(/DROP FUNCTION IF EXISTS app\.current_user_owns_workout_plan/);
    });
  });

  // ── Constraints, proved as a BYPASSRLS principal (the policy is not what refuses) ─────────
  describe('constraints (service-role path)', () => {
    it('exactly-one-owner: ownerless and double-owned rows are refused on all five parents (23514)', async () => {
      const cases: Record<
        (typeof PARENTS)[number],
        (owner: string | null, person: string | null) => string
      > = {
        WorkoutSession: (u, p) =>
          `INSERT INTO public."WorkoutSession" ("id","user_id","person_id","date","workout_name","workout_type") VALUES (${lit(id('x'))}, ${u ? lit(u) : 'NULL'}, ${p ? lit(p) : 'NULL'}, DATE '2024-02-01', 'w', 't')`,
        WeightLog: (u, p) =>
          `INSERT INTO public."WeightLog" ("id","user_id","person_id","date","weight_lbs") VALUES (${lit(id('x'))}, ${u ? lit(u) : 'NULL'}, ${p ? lit(p) : 'NULL'}, DATE '2024-02-01', 1)`,
        Habit: (u, p) =>
          `INSERT INTO public."Habit" ("id","user_id","person_id","name") VALUES (${lit(id('x'))}, ${u ? lit(u) : 'NULL'}, ${p ? lit(p) : 'NULL'}, 'h')`,
        CheckIn: (u, p) =>
          `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES (${lit(id('x'))}, ${u ? lit(u) : 'NULL'}, ${p ? lit(p) : 'NULL'}, ${lit(users.coachA.id)}, DATE '2024-02-01', 1)`,
        ClientWorkoutAssignment: (u, p) =>
          `INSERT INTO public."ClientWorkoutAssignment" ("id","workout_plan_id","client_id","person_id","assigned_by_coach_id","scheduled_for") VALUES (${lit(id('x'))}, ${lit(PLAN)}, ${u ? lit(u) : 'NULL'}, ${p ? lit(p) : 'NULL'}, ${lit(users.coachA.id)}, now())`,
      };
      for (const t of PARENTS) {
        const none = await asAdmin(cases[t](null, null));
        const both = await asAdmin(cases[t](users.s1.id, PERSON));
        const one = await asAdmin(cases[t](null, PERSON));
        expect({ t, none, both, one: one.ok }).toEqual({
          t,
          none: {
            ok: false,
            sqlstate: '23514',
            message: expect.stringContaining(`${t}_owner_xor_check`),
          },
          both: {
            ok: false,
            sqlstate: '23514',
            message: expect.stringContaining(`${t}_owner_xor_check`),
          },
          one: true,
        });
      }
    });

    it('CheckIn: a person-owned row without a coach fails the coach CHECK (23514)', async () => {
      const out = await asAdmin(
        `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES (${lit(id('x'))}, NULL, ${lit(PERSON)}, NULL, DATE '2024-02-01', 1)`,
      );
      expect(out).toEqual({
        ok: false,
        sqlstate: '23514',
        message: expect.stringContaining('CheckIn_person_coach_check'),
      });
    });

    it("CheckIn: a person-owned row naming a coach other than the Person's tenant fails the composite FK (23503)", async () => {
      const out = await asAdmin(
        `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES (${lit(id('x'))}, NULL, ${lit(PERSON)}, ${lit(users.coachB.id)}, DATE '2024-02-01', 1)`,
      );
      expect(out).toEqual({
        ok: false,
        sqlstate: '23503',
        message: expect.stringContaining('CheckIn_person_id_coach_id_fkey'),
      });
    });

    it('CheckIn: a user-owned row is not checked by the composite FK (MATCH SIMPLE; coach_id may be any or NULL)', async () => {
      const out = await asAdmin(
        `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES (${lit(id('x'))}, ${lit(users.s3.id)}, NULL, ${lit(users.coachB.id)}, DATE '2024-02-01', 1)`,
      );
      expect(out).toEqual({ ok: true, count: 1 });
    });

    it('CheckIn: one person-owned check-in per Person per day (partial unique, 23505)', async () => {
      // The partial unique index is the only unique index over (person_id, date) (header, harness notes).
      const idx = await q<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CheckIn' AND indexname = 'CheckIn_person_id_date_key'`,
      );
      expect(idx).toEqual([
        {
          indexdef: `CREATE UNIQUE INDEX "CheckIn_person_id_date_key" ON public."CheckIn" USING btree (person_id, date) WHERE (person_id IS NOT NULL)`,
        },
      ]);
      const out = await asAdmin(
        `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES (${lit(id('x'))}, NULL, ${lit(PERSON)}, ${lit(users.coachA.id)}, DATE '2024-01-02', 1)`,
      );
      // Prisma surfaces the DETAIL line (violated key columns + values); the (user_id, date) key would
      // report `Key (user_id, date)`.
      expect(out).toEqual({
        ok: false,
        sqlstate: '23505',
        message: expect.stringContaining(
          `Key (person_id, date)=(${PERSON}, 2024-01-02) already exists`,
        ),
      });
      // The pre-existing (user_id, date) key still governs user-owned rows, unchanged.
      const userDup = await asAdmin(
        `INSERT INTO public."CheckIn" ("id","user_id","person_id","coach_id","date","soreness") VALUES (${lit(id('x'))}, ${lit(users.s1.id)}, NULL, ${lit(users.coachA.id)}, DATE '2024-01-01', 1)`,
      );
      expect(userDup).toEqual({
        ok: false,
        sqlstate: '23505',
        message: expect.stringContaining(
          `Key (user_id, date)=(${users.s1.id}, 2024-01-01) already exists`,
        ),
      });
    });

    it('Person with owned rows cannot be deleted (RESTRICT, 23503)', async () => {
      const out = await asAdmin(`DELETE FROM public."Person" WHERE "id" = ${lit(PERSON)}`);
      expect(out).toEqual({ ok: false, sqlstate: '23503', message: expect.any(String) });
    });

    it('PersonLink: undo deadline is linked_at + 30 days, one active link per Person and per (coach, user); tenant FK pins coach', async () => {
      const inviteId = id('inv');
      const challengeId = id('ch');
      const link1 = id('link-1');
      const base = `INSERT INTO public."PersonInvite" ("id","coach_id","person_id","created_by_user_id","token_hash","contact_email","status","expires_at") VALUES (${lit(inviteId)}, ${lit(users.coachA.id)}, ${lit(PERSON)}, ${lit(users.coachA.id)}, ${lit(id('tok'))}, 'x@example.invalid', 'open', now() + interval '14 days');
        INSERT INTO public."PersonInviteChallenge" ("id","invite_id","coach_id","claimant_user_id","channel","code_hash","expires_at","verified_at") VALUES (${lit(challengeId)}, ${lit(inviteId)}, ${lit(users.coachA.id)}, ${lit(users.s1.id)}, 'email', 'h', now() + interval '10 minutes', now());`;
      const linkSql = (
        linkId: string,
        coach: string,
        person: string,
        user: string,
        deadline: string,
      ) =>
        `INSERT INTO public."PersonLink" ("id","coach_id","person_id","user_id","path","invite_id","challenge_id","verified_channel","verified_contact_digest","client_confirmed_at","coach_confirmed_at","coach_confirmed_by_user_id","linked_at","undo_deadline_at","records_moved") VALUES (${lit(linkId)}, ${lit(coach)}, ${lit(person)}, ${lit(user)}, 'invite', ${lit(inviteId)}, ${lit(challengeId)}, 'email', 'd', now(), now(), ${lit(coach)}, TIMESTAMP '2024-03-01 00:00:00', ${deadline}, '{}'::jsonb)`;

      /** Leading statements are fixture setup (must succeed); the LAST argument is the probed statement. */
      const run = async (...stmts: string[]): Promise<Outcome> => {
        const tail = stmts[stmts.length - 1];
        const pre = stmts.slice(0, -1);
        let out: Outcome = { ok: false, sqlstate: 'NORUN', message: '' };
        try {
          await prisma.$transaction(
            async (tx) => {
              for (const s of base
                .split(';')
                .map((x) => x.trim())
                .filter(Boolean))
                await tx.$executeRawUnsafe(s);
              await tx.$executeRawUnsafe(
                linkSql(
                  link1,
                  users.coachA.id,
                  PERSON,
                  users.s1.id,
                  `TIMESTAMP '2024-03-31 00:00:00'`,
                ),
              );
              for (const s of pre) await tx.$executeRawUnsafe(s);
              try {
                out = { ok: true, count: await tx.$executeRawUnsafe(tail) };
              } catch (e) {
                out = {
                  ok: false,
                  sqlstate: sqlstate(e),
                  message: String((e as Error).message).slice(0, 300),
                };
              }
              throw new Rollback();
            },
            { timeout: 30_000, maxWait: 30_000 },
          );
        } catch (e) {
          if (!(e instanceof Rollback)) throw e;
        }
        return out;
      };

      const wrongDeadline = await run(
        linkSql(
          id('link-2'),
          users.coachA.id,
          PERSON,
          users.s2.id,
          `TIMESTAMP '2024-04-01 00:00:00'`,
        ),
      );
      expect(wrongDeadline).toEqual({
        ok: false,
        sqlstate: '23514',
        message: expect.stringContaining('PersonLink_undo_deadline_check'),
      });

      const secondActiveForPerson = await run(
        linkSql(
          id('link-2'),
          users.coachA.id,
          PERSON,
          users.s2.id,
          `TIMESTAMP '2024-03-31 00:00:00'`,
        ),
      );
      // 23505 carries the DETAIL line (violated key), not the index name: `(person_id)` alone is the
      // active-per-Person partial unique; the (coach_id, user_id) key names both columns.
      expect(secondActiveForPerson).toEqual({
        ok: false,
        sqlstate: '23505',
        message: expect.stringContaining(`Key (person_id)=(${PERSON}) already exists`),
      });
      const activeIdx = await q<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'PersonLink' AND indexname IN ('PersonLink_active_person_key', 'PersonLink_active_coach_user_key') ORDER BY indexname`,
      );
      expect(activeIdx).toEqual([
        {
          indexname: 'PersonLink_active_coach_user_key',
          indexdef: `CREATE UNIQUE INDEX "PersonLink_active_coach_user_key" ON public."PersonLink" USING btree (coach_id, user_id) WHERE ((linked_at IS NOT NULL) AND (unlinked_at IS NULL))`,
        },
        {
          indexname: 'PersonLink_active_person_key',
          indexdef: `CREATE UNIQUE INDEX "PersonLink_active_person_key" ON public."PersonLink" USING btree (person_id) WHERE ((linked_at IS NOT NULL) AND (unlinked_at IS NULL))`,
        },
      ]);

      // Same account, a second Person of the same coach → the (coach_id, user_id) active key (L6).
      const secondActiveForUser = await run(
        `INSERT INTO public."Person" ("id","coach_id","source_platform","source_person_id","display_name") VALUES (${lit(id('person-2'))}, ${lit(users.coachA.id)}, 'fixture', ${lit(id('src-2'))}, 'Second Fixture')`,
        linkSql(
          id('link-2'),
          users.coachA.id,
          id('person-2'),
          users.s1.id,
          `TIMESTAMP '2024-03-31 00:00:00'`,
        ),
      );
      expect(secondActiveForUser).toEqual({
        ok: false,
        sqlstate: '23505',
        message: expect.stringContaining(
          `Key (coach_id, user_id)=(${users.coachA.id}, ${users.s1.id}) already exists`,
        ),
      });

      // Composite tenant FK: a link naming coach B for a Person that belongs to coach A. Probed on a
      // Person with NO active link (PERSON already holds link1, whose active-person key would fire
      // first, 23505), so the FK is the only constraint that can refuse.
      const wrongTenant = await run(
        `INSERT INTO public."Person" ("id","coach_id","source_platform","source_person_id","display_name") VALUES (${lit(id('person-2'))}, ${lit(users.coachA.id)}, 'fixture', ${lit(id('src-2'))}, 'Second Fixture')`,
        linkSql(
          id('link-2'),
          users.coachB.id,
          id('person-2'),
          users.s3.id,
          `TIMESTAMP '2024-03-31 00:00:00'`,
        ),
      );
      expect(wrongTenant).toEqual({
        ok: false,
        sqlstate: '23503',
        message: expect.stringContaining('PersonLink_person_id_coach_id_fkey'),
      });

      const unlinkThenRelinkSameUser = await run(
        `UPDATE public."PersonLink" SET "unlinked_at" = now(), "unlinked_by_role" = 'client', "unlink_reason_code" = 'not_me', "records_returned" = '{}'::jsonb WHERE "id" = ${lit(link1)}`,
      );
      expect(unlinkThenRelinkSameUser).toEqual({ ok: true, count: 1 });

      const partialUnlinkStamps = await run(
        `UPDATE public."PersonLink" SET "unlinked_at" = now() WHERE "id" = ${lit(link1)}`,
      );
      expect(partialUnlinkStamps).toEqual({
        ok: false,
        sqlstate: '23514',
        message: expect.stringContaining('PersonLink_unlink_shape_check'),
      });

      const selfAnchor = await run(
        `UPDATE public."PersonLink" SET "path" = 'proposal_merge', "merge_anchor_link_id" = ${lit(link1)} WHERE "id" = ${lit(link1)}`,
      );
      expect(selfAnchor).toEqual({ ok: false, sqlstate: '23514', message: expect.any(String) });
    });
  });
});
