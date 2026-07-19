import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * IMPORTER-H structural guard (schema + migration DDL) for the generic canonical
 * reconstructed-entity table.
 *
 * Mirroring scout-reconstruct.migration.spec.ts, this is a MECHANICAL guard that
 * parses the two sources of truth (the Prisma model and the raw migration DDL)
 * and pins the D2-decided invariants for the ONE generic table that every
 * non-person family reconstructs into, so a future refactor cannot silently
 * break them:
 *
 *   - idempotency key: (coach_id, source_platform, entity_type, source_id) — the
 *     tenant-scoped external_ref, parametrized by family.
 *   - D2 identity: NO email column and NO billing/price column; identity is the
 *     opaque source id; the client link and label are soft/PII-minimal.
 *   - RLS posture: ENABLE + FORCE RLS, service_role PERMISSIVE bypass, anon +
 *     authenticated RESTRICTIVE deny-all (no cross-tenant oracle).
 *   - reversibility: a companion down.sql drops exactly what migration.sql adds.
 *   - ordering: dated AFTER the reconstruction migration; additive, no FK.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'prisma', 'schema.prisma');
const MIGRATION_DIR = join(
  REPO_ROOT,
  'prisma',
  'migrations',
  '20261223000300_scout_reconstructed_entity',
);
const RECONSTRUCTION_MIGRATION = '20261223000200_scout_reconstruction';
const MIGRATION_PATH = join(MIGRATION_DIR, 'migration.sql');
const DOWN_PATH = join(MIGRATION_DIR, 'down.sql');
const TABLE = 'ScoutReconstructedEntity';

function modelBlock(schema: string, name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`${name} model not found in schema.prisma`);
  return match[0];
}

describe('IMPORTER-H ScoutReconstructedEntity schema + migration structural guard', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const migration = readFileSync(MIGRATION_PATH, 'utf8');
  const down = readFileSync(DOWN_PATH, 'utf8');
  const entity = modelBlock(schema, TABLE);

  describe('generic canonical entity model (D2 identity, family-parametrized)', () => {
    it('keys the external_ref on (coach_id, source_platform, entity_type, source_id)', () => {
      const unique = entity.match(/@@unique\(\[([^\]]+)\]\)/) as RegExpMatchArray;
      const cols = unique[1].split(',').map((c) => c.trim());
      expect(cols).toEqual(['coach_id', 'source_platform', 'entity_type', 'source_id']);
    });

    it('has NO email column — email is never stored or keyed (D2)', () => {
      expect(entity.toLowerCase()).not.toContain('email');
    });

    it('has NO billing/price column — billing is never reconstructed', () => {
      for (const banned of ['price', 'invoice', 'amount', 'balance', 'cost', 'payment']) {
        expect(entity.toLowerCase()).not.toContain(banned);
      }
    });

    it('mints NO auth/credential column (canonical entity is non-login)', () => {
      for (const banned of ['password', 'credential', 'auth_principal', 'user_id']) {
        expect(entity.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    });

    it('carries an optional soft client link and label', () => {
      expect(entity).toMatch(/client_source_id\s+String\?/);
      expect(entity).toMatch(/label\s+String\?/);
    });

    it('creates the external_ref UNIQUE INDEX in the migration DDL', () => {
      const ddl = migration.match(
        new RegExp(`CREATE UNIQUE INDEX[^;]*"${TABLE}"[^;]*\\(([^)]*)\\)`),
      ) as RegExpMatchArray;
      const cols = ddl[1].split(',').map((c) => c.trim().replace(/"/g, ''));
      expect(cols).toEqual(['coach_id', 'source_platform', 'entity_type', 'source_id']);
    });

    it('creates the (coach_id, entity_type) lookup index in the migration DDL', () => {
      const ddl = migration.match(
        new RegExp(`CREATE INDEX[^;]*"${TABLE}"[^;]*\\(([^)]*)\\)`),
      ) as RegExpMatchArray;
      const cols = ddl[1].split(',').map((c) => c.trim().replace(/"/g, ''));
      expect(cols).toEqual(['coach_id', 'entity_type']);
    });
  });

  describe('RLS posture (fail-closed, service_role only)', () => {
    it(`ENABLEs and FORCEs row level security on ${TABLE}`, () => {
      expect(migration).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;`);
    });

    it(`grants a PERMISSIVE service_role bypass on ${TABLE}`, () => {
      const re = new RegExp(
        `CREATE POLICY[^;]*ON "${TABLE}" AS PERMISSIVE FOR ALL TO service_role USING \\(true\\) WITH CHECK \\(true\\)`,
      );
      expect(migration).toMatch(re);
    });

    it(`denies anon and authenticated via RESTRICTIVE deny-all on ${TABLE}`, () => {
      for (const role of ['anon', 'authenticated']) {
        const re = new RegExp(
          `CREATE POLICY[^;]*ON "${TABLE}" AS RESTRICTIVE FOR ALL TO ${role} USING \\(false\\) WITH CHECK \\(false\\)`,
        );
        expect(migration).toMatch(re);
      }
    });
  });

  describe('migration ordering (applies AFTER scout_reconstruction)', () => {
    it('sorts lexicographically after the reconstruction migration', () => {
      const dir = '20261223000300_scout_reconstructed_entity';
      expect(dir > RECONSTRUCTION_MIGRATION).toBe(true);
    });

    it('declares NO foreign key to Person or any scout table (additive, self-contained)', () => {
      expect(migration).not.toMatch(/REFERENCES\s+"Person"/i);
      expect(migration).not.toMatch(/REFERENCES\s+"Scout/i);
    });
  });

  describe('reversibility (R82/R106)', () => {
    it('wraps the migration in a single transaction', () => {
      expect(migration).toContain('BEGIN;');
      expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    });

    it('drops the table in down.sql', () => {
      expect(down).toMatch(new RegExp(`DROP TABLE IF EXISTS "${TABLE}"`));
    });
  });
});
