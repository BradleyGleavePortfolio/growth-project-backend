/**
 * Clinic C01: placement of prisma/migrations/20270205000000_invite_grant_bindings.
 *
 * The migration was written as 20270125000000_invite_grant_bindings, which
 * shared its timestamp with #625's 20270125000000_restore_schema_declared_objects
 * and sorted before it and before #622's 20270203000000_ai_processing_consent_ledger.
 * Prisma applies migrations in directory-name order, so a fresh chain (CI's
 * migration-dry-run and schema-parity jobs) and production must see this one
 * after every migration already on main. The SQL itself is unchanged.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'prisma', 'migrations');
const NAME = '20270205000000_invite_grant_bindings';

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => e.name)
    .sort();
}

describe(`${NAME}: placement`, () => {
  it('exists once, and the old 20270125000000_ name is gone', () => {
    const dirs = migrationDirs();
    expect(dirs.filter((d) => d.endsWith('_invite_grant_bindings'))).toEqual([NAME]);
    expect(existsSync(join(MIGRATIONS, '20270125000000_invite_grant_bindings'))).toBe(false);
  });

  it('sorts after the #625 restore and #622 consent-ledger migrations', () => {
    const dirs = migrationDirs();
    const at = dirs.indexOf(NAME);
    expect(at).toBeGreaterThan(dirs.indexOf('20270125000000_restore_schema_declared_objects'));
    expect(at).toBeGreaterThan(dirs.indexOf('20270203000000_ai_processing_consent_ledger'));
    expect(dirs.indexOf('20270125000000_restore_schema_declared_objects')).toBeGreaterThanOrEqual(
      0,
    );
    expect(dirs.indexOf('20270203000000_ai_processing_consent_ledger')).toBeGreaterThanOrEqual(0);
  });

  it('does not share its timestamp prefix with any other migration', () => {
    const prefix = NAME.slice(0, 14);
    expect(migrationDirs().filter((d) => d.startsWith(`${prefix}_`))).toEqual([NAME]);
  });

  it('keeps its reversible counterpart, which names the new directory', () => {
    const down = readFileSync(join(MIGRATIONS, NAME, 'down.sql'), 'utf8');
    expect(down.split('\n')[0]).toContain(NAME);
    expect(down).toContain('DROP TYPE IF EXISTS "InviteGrantMode";');
  });
});
