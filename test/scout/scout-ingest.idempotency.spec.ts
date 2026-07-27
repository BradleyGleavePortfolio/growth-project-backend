import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * R-IDEMP-1 structural idempotency guard, RESTATED by 20261224000100.
 *
 * The idempotency contract for scout ingest is: the UNIQUE key
 * (coach_id, intent_id, entity_type, source_id) makes "the coach saw entity X
 * OF TYPE T during crawl session Y" a single row.
 *
 * Two independent invariants, and this file pins BOTH so neither can regress
 * into the other:
 *
 *   captured_at is EXCLUDED. A coach re-observes the same source entity over
 *   time and each re-observation within an intent must collapse to a no-op
 *   replay (ON CONFLICT DO NOTHING), never a new row per timestamp. This was
 *   the original R-IDEMP-1 (2026-07-08) and it still holds.
 *
 *   entity_type is INCLUDED. source_id is only unique within a type at the
 *   source, so omitting entity_type made the second envelope of a crawl session
 *   collide with the first and disappear silently. That was the P0 this
 *   migration fixes; this file is what stops it coming back.
 *
 * This is a MECHANICAL guard: it parses the two sources of truth (the Prisma
 * model and the raw migration DDL) and asserts the key columns and their order.
 * The behavioural proof against real Postgres — that two entity_types sharing a
 * source_id both persist and that a true 4-tuple replay is a no-op — lives in
 * test/rls-scout-ingest-uniqueness.spec.ts, which needs a live DB.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'prisma', 'schema.prisma');

/**
 * The ORIGINAL create migration. Shipped and therefore never edited
 * (ENGINEERING_RULES §2, append-only) — it still declares the narrow 3-column
 * key, and that is correct as historical record.
 */
const CREATE_MIGRATION_PATH = join(
  REPO_ROOT,
  'prisma',
  'migrations',
  '20261222000000_scout_ingest_entity',
  'migration.sql',
);

/** The correction. This is the migration that defines the key in force. */
const WIDEN_MIGRATION_DIR = join(
  REPO_ROOT,
  'prisma',
  'migrations',
  '20261224000100_scout_ingest_entity_type_uniqueness',
);

const EXPECTED_KEY_COLUMNS = ['coach_id', 'intent_id', 'entity_type', 'source_id'];
const SUPERSEDED_KEY_COLUMNS = ['coach_id', 'intent_id', 'source_id'];

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
  const widenUp = readFileSync(join(WIDEN_MIGRATION_DIR, 'migration.sql'), 'utf8');
  const widenDown = readFileSync(join(WIDEN_MIGRATION_DIR, 'down.sql'), 'utf8');

  describe('Prisma model', () => {
    it('declares the composite @@unique on exactly the four key columns in order', () => {
      const unique = model.match(/@@unique\(\[([^\]]+)\]\)/);
      expect(unique).not.toBeNull();
      const cols = (unique as RegExpMatchArray)[1].split(',').map((c) => c.trim());
      expect(cols).toEqual(EXPECTED_KEY_COLUMNS);
    });

    it('includes entity_type in the key — this is the P0 silent-loss fix', () => {
      const unique = model.match(/@@unique\(\[([^\]]+)\]\)/) as RegExpMatchArray;
      expect(unique[1]).toContain('entity_type');
    });

    it('does NOT include captured_at in the key (captured_at is a value)', () => {
      const unique = model.match(/@@unique\(\[([^\]]+)\]\)/) as RegExpMatchArray;
      expect(unique[1]).not.toContain('captured_at');
    });

    it('keeps captured_at nullable and outside the key', () => {
      expect(model).toMatch(/captured_at\s+DateTime\?/);
    });
  });

  describe('migration DDL (the widening — 20261224000100)', () => {
    it('creates the four-column UNIQUE INDEX in key order', () => {
      const cols = uniqueIndexColumns(
        widenUp,
        'ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key',
      );
      expect(cols).toEqual(EXPECTED_KEY_COLUMNS);
    });

    it('drops the superseded three-column index', () => {
      expect(widenUp).toMatch(
        /DROP INDEX IF EXISTS "ScoutIngestEntity_coach_id_intent_id_source_id_key"/,
      );
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
      const cols = uniqueIndexColumns(
        widenDown,
        'ScoutIngestEntity_coach_id_intent_id_source_id_key',
      );
      expect(cols).toEqual(SUPERSEDED_KEY_COLUMNS);
    });

    it('drops the widened index so the reverse is complete, not additive', () => {
      expect(widenDown).toMatch(
        /DROP INDEX IF EXISTS "ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key"/,
      );
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
    const createMigration = readFileSync(CREATE_MIGRATION_PATH, 'utf8');

    it('still declares its original three-column key as historical record', () => {
      const cols = uniqueIndexColumns(
        createMigration,
        'ScoutIngestEntity_coach_id_intent_id_source_id_key',
      );
      expect(cols).toEqual(SUPERSEDED_KEY_COLUMNS);
    });

    it('does not contain the widened index — the correction is append-only', () => {
      expect(createMigration).not.toContain(
        'ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key',
      );
    });
  });
});
