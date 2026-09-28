/**
 * scripts/check-rls-catalog.ts
 *
 * S12-B5 (owner question 8) — read-only production RLS catalog check.
 *
 * Purpose: this repo's migration history proves that `WorkoutSession`,
 * `WeightLog` and `Habit` (unlike their child tables `ExerciseSet` /
 * `HabitLog`, and unlike `CheckIn` / `ClientWorkoutAssignment*`) have never
 * received an `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statement in any
 * migration (verified by `rg` across `prisma/migrations/**` — see BUILD.md).
 * That is a static fact about the migration files; it says nothing about
 * what the deployed production catalog actually looks like today (drift,
 * out-of-band `ALTER TABLE`, a migration this script's author missed, etc).
 * This script closes that gap with a single, explicit, human-approved,
 * read-only catalog read against the *actual* target database — never an
 * automated or unattended run, and NEVER against production by this script
 * itself (see "Invocation" below and WORKER_RULES §9 owner-reserved
 * boundaries: production is owner-reserved).
 *
 * What it does:
 *   - Opens one `BEGIN TRANSACTION READ ONLY` (server-enforced: any DDL/DML
 *     attempted inside it errors instead of silently succeeding).
 *   - For each table in TARGET_TABLES, reads:
 *       - pg_class.relrowsecurity   (RLS enabled for owner-context queries)
 *       - pg_class.relforcerowsecurity (RLS forced for the table owner too)
 *       - pg_policies                (one row per policy defined on the table)
 *   - Computes and prints TWO SEPARATE signals per table, never merged into
 *     one boolean (S12-B5 review closure, S12B5-SOL-A1): a "RLS security
 *     PASS/GAP" verdict computed ONLY from the live catalog read (enabled +
 *     forced + ≥1 policy = PASS; anything else, including a table this
 *     script cannot find, = GAP), and a separate "matches / differs from
 *     migration expectation" note that says whether the live state agrees
 *     with what this repo's migration history predicts. A table whose
 *     known, expected state IS a gap (WorkoutSession, WeightLog, Habit
 *     today, pending S8-D3) still prints GAP and still fails the exit code
 *     — "expected" only explains why the gap is not a surprise, it can
 *     never launder a missing/disabled RLS state into a security pass.
 *   - Always rolls the transaction back (belt-and-suspenders on top of
 *     READ ONLY; there is nothing to commit).
 *   - Exits 1 if any table's live RLS security verdict is GAP (never based
 *     on the migration-expectation note alone), so the invocation's own
 *     exit code is a second, independent signal beyond the printed verdict.
 *     Exits 2 on any query/connection error (fails closed — never reports
 *     PASS on a failed read).
 *
 * What it deliberately does NOT do:
 *   - No DDL, no DML, no `SET ROLE`, no policy creation/repair. This is a
 *     read of the catalog, nothing else.
 *   - No default DATABASE_URL: there is no hard-coded fallback connection
 *     string in this file, so a bare invocation with no DATABASE_URL set at
 *     all exits 2 immediately (see "DATABASE_URL is not set" below).
 *     S12B5-SOL-C1 correction: this is NOT protection against pointing at
 *     production — if DATABASE_URL is already exported in the caller's
 *     shell (from an unrelated tool, a sourced .env, etc.) this script uses
 *     exactly that value, including a production one, with no extra
 *     confirmation step. The caller is responsible for checking
 *     `echo $DATABASE_URL` (or equivalent) resolves to the intended target
 *     BEFORE invoking this script; `maskDatabaseUrl()` below only redacts
 *     credentials in the PRINTED report, it does not gate which database
 *     gets queried.
 *   - No retry/loop/schedule. One run, one report, exit.
 *
 * EXPECTED_STATE below encodes what the readiness doc (S12_PILOT_READINESS
 * §2b row S12-B5) says these tables are FOR: WorkoutSession, WeightLog and
 * Habit are person-owned health/fitness data with no RLS migration on file
 * (expected GAP, pending S8-D3 per the readiness doc §4 item 13); CheckIn
 * and ClientWorkoutAssignment* have RLS migrations on file and are expected
 * enabled+forced with at least one policy (expected OK). EXPECTED_STATE
 * never feeds into the security PASS/GAP verdict — it only supplies the
 * migration-expectation note, computed and printed separately, so a real
 * out-of-band change (in either direction) is visible as "differs from
 * expectation" instead of silently agreeing, AND so a known gap is never
 * reported as a security pass just because it was anticipated.
 *
 * Invocation (never run this against production — see GRANT.md / WORKER_RULES.md,
 * production is an owner-reserved boundary; this script is written and
 * reviewed, NOT executed there by any agent):
 *
 *   DATABASE_URL="postgresql://READONLY_USER:PASS@HOST:5432/DBNAME" \
 *     npx ts-node scripts/check-rls-catalog.ts
 *
 * For Bradley to run the single approved read the readiness doc describes
 * (§4 item 13), point DATABASE_URL at the production database with a
 * READ-ONLY-privileged role if one exists, otherwise the normal application
 * role is sufficient since the script issues no writes; confirm the target
 * with `maskDatabaseUrl`'s printed host/db line before trusting the run, and
 * record stdout in evidence alongside the doc that decision closes.
 *
 * Exit codes: 0 = every table's live RLS security verdict is PASS. 1 = at
 * least one table's live RLS security verdict is GAP (independent of
 * whether that GAP matches migration expectation). 2 = could not complete
 * the read (connection/query error) — never conflated with "0 gaps found".
 */

import { PrismaClient } from '@prisma/client';

// Report lines go to stdout via a plain write, not console.log — this repo's
// eslint config restricts console.* to warn/error (no-console), and this CLI's
// entire purpose is to print a structured report, so a tiny helper keeps every
// report line lint-clean without reaching for console.log.
function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface ExpectedState {
  /** Human label for why this table is/isn't expected to have RLS today. */
  note: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  minPolicyCount: number;
}

// Tables named in S12_PILOT_READINESS.md §2b row S12-B5 (owner question 8):
// WorkoutSession, WeightLog, Habit, CheckIn, ClientWorkoutAssignment* — the
// trailing "*" in the readiness doc covers both ClientWorkoutAssignment and
// its snapshot child table, so both are listed explicitly here rather than
// relying on a wildcard the SQL layer would have to interpret.
const TARGET_TABLES = [
  'WorkoutSession',
  'WeightLog',
  'Habit',
  'CheckIn',
  'ClientWorkoutAssignment',
  'ClientWorkoutAssignmentSnapshot',
] as const;

// Plain `string[]` copy for the two $queryRawUnsafe call sites below — the
// pg driver needs an ordinary mutable array for the `= ANY($1::text[])`
// bind parameter, and building it once here (instead of casting the
// readonly tuple at each call site) keeps both sites free of a double
// type-assertion.
const TARGET_TABLE_NAMES: string[] = [...TARGET_TABLES];

const EXPECTED_STATE: Record<(typeof TARGET_TABLES)[number], ExpectedState> = {
  WorkoutSession: {
    note:
      'No ENABLE ROW LEVEL SECURITY for this table in any prisma/migrations/** file ' +
      '(only its child ExerciseSet has RLS) — expected GAP pending S8-D3.',
    relrowsecurity: false,
    relforcerowsecurity: false,
    minPolicyCount: 0,
  },
  WeightLog: {
    note:
      'No ENABLE ROW LEVEL SECURITY for this table in any prisma/migrations/** file — ' +
      'expected GAP pending S8-D3.',
    relrowsecurity: false,
    relforcerowsecurity: false,
    minPolicyCount: 0,
  },
  Habit: {
    note:
      'No ENABLE ROW LEVEL SECURITY for this table in any prisma/migrations/** file ' +
      '(only its child HabitLog has RLS) — expected GAP pending S8-D3.',
    relrowsecurity: false,
    relforcerowsecurity: false,
    minPolicyCount: 0,
  },
  CheckIn: {
    note:
      'ENABLE + FORCE ROW LEVEL SECURITY plus owner/client/coach policies land in ' +
      '20260607000000_rls_remaining_gaps — expected OK.',
    relrowsecurity: true,
    relforcerowsecurity: true,
    minPolicyCount: 1,
  },
  ClientWorkoutAssignment: {
    note:
      'ENABLE + FORCE ROW LEVEL SECURITY lands in 20260508000001_rls_workout_builder, ' +
      'policies added/fixed through 20260702000000_fix_workout_rls_coach_role — expected OK.',
    relrowsecurity: true,
    relforcerowsecurity: true,
    minPolicyCount: 1,
  },
  ClientWorkoutAssignmentSnapshot: {
    note:
      'ENABLE + FORCE ROW LEVEL SECURITY plus policies land together in ' +
      '20261215000000_mwb_1_data_model — expected OK.',
    relrowsecurity: true,
    relforcerowsecurity: true,
    minPolicyCount: 1,
  },
};

interface RelsecRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: string[] | null;
}

interface TableVerdict {
  table: string;
  found: boolean;
  actual: { relrowsecurity: boolean; relforcerowsecurity: boolean; policyCount: number };
  expected: ExpectedState;
  policies: PolicyRow[];
  // S12B5-SOL-A1 closure: these are two DELIBERATELY SEPARATE signals, never merged into one
  // boolean again. `matchesMigrationExpectation` says "the live catalog agrees with what this
  // repo's migration history predicts" — for WorkoutSession/WeightLog/Habit that prediction IS
  // the known RLS gap, so agreeing with it is NOT a security pass. `securityPass` says "RLS is
  // actually enabled, forced and policy-backed on this table right now", computed only from the
  // live catalog read, completely independent of what any migration predicted. A gate that only
  // reads `securityPass` can never be green because a known gap happened to match a stale
  // expectation.
  matchesMigrationExpectation: boolean;
  securityPass: boolean;
  reason: string;
}

/** Security truth from the live catalog alone: RLS enabled, forced, and at least one policy. */
function computeSecurityPass(actual: {
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  policyCount: number;
}): boolean {
  return actual.relrowsecurity && actual.relforcerowsecurity && actual.policyCount > 0;
}

function computeVerdict(
  table: string,
  relsec: RelsecRow | undefined,
  policies: PolicyRow[],
): TableVerdict {
  const expected = EXPECTED_STATE[table as (typeof TARGET_TABLES)[number]];
  if (!relsec) {
    return {
      table,
      found: false,
      actual: { relrowsecurity: false, relforcerowsecurity: false, policyCount: policies.length },
      expected,
      policies,
      matchesMigrationExpectation: false,
      // A table this script cannot even find is an unverified GAP, never a pass — fail closed.
      securityPass: false,
      reason:
        `table not found in pg_class for schema 'public' — cannot verify. This is an ` +
        `UNVERIFIED GAP (fails closed), not a pass, regardless of migration expectation ` +
        `(${expected.note})`,
    };
  }

  const actual = {
    relrowsecurity: relsec.relrowsecurity,
    relforcerowsecurity: relsec.relforcerowsecurity,
    policyCount: policies.length,
  };

  const mismatches: string[] = [];
  if (actual.relrowsecurity !== expected.relrowsecurity) {
    mismatches.push(
      `relrowsecurity actual=${actual.relrowsecurity} expected=${expected.relrowsecurity}`,
    );
  }
  if (actual.relforcerowsecurity !== expected.relforcerowsecurity) {
    mismatches.push(
      `relforcerowsecurity actual=${actual.relforcerowsecurity} expected=${expected.relforcerowsecurity}`,
    );
  }
  if (actual.policyCount < expected.minPolicyCount) {
    mismatches.push(
      `policyCount actual=${actual.policyCount} expected>=${expected.minPolicyCount}`,
    );
  }

  const matchesMigrationExpectation = mismatches.length === 0;
  const securityPass = computeSecurityPass(actual);

  const reasonParts: string[] = [];
  reasonParts.push(
    matchesMigrationExpectation
      ? `matches migration expectation (${expected.note})`
      : `DIFFERS FROM migration expectation (${expected.note}): ${mismatches.join('; ')}`,
  );
  reasonParts.push(
    securityPass
      ? 'RLS security: PASS (enabled + forced + ≥1 policy, from the live catalog)'
      : 'RLS security: GAP (missing/disabled RLS or zero policies on the live catalog) — ' +
          'this is a GAP regardless of what was expected',
  );

  return {
    table,
    found: true,
    actual,
    expected,
    policies,
    matchesMigrationExpectation,
    securityPass,
    reason: reasonParts.join('; '),
  };
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error(
      '[check-rls-catalog] DATABASE_URL is not set. Refusing to fall back to any default ' +
        '— pass the target connection string explicitly. See file header "Invocation".',
    );
    return 2;
  }

  const prisma = new PrismaClient();
  let exitCode = 0;

  try {
    await prisma.$transaction(async (tx) => {
      // Server-enforced: this session cannot execute DDL/DML for the
      // remainder of the transaction even if a future edit to this file
      // tried to. `SET TRANSACTION READ ONLY` is a defense-in-depth
      // belt on top of the fact that every statement below is a SELECT.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

      const relsecRows = await tx.$queryRawUnsafe<RelsecRow[]>(
        `SELECT c.relname AS "relname",
                  c.relrowsecurity AS "relrowsecurity",
                  c.relforcerowsecurity AS "relforcerowsecurity"
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relkind = 'r'
             AND c.relname = ANY($1::text[])`,
        TARGET_TABLE_NAMES,
      );

      const policyRows = await tx.$queryRawUnsafe<PolicyRow[]>(
        `SELECT tablename AS "tablename",
                  policyname AS "policyname",
                  cmd AS "cmd",
                  roles AS "roles"
           FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = ANY($1::text[])
           ORDER BY tablename, policyname`,
        TARGET_TABLE_NAMES,
      );

      const byTable = new Map<string, RelsecRow>(relsecRows.map((r) => [r.relname, r]));
      const policiesByTable = new Map<string, PolicyRow[]>();
      for (const p of policyRows) {
        const list = policiesByTable.get(p.tablename) ?? [];
        list.push(p);
        policiesByTable.set(p.tablename, list);
      }

      report('S12-B5 RLS catalog check — read-only, transaction READ ONLY');
      report(`Target: ${maskDatabaseUrl(process.env.DATABASE_URL!)}`);
      report(`Checked at: ${new Date().toISOString()}`);
      report('');

      const verdicts: TableVerdict[] = TARGET_TABLES.map((table) =>
        computeVerdict(table, byTable.get(table), policiesByTable.get(table) ?? []),
      );

      // S12B5-SOL-A1 closure: the printed status and the exit code are both driven ONLY by
      // `securityPass` (the live catalog's actual RLS state), never by
      // `matchesMigrationExpectation`. A table whose live state matches a known, expected GAP
      // (WorkoutSession/WeightLog/Habit today) still prints GAP and still fails the gate —
      // "expected" only annotates WHY the gap is not a surprise, it never launders it into a
      // pass.
      for (const v of verdicts) {
        const status = v.securityPass ? 'OK  ' : 'GAP ';
        const expectationNote = v.matchesMigrationExpectation
          ? 'matches migration expectation'
          : 'DIFFERS FROM migration expectation';
        report(
          `[${status}] ${v.table}: relrowsecurity=${v.actual.relrowsecurity} ` +
            `relforcerowsecurity=${v.actual.relforcerowsecurity} policies=${v.actual.policyCount} ` +
            `(${expectationNote})`,
        );
        report(`        ${v.reason}`);
        if (v.policies.length > 0) {
          for (const p of v.policies) {
            report(`        policy: ${p.policyname} (${p.cmd}, roles=${p.roles ?? '{}'})`);
          }
        }
        if (!v.securityPass) exitCode = 1;
      }

      report('');
      const gapCount = verdicts.filter((v) => !v.securityPass).length;
      const expectationMismatchCount = verdicts.filter((v) => !v.matchesMigrationExpectation).length;
      report(
        `Summary: ${verdicts.length - gapCount}/${verdicts.length} tables PASS live RLS security, ` +
          `${gapCount} GAP(s). Separately: ${verdicts.length - expectationMismatchCount}/${verdicts.length} ` +
          `match migration expectation, ${expectationMismatchCount} differ from expectation ` +
          `(a differ-from-expectation table needs investigation — it is neither this script's ` +
          `security verdict nor safe to ignore).`,
      );

      // Nothing was written; roll back explicitly rather than commit, so
      // the transaction's write-intent is unambiguous even though READ
      // ONLY already forbids writes.
      throw new ReadOnlyRollback();
    });
  } catch (err) {
    if (!(err instanceof ReadOnlyRollback)) {
      console.error('[check-rls-catalog] query/connection error — failing closed (exit 2).');
      console.error(safeErrorSummary(err));
      return 2;
    }
  } finally {
    await prisma.$disconnect();
  }

  return exitCode;
}

/** Thrown deliberately to force `$transaction` to roll back a read-only check. */
class ReadOnlyRollback extends Error {}

function maskDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host || 'unknown-host';
    const db = u.pathname || '';
    return `${u.protocol}//***:***@${host}${db}`;
  } catch {
    return '***masked (unparseable DATABASE_URL)***';
  }
}

// S12B5-SOL-C1 closure: never print a raw caught error. A Prisma/pg connection or query error
// can embed the connection string (including credentials), bind parameters, or raw query text
// in its message. This prints only the error's constructor name and, if present, a driver error
// `code` (a short enum like 'ECONNREFUSED' or a Postgres SQLSTATE) — enough to diagnose the
// failure class without risking a credential or query fragment landing in a captured log.
function safeErrorSummary(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { constructor?: { name?: string } }).constructor?.name ?? 'Error';
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' || typeof code === 'number'
      ? `${name} (code=${String(code)})`
      : name;
  }
  return 'unknown error (non-object)';
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[check-rls-catalog] unexpected top-level error.');
    console.error(safeErrorSummary(err));
    process.exit(2);
  });
