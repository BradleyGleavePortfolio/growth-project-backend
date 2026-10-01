// Regression tests for the blocking schema-parity gate
// (scripts/ci/schema-parity-gate.js, .github/workflows/schema-parity.yml).
//
// The gate exists because fields added to prisma/schema.prisma without a
// migration reached production (every User read failed with
// "column User.archived_at does not exist") while the old parity job was
// informational, grandfathered and path-filtered. These tests pin the fail-closed
// behaviour: a missing table/enum/column never passes, new drift never passes, the
// baseline only shrinks, bad input fails, and the workflow wiring cannot quietly
// regress to the old informational job.

import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('../../scripts/ci/schema-parity-gate');

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'ci', 'schema-parity-gate.js');
const BASELINE = join(ROOT, 'prisma', 'schema-parity-baseline.sql');

const EMPTY = '-- This is an empty migration.\n';

// The exact statements `prisma migrate diff --script` printed for the P0 objects
// before 20270125000000_restore_schema_declared_objects existed.
const P0_DRIFT = [
  '-- CreateEnum',
  "CREATE TYPE \"ListType\" AS ENUM ('grocery', 'shopping');",
  '',
  '-- AlterTable',
  'ALTER TABLE "User" ADD COLUMN     "archived_at" TIMESTAMP(3);',
  '',
  '-- AlterTable',
  'ALTER TABLE "NotificationPreferences" ADD COLUMN     "daily_checkin_enabled" BOOLEAN NOT NULL DEFAULT true,',
  'ADD COLUMN     "new_client_alerts" BOOLEAN NOT NULL DEFAULT true;',
  '',
  '-- CreateTable',
  'CREATE TABLE "SavedRecipe" (',
  '    "id" TEXT NOT NULL,',
  '    "user_id" TEXT NOT NULL,',
  '    "recipe_id" TEXT NOT NULL,',
  '    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
  '',
  '    CONSTRAINT "SavedRecipe_pkey" PRIMARY KEY ("id")',
  ');',
  '',
].join('\n');

const PRE_EXISTING = [
  '-- DropForeignKey',
  'ALTER TABLE "Applicant" DROP CONSTRAINT "Applicant_user_id_fkey";',
  '',
  '-- AlterTable',
  'ALTER TABLE "CoachBrief" ALTER COLUMN "updated_at" DROP DEFAULT;',
  '',
  '-- RenameIndex',
  'ALTER INDEX "UserBlock_pair_key" RENAME TO "UserBlock_blocker_id_blocked_id_key";',
  '',
].join('\n');

describe('parseItems', () => {
  it('drops comment lines, collapses whitespace and sorts', () => {
    expect(gate.parseItems(EMPTY)).toEqual([]);
    expect(gate.parseItems('-- a\nSELECT   1;\n\n-- b\nALTER INDEX "a"\n RENAME TO "b";')).toEqual([
      'ALTER INDEX "a" RENAME TO "b"',
      'SELECT 1',
    ]);
  });

  it('splits ALTER TABLE into one item per top-level clause, never inside parens or quotes', () => {
    const sql =
      'ALTER TABLE "T" ADD CONSTRAINT "fk" FOREIGN KEY ("a", "b") REFERENCES "U"("x", "y") ON DELETE CASCADE,\n' +
      "ALTER COLUMN \"c\" SET DEFAULT 'a,b;c',\nALTER COLUMN \"d\" SET DATA TYPE DECIMAL(10,2);";
    expect(gate.parseItems(sql)).toEqual([
      'ALTER TABLE "T" ADD CONSTRAINT "fk" FOREIGN KEY ("a", "b") REFERENCES "U"("x", "y") ON DELETE CASCADE',
      "ALTER TABLE \"T\" ALTER COLUMN \"c\" SET DEFAULT 'a,b;c'",
      'ALTER TABLE "T" ALTER COLUMN "d" SET DATA TYPE DECIMAL(10,2)',
    ]);
  });

  it('is insensitive to statement order and duplicate items', () => {
    const a = gate.parseItems(PRE_EXISTING);
    const reordered = PRE_EXISTING.split('\n\n').reverse().join('\n\n');
    expect(gate.parseItems(reordered)).toEqual(a);
    expect(gate.parseItems(`${PRE_EXISTING}\n${PRE_EXISTING}`)).toEqual(a);
  });
});

describe('missingObjectKind', () => {
  it.each([
    ['CREATE TABLE "Recipe" ( "id" TEXT NOT NULL )', 'table'],
    ["CREATE TYPE \"ListType\" AS ENUM ('grocery', 'shopping')", 'enum'],
    ["ALTER TYPE \"Role\" ADD VALUE 'sub_coach'", 'enum value'],
    ['ALTER TABLE "User" ADD COLUMN "archived_at" TIMESTAMP(3)', 'column'],
    ['ALTER TABLE "User" DROP COLUMN "search_tsv"', null],
    ['CREATE UNIQUE INDEX "X_key" ON "X"("a")', null],
    ['ALTER INDEX "a" RENAME TO "b"', null],
  ])('%s -> %s', (item, kind) => {
    expect(gate.missingObjectKind(item)).toBe(kind);
  });
});

describe('evaluate', () => {
  it('passes at full parity with an empty baseline', () => {
    const r = gate.evaluate(EMPTY, gate.formatBaseline([]));
    expect(r.ok).toBe(true);
    expect(r.current).toEqual([]);
  });

  it('fails on the P0 class (missing enum, columns, table) even when every item is baselined', () => {
    const baselined = gate.formatBaseline(gate.parseItems(P0_DRIFT));
    const r = gate.evaluate(P0_DRIFT, baselined);
    expect(r.ok).toBe(false);
    expect(r.newDrift).toEqual([]);
    expect(r.missingObjects.map((m: { kind: string }) => m.kind).sort()).toEqual([
      'column',
      'column',
      'column',
      'enum',
      'table',
    ]);
    expect(r.baselinedMissingObjects).toHaveLength(5);
  });

  it('passes when the drift equals the baseline exactly (pre-existing, non-missing items)', () => {
    const r = gate.evaluate(PRE_EXISTING, gate.formatBaseline(gate.parseItems(PRE_EXISTING)));
    expect(r.ok).toBe(true);
    expect(r.current).toHaveLength(3);
  });

  it('fails on any drift item not in the baseline', () => {
    const extra = `${PRE_EXISTING}\nALTER TABLE "CoachProfile" DROP CONSTRAINT "CoachProfile_user_id_fkey";\n`;
    const r = gate.evaluate(extra, gate.formatBaseline(gate.parseItems(PRE_EXISTING)));
    expect(r.ok).toBe(false);
    expect(r.newDrift).toEqual(['ALTER TABLE "CoachProfile" DROP CONSTRAINT "CoachProfile_user_id_fkey"']);
    expect(r.missingObjects).toEqual([]);
  });

  it('fails when the baseline lists drift that no longer exists (shrink-only)', () => {
    const fixedOne = PRE_EXISTING.replace(
      'ALTER TABLE "CoachBrief" ALTER COLUMN "updated_at" DROP DEFAULT;',
      '',
    );
    const r = gate.evaluate(fixedOne, gate.formatBaseline(gate.parseItems(PRE_EXISTING)));
    expect(r.ok).toBe(false);
    expect(r.resolved).toEqual(['ALTER TABLE "CoachBrief" ALTER COLUMN "updated_at" DROP DEFAULT']);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'schema-parity-gate-'));
  const file = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });

  it('exits 0 at parity, 1 on drift, and prints errors as GitHub annotations', () => {
    const baseline = file('baseline.sql', gate.formatBaseline([]));
    expect(run('--drift', file('empty.sql', EMPTY), '--baseline', baseline).status).toBe(0);
    const bad = run('--drift', file('p0.sql', P0_DRIFT), '--baseline', baseline);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('::error::schema-parity: schema.prisma declares a column that no migration creates');
    expect(bad.stderr).toContain('"archived_at"');
  });

  it('fails closed (exit 2) on a missing or empty input and on unknown arguments', () => {
    const baseline = file('baseline2.sql', gate.formatBaseline([]));
    expect(run('--drift', join(dir, 'nope.sql'), '--baseline', baseline).status).toBe(2);
    expect(run('--drift', file('blank.sql', '  \n'), '--baseline', baseline).status).toBe(2);
    expect(run('--drift', file('e2.sql', EMPTY), '--baseline', join(dir, 'nope.sql')).status).toBe(2);
    expect(run('--drift', file('e3.sql', EMPTY)).status).toBe(2);
    expect(run('--drift', file('e4.sql', EMPTY), '--baseline', baseline, '--force').status).toBe(2);
  });

  it('--print-baseline output round-trips to a passing gate for non-missing drift', () => {
    const drift = file('pre.sql', PRE_EXISTING);
    const printed = run('--drift', drift, '--print-baseline');
    expect(printed.status).toBe(0);
    const baseline = file('printed.sql', printed.stdout);
    expect(run('--drift', drift, '--baseline', baseline).status).toBe(0);
  });
});

describe('committed baseline and workflow wiring', () => {
  it('the committed baseline parses and lists no missing table, enum or column', () => {
    const text = readFileSync(BASELINE, 'utf8');
    const items = gate.parseItems(text);
    expect(items.filter((i: string) => gate.missingObjectKind(i) !== null)).toEqual([]);
    for (const p0 of ['"archived_at"', '"ListItem"', '"Recipe"', '"SavedRecipe"', '"UserPreferences"', '"ListType"']) {
      expect(items.filter((i: string) => i.includes(p0))).toEqual([]);
    }
  });

  it('schema-parity.yml runs on every PR, cannot be skipped by a path filter and fails closed', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'schema-parity.yml'), 'utf8');
    const onBlock = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
    expect(onBlock).toMatch(/\n {2}pull_request:\n/);
    expect(onBlock).not.toMatch(/paths/);
    expect(onBlock).not.toMatch(/branches-ignore/);
    expect(wf).toContain('name: Schema parity (migrations match schema.prisma)');
    expect(wf).not.toMatch(/continue-on-error/);
    expect(wf).not.toMatch(/\|\|\s*true/);
    expect(wf).toContain('npx prisma migrate deploy');
    expect(wf).toContain('--to-schema-datamodel prisma/schema.prisma');
    expect(wf).toContain(
      'node scripts/ci/schema-parity-gate.js --drift schema_parity_drift.sql --baseline prisma/schema-parity-baseline.sql',
    );
  });

  it('the old informational parity job is gone from migration-dry-run.yml', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'migration-dry-run.yml'), 'utf8');
    expect(wf).not.toMatch(/^ {2}migrations-schema-parity:/m);
    expect(wf).not.toContain('deferred to BL-MIGRATION-REBASELINE)');
  });
});
