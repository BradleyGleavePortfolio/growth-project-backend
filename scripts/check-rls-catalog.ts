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
 *   - Compares actual state to EXPECTED_STATE (below) and prints one
 *     explicit PASS/GAP verdict line per table, plus a summary.
 *   - Always rolls the transaction back (belt-and-suspenders on top of
 *     READ ONLY; there is nothing to commit).
 *   - Exits 1 if any table's actual state does not match its expected
 *     state, so the invocation's own exit code is a second, independent
 *     signal beyond the printed verdict. Exits 2 on any query/connection
 *     error (fails closed — never reports PASS on a failed read).
 *
 * What it deliberately does NOT do:
 *   - No DDL, no DML, no `SET ROLE`, no policy creation/repair. This is a
 *     read of the catalog, nothing else.
 *   - No default DATABASE_URL. The caller must supply one explicitly, so
 *     this can never accidentally fall through to a production connection
 *     string left in the shell environment from something else.
 *   - No retry/loop/schedule. One run, one report, exit.
 *
 * EXPECTED_STATE below encodes what the readiness doc (S12_PILOT_READINESS
 * §2b row S12-B5) says these tables are FOR: WorkoutSession, WeightLog and
 * Habit are person-owned health/fitness data with no RLS migration on file
 * (expected GAP, pending S8-D3 per the readiness doc §4 item 13); CheckIn
 * and ClientWorkoutAssignment* have RLS migrations on file and are expected
 * enabled+forced with at least one policy (expected OK). The verdict is
 * always computed from the *actual* catalog read, never assumed — this
 * table only supplies what "expected" means so a real out-of-band change
 * (in either direction) shows up as a mismatch instead of silent agreement.
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
 * role is sufficient since the script issues no writes; record stdout in
 * evidence alongside the doc that decision closes.
 *
 * Exit codes: 0 = every table matches its expected state. 1 = at least one
 * table's actual state does not match. 2 = could not complete the read
 * (connection/query error) — never conflated with "0 gaps found".
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
  pass: boolean;
  reason: string;
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
      pass: false,
      reason: `table not found in pg_class for schema 'public' — cannot verify (expected: ${expected.note})`,
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

  return {
    table,
    found: true,
    actual,
    expected,
    policies,
    pass: mismatches.length === 0,
    reason:
      mismatches.length === 0
        ? `matches expected state (${expected.note})`
        : `MISMATCH vs expected (${expected.note}): ${mismatches.join('; ')}`,
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

      for (const v of verdicts) {
        const status = v.pass ? 'OK  ' : 'GAP ';
        report(
          `[${status}] ${v.table}: relrowsecurity=${v.actual.relrowsecurity} ` +
            `relforcerowsecurity=${v.actual.relforcerowsecurity} policies=${v.actual.policyCount}`,
        );
        report(`        ${v.reason}`);
        if (v.policies.length > 0) {
          for (const p of v.policies) {
            report(`        policy: ${p.policyname} (${p.cmd}, roles=${p.roles ?? '{}'})`);
          }
        }
        if (!v.pass) exitCode = 1;
      }

      report('');
      const gapCount = verdicts.filter((v) => !v.pass).length;
      report(
        `Summary: ${verdicts.length - gapCount}/${verdicts.length} tables match expected state, ${gapCount} mismatch(es).`,
      );

      // Nothing was written; roll back explicitly rather than commit, so
      // the transaction's write-intent is unambiguous even though READ
      // ONLY already forbids writes.
      throw new ReadOnlyRollback();
    });
  } catch (err) {
    if (!(err instanceof ReadOnlyRollback)) {
      console.error('[check-rls-catalog] query/connection error — failing closed (exit 2).');
      console.error(err);
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

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[check-rls-catalog] unexpected top-level error.');
    console.error(err);
    process.exit(2);
  });
