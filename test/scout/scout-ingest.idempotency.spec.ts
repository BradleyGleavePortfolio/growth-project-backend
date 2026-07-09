import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * R-IDEMP-1 (2026-07-08) structural idempotency guard.
 *
 * The idempotency contract for scout ingest is: the UNIQUE key
 * (coach_id, intent_id, source_id) makes "the coach saw entity X during crawl
 * session Y" a single row. captured_at is a VALUE, not part of the key — a
 * coach re-observes the same source entity over time, and each re-observation
 * within an intent must collapse to a no-op replay (ON CONFLICT DO NOTHING),
 * never a new row per timestamp. If captured_at were in the key, an extension
 * retry with a fresh timestamp would violate replay-safety by inserting a
 * duplicate. A different intent_id is a new observation series and inserts.
 *
 * There is no live-DB harness for scout in this repo, so — per the fixer brief
 * — this is a MECHANICAL guard rather than a Prisma-against-live-schema test.
 * It parses the source of truth in two places (the Prisma model and the raw
 * migration DDL) and asserts the key columns and their order, and that
 * captured_at is excluded. This pins the key so a future refactor toward the
 * (sourceId, capturedAt) shape the round-1 auditor suggested cannot land
 * silently — it would fail here with the reasoning above.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'prisma', 'schema.prisma');
const MIGRATION_PATH = join(
  REPO_ROOT,
  'prisma',
  'migrations',
  '20261222000000_scout_ingest_entity',
  'migration.sql',
);

const EXPECTED_KEY_COLUMNS = ['coach_id', 'intent_id', 'source_id'];

function scoutModelBlock(schema: string): string {
  const match = schema.match(/model ScoutIngestEntity \{[\s\S]*?\n\}/);
  if (!match) throw new Error('ScoutIngestEntity model not found in schema.prisma');
  return match[0];
}

describe('R-IDEMP-1 idempotency key is (coach_id, intent_id, source_id)', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const migration = readFileSync(MIGRATION_PATH, 'utf8');
  const model = scoutModelBlock(schema);

  it('declares the composite @@unique on exactly the three key columns in order', () => {
    const unique = model.match(/@@unique\(\[([^\]]+)\]\)/);
    expect(unique).not.toBeNull();
    const cols = (unique as RegExpMatchArray)[1].split(',').map((c) => c.trim());
    expect(cols).toEqual(EXPECTED_KEY_COLUMNS);
  });

  it('does NOT include captured_at in the unique key (captured_at is a value)', () => {
    const unique = model.match(/@@unique\(\[([^\]]+)\]\)/) as RegExpMatchArray;
    expect(unique[1]).not.toContain('captured_at');
  });

  it('keeps captured_at nullable and outside the key in the model', () => {
    expect(model).toMatch(/captured_at\s+DateTime\?/);
  });

  it('creates a UNIQUE INDEX on the three key columns in the migration DDL', () => {
    const ddl = migration.match(/CREATE UNIQUE INDEX[^;]*ScoutIngestEntity[^;]*\(([^)]*)\)/);
    expect(ddl).not.toBeNull();
    const cols = (ddl as RegExpMatchArray)[1].split(',').map((c) => c.trim().replace(/"/g, ''));
    expect(cols).toEqual(EXPECTED_KEY_COLUMNS);
  });

  it('does not put captured_at into any UNIQUE INDEX in the migration DDL', () => {
    const uniqueIndexLines = migration
      .split('\n')
      .filter((line) => line.includes('CREATE UNIQUE INDEX'));
    for (const line of uniqueIndexLines) {
      expect(line).not.toContain('captured_at');
    }
  });

  it('documents the R-IDEMP-1 reasoning in the migration header', () => {
    expect(migration).toContain('R-IDEMP-1');
    expect(migration.toLowerCase()).toContain('replay');
  });
});
