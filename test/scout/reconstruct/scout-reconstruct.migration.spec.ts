import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * IMPORTER-F structural guard (schema + migration DDL).
 *
 * There is no live-DB harness for scout in this repo, so — mirroring
 * scout-ingest.idempotency.spec.ts — this is a MECHANICAL guard that parses the
 * two sources of truth (the Prisma model and the raw migration DDL) and pins the
 * D2-decided invariants so a future refactor cannot silently break them:
 *
 *   - idempotency keys: Person on (coach_id, source_platform, source_person_id);
 *     ledger on (coach_id, intent_id, entity_type, source_id).
 *   - D2 identity: NO email column, NO auth/credential column on Person; identity
 *     is the opaque id; email is never a key.
 *   - RLS posture: both tables ENABLE + FORCE RLS, service_role PERMISSIVE bypass,
 *     anon + authenticated RESTRICTIVE deny-all (no cross-tenant oracle).
 *   - reversibility: a companion down.sql drops exactly what migration.sql adds.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'prisma', 'schema.prisma');
const MIGRATION_DIR = join(
  REPO_ROOT,
  'prisma',
  'migrations',
  '20261223000000_scout_reconstruction',
);
const MIGRATION_PATH = join(MIGRATION_DIR, 'migration.sql');
const DOWN_PATH = join(MIGRATION_DIR, 'down.sql');

function modelBlock(schema: string, name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`${name} model not found in schema.prisma`);
  return match[0];
}

describe('IMPORTER-F schema + migration structural guard', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const migration = readFileSync(MIGRATION_PATH, 'utf8');
  const down = readFileSync(DOWN_PATH, 'utf8');
  const person = modelBlock(schema, 'Person');
  const ledger = modelBlock(schema, 'ScoutReconstructionLedger');

  describe('Person roster model (D2 identity)', () => {
    it('keys the external_ref on (coach_id, source_platform, source_person_id)', () => {
      const unique = person.match(/@@unique\(\[([^\]]+)\]\)/) as RegExpMatchArray;
      const cols = unique[1].split(',').map((c) => c.trim());
      expect(cols).toEqual(['coach_id', 'source_platform', 'source_person_id']);
    });

    it('has NO email column — email is never stored or keyed (D2)', () => {
      expect(person.toLowerCase()).not.toContain('email');
    });

    it('mints NO auth/credential column at import (invite-pending, non-login)', () => {
      for (const banned of [
        'password',
        'credential',
        'auth_principal',
        'authPrincipal',
        'user_id',
      ]) {
        expect(person.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    });

    it('defaults new roster records to the InvitePending state', () => {
      expect(person).toMatch(/state\s+PersonState\s+@default\(InvitePending\)/);
    });

    it('declares the PersonState enum with the D2 lifecycle states', () => {
      const en = schema.match(/enum PersonState \{[\s\S]*?\}/) as RegExpMatchArray;
      for (const s of ['InvitePending', 'Invited', 'Claimed', 'Suspended', 'Deleted']) {
        expect(en[0]).toContain(s);
      }
    });

    it('creates the external_ref UNIQUE INDEX in the migration DDL', () => {
      const ddl = migration.match(
        /CREATE UNIQUE INDEX[^;]*"Person"[^;]*\(([^)]*)\)/,
      ) as RegExpMatchArray;
      const cols = ddl[1].split(',').map((c) => c.trim().replace(/"/g, ''));
      expect(cols).toEqual(['coach_id', 'source_platform', 'source_person_id']);
    });
  });

  describe('ScoutReconstructionLedger (idempotent reconciliation)', () => {
    it('keys the ledger on (coach_id, intent_id, entity_type, source_id)', () => {
      const unique = ledger.match(/@@unique\(\[([^\]]+)\]\)/) as RegExpMatchArray;
      const cols = unique[1].split(',').map((c) => c.trim());
      expect(cols).toEqual(['coach_id', 'intent_id', 'entity_type', 'source_id']);
    });

    it('carries an optional target_id and reason for non-reconstructed outcomes', () => {
      expect(ledger).toMatch(/target_id\s+String\?/);
      expect(ledger).toMatch(/reason\s+String\?/);
    });

    it('creates the ledger UNIQUE INDEX in the migration DDL', () => {
      const ddl = migration.match(
        /CREATE UNIQUE INDEX[^;]*"ScoutReconstructionLedger"[^;]*\(([^)]*)\)/,
      ) as RegExpMatchArray;
      const cols = ddl[1].split(',').map((c) => c.trim().replace(/"/g, ''));
      expect(cols).toEqual(['coach_id', 'intent_id', 'entity_type', 'source_id']);
    });
  });

  describe('RLS posture (fail-closed, service_role only)', () => {
    for (const table of ['Person', 'ScoutReconstructionLedger']) {
      it(`ENABLEs and FORCEs row level security on ${table}`, () => {
        expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
        expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      });

      it(`grants a PERMISSIVE service_role bypass on ${table}`, () => {
        const re = new RegExp(
          `CREATE POLICY[^;]*ON "${table}" AS PERMISSIVE FOR ALL TO service_role USING \\(true\\) WITH CHECK \\(true\\)`,
        );
        expect(migration).toMatch(re);
      });

      it(`denies anon and authenticated via RESTRICTIVE deny-all on ${table}`, () => {
        for (const role of ['anon', 'authenticated']) {
          const re = new RegExp(
            `CREATE POLICY[^;]*ON "${table}" AS RESTRICTIVE FOR ALL TO ${role} USING \\(false\\) WITH CHECK \\(false\\)`,
          );
          expect(migration).toMatch(re);
        }
      });
    }
  });

  describe('reversibility (R82/R106)', () => {
    it('wraps the migration in a single transaction', () => {
      expect(migration).toContain('BEGIN;');
      expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    });

    it('drops both tables and the enum in down.sql', () => {
      expect(down).toMatch(/DROP TABLE IF EXISTS "ScoutReconstructionLedger"/);
      expect(down).toMatch(/DROP TABLE IF EXISTS "Person"/);
      expect(down).toMatch(/DROP TYPE IF EXISTS "PersonState"/);
    });
  });
});
