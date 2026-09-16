import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * R-IDEMP-1 structural idempotency guard, RESTATED by 20261224000100.
 *
 * UNIQUE (coach_id, intent_id, entity_type, source_id) makes "the coach saw
 * entity X OF TYPE T during crawl session Y" a single row. This file pins BOTH
 * invariants so neither regresses into the other: captured_at EXCLUDED (each
 * re-observation within an intent must collapse to a no-op replay, ON CONFLICT DO
 * NOTHING — the original R-IDEMP-1 of 2026-07-08) and entity_type INCLUDED
 * (source_id is only unique within a type at the source, so omitting it made the
 * second envelope of a crawl session collide and disappear silently: the P0).
 *
 * MECHANICAL guard over both sources of truth (Prisma model, migration DDL); the
 * behavioural proof is test/rls-scout-ingest-uniqueness.spec.ts.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'prisma', 'schema.prisma');

const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
// The shipped create migration is never edited (ENGINEERING_RULES §2), so it
// still declares the narrow key; the widening below is the key in force.
const CREATE_DIR = join(MIGRATIONS, '20261222000000_scout_ingest_entity');
const WIDEN_DIR = join(MIGRATIONS, '20261224000100_scout_ingest_entity_type_uniqueness');

const EXPECTED_KEY_COLUMNS = [
  'coach_id',
  'intent_id',
  'entity_type',
  'source_platform',
  'source_id',
];
const SUPERSEDED_KEY_COLUMNS = ['coach_id', 'intent_id', 'source_id'];
const WIDE_KEY = 'ScoutIngestEntity_identity_key';
const NARROW_KEY = 'ScoutIngestEntity_coach_id_intent_id_source_id_key';

function scoutModelBlock(schema: string): string {
  const match = schema.match(/model ScoutIngestEntity \{[\s\S]*?\n\}/);
  if (!match) throw new Error('ScoutIngestEntity model not found in schema.prisma');
  return match[0];
}

function uniqueIndexColumns(ddl: string, indexName: string): string[] {
  const re = new RegExp(`CREATE UNIQUE INDEX\\s+"${indexName}"[^(]*\\(([^)]*)\\)`);
  const match = ddl.match(re);
  if (!match) throw new Error(`UNIQUE INDEX ${indexName} not found`);
  return match[1].split(',').map((c) => c.trim().replace(/"/g, ''));
}

describe('R-IDEMP-1 — idempotency key is (coach_id, intent_id, entity_type, source_id)', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const model = scoutModelBlock(schema);
  const uniqueCols = (model.match(/@@unique\(\[([^\]]+)\]/) as RegExpMatchArray | null)?.[1]
    .split(',')
    .map((c) => c.trim());
  const widenUp = readFileSync(join(WIDEN_DIR, 'migration.sql'), 'utf8');
  const widenDown = readFileSync(join(WIDEN_DIR, 'down.sql'), 'utf8');

  describe('Prisma model', () => {
    it('declares the composite @@unique on exactly the five key columns in order', () => {
      expect(uniqueCols).toEqual(EXPECTED_KEY_COLUMNS);
    });

    it('includes entity_type in the key — this is the P0 silent-loss fix', () => {
      expect(uniqueCols).toContain('entity_type');
    });

    it('does NOT include captured_at in the key (captured_at is a value)', () => {
      expect(uniqueCols).not.toContain('captured_at');
    });

    it('keeps captured_at nullable and outside the key', () => {
      expect(model).toMatch(/captured_at\s+DateTime\?/);
    });
  });

  describe('migration DDL (the widening — 20261224000100)', () => {
    it('creates the five-column UNIQUE INDEX in key order', () => {
      expect(uniqueIndexColumns(widenUp, WIDE_KEY)).toEqual(EXPECTED_KEY_COLUMNS);
    });

    it('drops the superseded three-column index', () => {
      expect(widenUp).toContain(`DROP INDEX public."${NARROW_KEY}"`);
    });

    it('creates the widened index BEFORE dropping the narrow one', () => {
      const createAt = widenUp.indexOf('CREATE UNIQUE INDEX');
      const dropAt = widenUp.indexOf('DROP INDEX');
      expect(createAt).toBeGreaterThan(-1);
      expect(dropAt).toBeGreaterThan(createAt);
    });

    it('puts captured_at into no UNIQUE INDEX', () => {
      for (const line of widenUp.split('\n').filter((l) => l.includes('CREATE UNIQUE INDEX'))) {
        expect(line).not.toContain('captured_at');
      }
    });

    it('re-asserts the service_role-only RLS posture (ENABLE + FORCE + deny-all)', () => {
      expect(widenUp).toContain('ENABLE ROW LEVEL SECURITY');
      expect(widenUp).toContain('FORCE ROW LEVEL SECURITY');
      expect(widenUp).toMatch(/AS RESTRICTIVE FOR ALL TO anon USING \(false\)/);
      expect(widenUp).toMatch(/AS RESTRICTIVE FOR ALL TO authenticated USING \(false\)/);
      expect(widenUp).toMatch(/AS PERMISSIVE FOR ALL TO service_role/);
    });

    it('documents the restated R-IDEMP-1 reasoning and the silent-loss mechanism', () => {
      expect(widenUp).toContain('R-IDEMP-1');
      expect(widenUp).toContain('ON CONFLICT DO NOTHING');
      expect(widenUp.toLowerCase()).toContain('silent');
    });
  });

  describe('down.sql (R82/R106 reversibility)', () => {
    it('restores the superseded three-column key', () => {
      expect(uniqueIndexColumns(widenDown, NARROW_KEY)).toEqual(SUPERSEDED_KEY_COLUMNS);
    });

    it('drops the widened index so the reverse is complete, not additive', () => {
      expect(widenDown).toContain(`DROP INDEX public."${WIDE_KEY}"`);
    });

    it('never deletes rows to satisfy the narrowed constraint', () => {
      // Executable SQL only — the header prose deliberately discusses deletion
      // in order to rule it out, so matching the whole file would self-trip.
      const sql = widenDown
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');
      expect(sql).not.toMatch(/\bDELETE\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    });
  });

  describe('the shipped create migration is untouched (ENGINEERING_RULES §2)', () => {
    const createMigration = readFileSync(join(CREATE_DIR, 'migration.sql'), 'utf8');

    it('still declares its original three-column key as historical record', () => {
      expect(uniqueIndexColumns(createMigration, NARROW_KEY)).toEqual(SUPERSEDED_KEY_COLUMNS);
    });

    it('does not contain the widened index — the correction is append-only', () => {
      expect(createMigration).not.toContain(WIDE_KEY);
    });
  });
  it('pins the platform migration identity for BOTH staging and ledger', () => {
    const up = readFileSync(
      join(MIGRATIONS, '20261224000100_scout_ingest_entity_type_uniqueness', 'migration.sql'),
      'utf8',
    );
    for (const table of ['ScoutIngestEntity', 'ScoutReconstructionLedger']) {
      expect(uniqueIndexColumns(up, `${table}_identity_key`)).toEqual(EXPECTED_KEY_COLUMNS);
      expect(up).toContain(`ON public."${table}"`);
    }
  });
});
