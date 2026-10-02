/**
 * B-RECIPES: static checks for
 * prisma/migrations/20270204000000_recipe_private_by_default.
 *
 * The real-Postgres proof is CI: migration-dry-run.yml applies the chain and
 * proves down/forward schema identity, and schema-parity.yml diffs the applied
 * chain against schema.prisma (so DEFAULT false must match @default(false)).
 * These checks pin what those jobs cannot see cheaply: the file is
 * transactional and bounded, touches only "Recipe"."is_public", flips rows
 * only towards private, asserts its own result, and down.sql never re-publishes.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const NAME = '20270204000000_recipe_private_by_default';
const DIR = join(ROOT, 'prisma', 'migrations', NAME);
const SQL = readFileSync(join(DIR, 'migration.sql'), 'utf8');
const DOWN = readFileSync(join(DIR, 'down.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

/** SQL with `--` comment lines removed, so header prose never satisfies an assertion. */
function code(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
}

describe(`${NAME}: placement and transaction`, () => {
  it('sorts after every migration already on main, including #625 and #622', () => {
    const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
    expect(dirs).toContain(NAME);
    expect(NAME > '20270125000000_restore_schema_declared_objects').toBe(true);
    expect(NAME > '20270203000000_ai_processing_consent_ledger').toBe(true);
    expect(dirs.filter((d) => d.startsWith('20270204000000_'))).toEqual([NAME]);
  });

  it('runs in one transaction with bounded lock and statement time', () => {
    const c = code(SQL).trim();
    expect(c.startsWith('BEGIN;')).toBe(true);
    expect(c.endsWith('COMMIT;')).toBe(true);
    expect(c).toContain("SET LOCAL lock_timeout = '5s';");
    expect(c).toContain("SET LOCAL statement_timeout = '30s';");
    // A session-level SET (unquoted GUC name) would leak into later migrations;
    // the UPDATE's `SET "is_public" = ...` column list is not a GUC.
    expect(c).not.toMatch(/^\s*SET (?!LOCAL)[a-z_.]+\s*(=|TO\b)/im);
  });
});

describe(`${NAME}: scope`, () => {
  it('changes only the "Recipe"."is_public" default, to false', () => {
    const c = code(SQL);
    const alters = [...c.matchAll(/ALTER TABLE[^;]*;/g)].map((m) => m[0]);
    expect(alters).toEqual(['ALTER TABLE "Recipe" ALTER COLUMN "is_public" SET DEFAULT false;']);
  });

  it('updates rows only towards private, and only "is_public" plus "updated_at"', () => {
    const c = code(SQL);
    const updates = [...c.matchAll(/UPDATE\s+"(\w+)"\s+SET([\s\S]*?)WHERE([\s\S]*?);/g)];
    expect(updates).toHaveLength(1);
    const [, table, set, where] = updates[0];
    expect(table).toBe('Recipe');
    expect(set.replace(/\s+/g, ' ').trim()).toBe(
      '"is_public" = false, "updated_at" = CURRENT_TIMESTAMP',
    );
    expect(where.replace(/\s+/g, ' ').trim()).toBe('"is_public" = true');
  });

  it('has no destructive or inserting statement and creates nothing', () => {
    const c = code(SQL);
    expect(c).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|RENAME|CREATE|GRANT|REVOKE|POLICY)\b/i);
  });

  it('asserts its own result, so a wrong default or a remaining public row rolls the file back', () => {
    const verify = code(SQL).slice(code(SQL).indexOf('DO $verify$'));
    expect(verify).toContain("IF default_expr IS DISTINCT FROM 'false' THEN");
    expect(verify).toContain('IF EXISTS (SELECT 1 FROM "Recipe" WHERE "is_public") THEN');
    expect(verify.match(/RAISE EXCEPTION/g)).toHaveLength(2);
  });
});

describe(`${NAME}: schema.prisma and down.sql agree`, () => {
  it('schema.prisma declares is_public @default(false)', () => {
    const start = SCHEMA.indexOf('\nmodel Recipe {');
    const block = SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
    expect(block).toMatch(/\n\s*is_public\s+Boolean\s+@default\(false\)\s*\n/);
    expect(block).not.toMatch(/@default\(true\)/);
  });

  it('down.sql restores the #625 default only and never makes a row public', () => {
    const c = code(DOWN).trim();
    expect(c).toBe('ALTER TABLE "Recipe" ALTER COLUMN "is_public" SET DEFAULT true;');
    expect(c).not.toMatch(/\bUPDATE\b/i);
  });
});
