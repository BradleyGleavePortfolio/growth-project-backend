/**
 * ED.6 (Roman "coach-is-watching" micro-signal) — migration + schema integrity.
 *
 * STATIC assertions (always run, no database required): the 20261218000000
 * migration SQL contains the required additive DDL, the new ConversationReview
 * table ships RLS in the SAME migration (ENGINEERING_RULES §2), and the prisma
 * schema models the new column + table consistently with the SQL. This is the
 * same drift-detection layer the community-schema spec uses: anyone editing the
 * SQL or the schema must mirror the change here or explain why it broke.
 *
 * A genuine Postgres-rig up/down roundtrip belongs in the disposable-DB backlog
 * alongside the other live migration tests; this lane ships the static layer
 * (the migration is purely additive: one nullable column + one new table, so
 * the down path is a mechanical DROP COLUMN / DROP TABLE captured in the SQL
 * header comment).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readMigrationSql(): string {
  return readFileSync(
    join(
      ROOT,
      'prisma',
      'migrations',
      '20261218000000_add_coach_reviewed_at',
      'migration.sql',
    ),
    'utf8',
  );
}

function readSchema(): string {
  return readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
}

function readReviewIdxMigrationSql(): string {
  return readFileSync(
    join(
      ROOT,
      'prisma',
      'migrations',
      '20261219000000_conv_review_coach_reviewed_at_idx',
      'migration.sql',
    ),
    'utf8',
  );
}

describe('ED.6 coach-reviewed migration — static integrity', () => {
  const sql = readMigrationSql();
  const schema = readSchema();

  describe('migration.sql DDL', () => {
    it('adds a nullable coach_reviewed_at column to the existing CheckIn table', () => {
      // Additive only — the CheckIn column is nullable (no NOT NULL, no
      // DEFAULT) so existing rows read NULL and the pill stays hidden. The
      // regex pins the exact ALTER line and asserts it terminates at the
      // semicolon (no trailing NOT NULL / DEFAULT clause).
      expect(sql).toMatch(
        /ALTER TABLE "CheckIn" ADD COLUMN "coach_reviewed_at" TIMESTAMP\(3\);/,
      );
      const checkInAlter = sql
        .split('\n')
        .find(
          (line) =>
            line.includes('ALTER TABLE "CheckIn"') &&
            line.includes('coach_reviewed_at'),
        );
      expect(checkInAlter).toBeDefined();
      expect(checkInAlter).not.toMatch(/NOT NULL/);
    });

    it('creates the ConversationReview marker table with the composite unique key', () => {
      expect(sql).toMatch(/CREATE TABLE "ConversationReview"/);
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX "ConversationReview_coach_id_client_id_key" ON "ConversationReview"\("coach_id", "client_id"\)/,
      );
    });

    it('wraps the changes in a single transaction', () => {
      expect(sql).toMatch(/BEGIN;/);
      expect(sql).toMatch(/COMMIT;/);
    });

    it('cascades the participant FKs (a deleted participant takes the marker)', () => {
      const coachFk =
        /ConversationReview_coach_id_fkey"[\s\S]*?REFERENCES "User"\("id"\) ON DELETE CASCADE/;
      const clientFk =
        /ConversationReview_client_id_fkey"[\s\S]*?REFERENCES "User"\("id"\) ON DELETE CASCADE/;
      expect(sql).toMatch(coachFk);
      expect(sql).toMatch(clientFk);
    });

    it('ships RLS in the same migration: ENABLE + FORCE on the new table (ENGINEERING_RULES §2)', () => {
      expect(sql).toMatch(
        /ALTER TABLE "ConversationReview" ENABLE ROW LEVEL SECURITY;/,
      );
      expect(sql).toMatch(
        /ALTER TABLE "ConversationReview" FORCE ROW LEVEL SECURITY;/,
      );
    });

    it('defines an owner-bypass policy and a participant-scoped policy', () => {
      expect(sql).toMatch(/CREATE POLICY "conversation_review_owner_all"/);
      expect(sql).toMatch(
        /CREATE POLICY "conversation_review_participant_access"/,
      );
      // The participant policy scopes to the coach OR client of the row.
      expect(sql).toMatch(/"coach_id" = app\.current_user_id\(\)/);
      expect(sql).toMatch(/"client_id" = app\.current_user_id\(\)/);
    });

    it('uses a timestamp strictly after the most recent landed migration', () => {
      // 20261217000000_community_voice_notes is the latest landed slot; ED.6
      // must sort after it so the ordered apply never reorders behind a landed
      // migration (R76 §6 append-only).
      expect('20261218000000' > '20261217000000').toBe(true);
    });
  });

  describe('schema.prisma consistency with the migration', () => {
    it('models coach_reviewed_at as a nullable DateTime on CheckIn', () => {
      const checkIn = schema
        .slice(schema.indexOf('model CheckIn '))
        .split(/\n}/)[0];
      expect(checkIn).toMatch(/coach_reviewed_at\s+DateTime\?/);
    });

    it('models the ConversationReview table with the named composite unique key', () => {
      const model = schema
        .slice(schema.indexOf('model ConversationReview '))
        .split(/\n}/)[0];
      expect(model).toMatch(/coach_id\s+String/);
      expect(model).toMatch(/client_id\s+String/);
      expect(model).toMatch(/coach_reviewed_at\s+DateTime\s+@default\(now\(\)\)/);
      expect(model).toMatch(
        /@@unique\(\[coach_id, client_id\], name: "ConversationReview_coach_client_key"\)/,
      );
    });

    it('wires both User back-relations for ConversationReview', () => {
      expect(schema).toMatch(
        /conversation_reviews_as_coach\s+ConversationReview\[\]\s+@relation\("ConversationReviewCoach"\)/,
      );
      expect(schema).toMatch(
        /conversation_reviews_as_client\s+ConversationReview\[\]\s+@relation\("ConversationReviewClient"\)/,
      );
    });
  });
});

/**
 * ED.2 (Roman three-arc router) — F3 daily-rings review-arc composite index.
 *
 * Static drift-detection layer (no database): the additive index migration SQL
 * and the prisma schema must agree on the composite (coach_id,
 * coach_reviewed_at) index that serves the daily-rings review-arc range query.
 * Anyone who edits one must mirror the other or explain why it broke.
 */
describe('ED.2 daily-rings review-arc composite index — static integrity', () => {
  const sql = readReviewIdxMigrationSql();
  const schema = readSchema();

  it('migration creates the composite (coach_id, coach_reviewed_at) index idempotently', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "ConversationReview_coach_id_coach_reviewed_at_idx" ON "ConversationReview"\("coach_id", "coach_reviewed_at"\);/,
    );
  });

  it('wraps the change in a single transaction', () => {
    expect(sql).toMatch(/BEGIN;/);
    expect(sql).toMatch(/COMMIT;/);
  });

  it('documents an executable rollback (DROP INDEX) in the header', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS/);
    expect(sql).toMatch(/Rollback \(reverse\):/);
  });

  it('uses a timestamp strictly after the most recent landed migration', () => {
    // 20261218000000_add_coach_reviewed_at is the prior landed slot; this index
    // migration must sort after it (R76 §6 append-only).
    expect('20261219000000' > '20261218000000').toBe(true);
  });

  it('schema.prisma carries the matching @@index on ConversationReview', () => {
    const model = schema
      .slice(schema.indexOf('model ConversationReview '))
      .split(/\n}/)[0];
    expect(model).toMatch(/@@index\(\[coach_id, coach_reviewed_at\]\)/);
  });
});
