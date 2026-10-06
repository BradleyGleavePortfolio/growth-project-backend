-- Roman v1.1 coach twin, slice R11-P1 (A-ROMAN11-124 plan).
--
-- Additive only: two new tables, RLS. No shipped migration is altered.
-- Reverse: down.sql. Nothing reads or writes these tables while
-- FEATURE_ROMAN_PLAYBOOK is off (the builder and the turn augmenter land in
-- later slices).
--
-- "CoachPlaybook": one versioned, structured playbook per head coach
-- (sections + red lines as JSON, validated in code by
-- src/roman/playbook/coach-playbook.schema.ts). A new build writes version
-- n+1 as active and marks n superseded; the partial unique index allows at
-- most one active row per coach.
--
-- "CoachPlaybookSource": which rows a version was learned from, as ids only
-- (never content). client_id is set when the source belongs to one client.
--
-- RLS on both tables (owner 10-05 11:22: coaches never see the playbook):
--   * service_role: full access (Primitive A; the backend serving role);
--   * NO SELECT or write policy for any other principal: not the coach, not
--     the client, not the platform owner;
--   * anon and authenticated: REVOKE ALL (no PostgREST table grant);
--   * anon: RESTRICTIVE deny-all as well.

SET lock_timeout = '5s';

-- =====================================================================
-- 1) Tables
-- =====================================================================
CREATE TABLE "CoachPlaybook" (
    "id"            TEXT NOT NULL,
    "coach_id"      TEXT NOT NULL,
    "version"       INTEGER NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'active',
    "sections"      JSONB NOT NULL,
    "red_lines"     JSONB NOT NULL,
    "source_count"  INTEGER NOT NULL DEFAULT 0,
    "source_digest" TEXT NOT NULL,
    "model_id"      TEXT NOT NULL,
    "built_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachPlaybook_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoachPlaybook_status_check" CHECK ("status" IN ('active', 'superseded')),
    CONSTRAINT "CoachPlaybook_version_check" CHECK ("version" >= 1),
    CONSTRAINT "CoachPlaybook_source_count_check" CHECK ("source_count" >= 0),
    CONSTRAINT "CoachPlaybook_sections_check" CHECK (jsonb_typeof("sections") = 'object'),
    CONSTRAINT "CoachPlaybook_red_lines_check" CHECK (jsonb_typeof("red_lines") = 'array')
);

CREATE UNIQUE INDEX "CoachPlaybook_coach_id_version_key"
    ON "CoachPlaybook"("coach_id", "version");
-- At most one active playbook per coach.
CREATE UNIQUE INDEX "CoachPlaybook_one_active_per_coach"
    ON "CoachPlaybook"("coach_id")
    WHERE "status" = 'active';

ALTER TABLE "CoachPlaybook"
    ADD CONSTRAINT "CoachPlaybook_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CoachPlaybookSource" (
    "id"          TEXT NOT NULL,
    "playbook_id" TEXT NOT NULL,
    "coach_id"    TEXT NOT NULL,
    "client_id"   TEXT,
    "source_kind" TEXT NOT NULL,
    "source_id"   TEXT NOT NULL,
    CONSTRAINT "CoachPlaybookSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoachPlaybookSource_source_kind_check" CHECK (
        "source_kind" IN (
            'adjustment_decision', 'program', 'template', 'meal_plan',
            'guideline', 'coach_message', 'session_note'
        )
    ),
    CONSTRAINT "CoachPlaybookSource_source_id_check" CHECK (char_length("source_id") BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX "CoachPlaybookSource_playbook_id_source_kind_source_id_key"
    ON "CoachPlaybookSource"("playbook_id", "source_kind", "source_id");
CREATE INDEX "CoachPlaybookSource_coach_id_idx"
    ON "CoachPlaybookSource"("coach_id");
CREATE INDEX "CoachPlaybookSource_client_id_idx"
    ON "CoachPlaybookSource"("client_id");

ALTER TABLE "CoachPlaybookSource"
    ADD CONSTRAINT "CoachPlaybookSource_playbook_id_fkey"
    FOREIGN KEY ("playbook_id") REFERENCES "CoachPlaybook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachPlaybookSource"
    ADD CONSTRAINT "CoachPlaybookSource_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 2) RLS: service_role only
-- =====================================================================
ALTER TABLE "CoachPlaybook" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachPlaybook" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CoachPlaybook" FROM anon, authenticated;

CREATE POLICY "p_coachplaybook_service_role_all" ON "CoachPlaybook"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachplaybook_service_role_all" ON "CoachPlaybook" IS
  'Primitive A: the backend builds and reads playbooks server-side. No coach, client or owner policy: the playbook is never shown to anyone.';

CREATE POLICY "deny_all_anon_coachplaybook" ON "CoachPlaybook"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

ALTER TABLE "CoachPlaybookSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachPlaybookSource" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CoachPlaybookSource" FROM anon, authenticated;

CREATE POLICY "p_coachplaybooksource_service_role_all" ON "CoachPlaybookSource"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachplaybooksource_service_role_all" ON "CoachPlaybookSource" IS
  'Primitive A: server-side source ledger (ids only). No coach, client or owner policy.';

CREATE POLICY "deny_all_anon_coachplaybooksource" ON "CoachPlaybookSource"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

RESET lock_timeout;
