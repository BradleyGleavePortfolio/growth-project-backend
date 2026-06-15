/**
 * v3-4 wearable-prompts slice — schema / identity integrity (PR #399 R81, F1).
 *
 * STATIC assertions (no DB): the prisma schema + the F1 follow-up migration must
 * carry the UUID identity convention so the controller's
 * ParseUUIDPipe({ version: '4' }) on :promptId validates REAL runtime ids
 * (Decision 8 (A) — re-number the new lockers to match the building).
 *
 *   - Both community_wearable_prompts(.id) and community_wearable_prompt_sources
 *     (.id) declare `@default(uuid()) @db.Uuid` (cuid() TEXT is gone), and the
 *     child's promptId FK is `@db.Uuid` so the relation column types line up.
 *   - The new migration recreates both tables with UUID ids carrying a
 *     server-side `gen_random_uuid()` default.
 *   - A generated id (asserted via the Prisma client's own @default(uuid())
 *     runtime, which is uuid v4) matches the canonical UUID v4 shape that the
 *     ParseUUIDPipe enforces.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const SCHEMA_PATH = join(__dirname, '..', '..', '..', '..', 'prisma', 'schema.prisma');
const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20261219000000_community_wearable_prompts_uuid_id',
  'migration.sql',
);

// The exact shape NestJS's ParseUUIDPipe({ version: '4' }) accepts.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf('\n}', start);
  return schema.slice(start, end);
}

describe('wearable-prompts schema — UUID identity (F1)', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');

  it('CommunityWearablePrompt.id is @default(uuid()) @db.Uuid (no cuid TEXT id)', () => {
    const block = modelBlock(schema, 'CommunityWearablePrompt');
    expect(block).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/);
    // Guard against a regression back to the cuid() default the audit flagged.
    expect(block).not.toMatch(/@default\(cuid\(\)\)/);
  });

  it('CommunityWearablePromptSource.id + promptId carry the UUID types', () => {
    const block = modelBlock(schema, 'CommunityWearablePromptSource');
    expect(block).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/);
    expect(block).toMatch(/promptId\s+String\s+@db\.Uuid/);
  });
});

describe('wearable-prompts F1 migration — DDL recreates UUID ids', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('declares both ids as UUID with a gen_random_uuid() server default', () => {
    const idLines = sql
      .split('\n')
      .filter((l) => /"id"\s+UUID\s+NOT NULL\s+DEFAULT gen_random_uuid\(\)/.test(l));
    // One per table (prompts + sources).
    expect(idLines).toHaveLength(2);
  });

  it('types the source.promptId FK column as UUID to match the parent id', () => {
    expect(sql).toMatch(/"promptId"\s+UUID\s+NOT NULL/);
  });

  it('does not edit the original cuid migration (forward-only, R77)', () => {
    // The drop+recreate targets only this slice's two tables.
    expect(sql).toContain('DROP TABLE IF EXISTS "community_wearable_prompt_sources"');
    expect(sql).toContain('DROP TABLE IF EXISTS "community_wearable_prompts"');
  });

  // ── PR #405 re-audit N1: non-empty-environment preflight guard ──────────────
  // The migration documents that a non-empty environment must take the #404
  // backfill path; this group pins that the SQL actually ENFORCES it (an
  // executable RAISE EXCEPTION guard ahead of either destructive DROP) instead
  // of silently dropping rows.

  it('carries an executable preflight DO-block that RAISEs on non-empty tables', () => {
    // A `DO $$ ... RAISE EXCEPTION ... END $$;` block must exist.
    expect(sql).toMatch(/DO\s+\$\$/);
    expect(sql).toMatch(/RAISE\s+EXCEPTION/);
    // It must guard BOTH tables, and the abort message must redirect to #404.
    const guard = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length);
    expect(guard).toContain('community_wearable_prompt_sources is non-empty');
    expect(guard).toContain('community_wearable_prompts is non-empty');
    expect(guard).toMatch(/issue #404 backfill path/);
    // EXISTS(... LIMIT 1) is the non-empty probe; to_regclass keeps it safe when
    // the table is absent (idempotent on a fresh environment).
    expect(guard).toMatch(/EXISTS \(SELECT 1 FROM "community_wearable_prompt_sources" LIMIT 1\)/);
    expect(guard).toMatch(/EXISTS \(SELECT 1 FROM "community_wearable_prompts" LIMIT 1\)/);
    expect(guard).toMatch(/to_regclass\('public\.community_wearable_prompt_sources'\) IS NOT NULL/);
    expect(guard).toMatch(/to_regclass\('public\.community_wearable_prompts'\) IS NOT NULL/);
  });

  it('header comment explicitly references issue #404 + the issue URL', () => {
    expect(sql).toContain('#404');
    expect(sql).toContain(
      'https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/404',
    );
  });

  it('both DROP TABLE statements appear AFTER the preflight guard', () => {
    const guardEnd = sql.indexOf('END $$;');
    expect(guardEnd).toBeGreaterThanOrEqual(0);
    const dropChild = sql.indexOf(
      'DROP TABLE IF EXISTS "community_wearable_prompt_sources"',
    );
    const dropParent = sql.indexOf('DROP TABLE IF EXISTS "community_wearable_prompts"');
    expect(dropChild).toBeGreaterThan(guardEnd);
    expect(dropParent).toBeGreaterThan(guardEnd);
  });
});

describe('wearable-prompts id format — ParseUUIDPipe contract (F1)', () => {
  it('a generated v4 uuid matches the pipe-accepted UUID v4 shape', () => {
    // @default(uuid()) generates a v4 uuid (same generator family as crypto's
    // randomUUID). The controller pipe accepts exactly this shape — a cuid
    // ("clxxx…") would have failed it, which was the F1 defect.
    for (let i = 0; i < 50; i += 1) {
      expect(randomUUID()).toMatch(UUID_V4);
    }
  });
});
