-- R2a — AI processing consent ledger (D2 consent contract, box 2).
--
-- Additive only: one new table, one trigger function, one trigger, RLS.
-- No shipped migration is altered. Reverse: down.sql (drops only what this
-- file creates; it cannot restore ledger rows written after this migration).
--
-- "AiProcessingConsentEvent" is the APPEND-ONLY history of a user's decisions
-- about sending their data to a third-party AI processor (processor
-- 'anthropic', purpose 'client_ai_processing'). One row per grant / withdraw.
-- The current state is the row with the highest "seq" for
-- (user_id, processor, purpose). The unique index on that tuple + seq makes
-- two concurrent writers collide instead of forking the history; the server
-- re-reads and re-decides on a collision.
--
-- Append-only is enforced in the database, not only in the service:
--   * a BEFORE UPDATE trigger rejects every UPDATE for every role, including
--     service_role and the table owner;
--   * there is no UPDATE or DELETE policy for any non-service principal.
-- Rows leave the table only with the user (FK ON DELETE CASCADE, account
-- erasure) or through a privileged service_role DELETE.
--
-- RLS (Sol A-R2-4 applied to this table: self-only application reads):
--   * service_role: full access (Primitive A; the backend's serving role is
--     BYPASSRLS today, this policy keeps the table usable for service_role);
--   * SELECT for every other principal: own rows only
--     (user_id = app.current_user_id()). There is NO app.is_owner() branch and
--     NO coach / sub-coach branch: a coach and the application owner role read
--     zero rows of a client's ledger;
--   * no INSERT / UPDATE / DELETE policy for non-service principals: the server
--     is the only writer (it validates the copy version and sha256 first);
--   * anon: RESTRICTIVE deny-all plus REVOKE of table privileges.

SET lock_timeout = '5s';

-- =====================================================================
-- 1) Table
-- =====================================================================
CREATE TABLE "AiProcessingConsentEvent" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "processor"       TEXT NOT NULL,
    "purpose"         TEXT NOT NULL,
    "seq"             INTEGER NOT NULL,
    "action"          TEXT NOT NULL,
    "consent_version" TEXT NOT NULL,
    "copy_sha256"     TEXT NOT NULL,
    "platform"        TEXT,
    "app_version"     TEXT,
    "locale"          TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiProcessingConsentEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiProcessingConsentEvent_action_check" CHECK ("action" IN ('grant', 'withdraw')),
    CONSTRAINT "AiProcessingConsentEvent_seq_check" CHECK ("seq" >= 1),
    CONSTRAINT "AiProcessingConsentEvent_copy_sha256_check" CHECK ("copy_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiProcessingConsentEvent_keys_check" CHECK (
        length("processor") BETWEEN 1 AND 64
        AND length("purpose") BETWEEN 1 AND 64
        AND length("consent_version") BETWEEN 1 AND 64
    )
);

CREATE UNIQUE INDEX "AiProcessingConsentEvent_user_id_processor_purpose_seq_key"
    ON "AiProcessingConsentEvent"("user_id", "processor", "purpose", "seq");

ALTER TABLE "AiProcessingConsentEvent"
    ADD CONSTRAINT "AiProcessingConsentEvent_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 2) Append-only: reject every UPDATE (all roles)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ai_processing_consent_event_reject_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'AiProcessingConsentEvent is append-only'
    USING ERRCODE = '55000';
END
$function$;

COMMENT ON FUNCTION public.ai_processing_consent_event_reject_update() IS
  'R2a: the AI processing consent ledger is append-only; every UPDATE is rejected. A new decision is a new row.';

CREATE TRIGGER "AiProcessingConsentEvent_append_only"
    BEFORE UPDATE ON "AiProcessingConsentEvent"
    FOR EACH ROW EXECUTE FUNCTION public.ai_processing_consent_event_reject_update();

-- =====================================================================
-- 3) RLS
-- =====================================================================
ALTER TABLE "AiProcessingConsentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiProcessingConsentEvent" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "AiProcessingConsentEvent" FROM anon;

CREATE POLICY "p_aiprocessingconsentevent_service_role_all" ON "AiProcessingConsentEvent"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_aiprocessingconsentevent_service_role_all" ON "AiProcessingConsentEvent" IS
  'Primitive A: service_role access for the server-side ledger writer and account erasure. UPDATE is still rejected by the append-only trigger.';

CREATE POLICY "p_aiprocessingconsentevent_select_self" ON "AiProcessingConsentEvent"
    AS PERMISSIVE FOR SELECT TO public
    USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());
COMMENT ON POLICY "p_aiprocessingconsentevent_select_self" ON "AiProcessingConsentEvent" IS
  'Self-only read: a user reads only their own ledger rows. No owner, coach or sub-coach branch. No INSERT/UPDATE/DELETE policy exists for non-service principals.';

CREATE POLICY "deny_all_anon_aiprocessingconsentevent" ON "AiProcessingConsentEvent"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_aiprocessingconsentevent" ON "AiProcessingConsentEvent" IS
  'RESTRICTIVE deny-all: anon can never read or write ledger rows.';

RESET lock_timeout;
