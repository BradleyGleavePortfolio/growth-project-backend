-- A3-MSG-CORE slice 1: one inbox, read state and message actions on the
-- canonical 1:1 thread (CoachMessage).
--
-- 1. CoachMessage gains:
--    - client_message_id: device-minted idempotency key for the mobile offline
--      send queue. UNIQUE (sender_id, client_message_id): a replayed send can
--      never insert a second row (NULL keys stay unconstrained for legacy
--      senders).
--    - reply_to_id: swipe-reply quote, same thread only (service-validated);
--      ON DELETE SET NULL so the quoted row's removal never cascades.
--    - edited_at, deleted_at, deleted_by_id: author edit inside the window and
--      the delete tombstone (content columns erased, row kept).
--    - pinned_at, pinned_by_id: thread-shared pins, plus a covering index for
--      the pins bar read.
-- 2. CoachThreadState: one participant's private thread preferences (mute
--    until, inbox pin). Self-only RLS: the other participant never sees them.
--
-- All new columns are nullable with no default: the ALTER is metadata-only on
-- Postgres 11+ (no table rewrite). Existing rows read as not edited, not
-- deleted, not pinned, no reply, no key.
--
-- RLS: CoachMessage is ENABLE + FORCE (idempotent; production already has
-- both) with its single participant policy coach_message_participant_access,
-- created here only when absent (production and the migration chain already
-- have it from 20260607000000); the new columns are covered by it.
-- CoachThreadState is ENABLE + FORCE with an
-- owner-staff policy and a self-only policy. The runtime connects as
-- service_role (BYPASSRLS) and scopes in the service layer; these policies are
-- defence in depth for every non-service connection, proven by
-- test/messaging/rls/coach-thread-state-rls.live.spec.ts in CI.
--
-- Rollback: down.sql (drops the table and the columns; data in them is lost,
-- which is the intended rollback for an unlaunched, flag-gated surface).

CREATE SCHEMA IF NOT EXISTS app;

-- AlterTable
ALTER TABLE "CoachMessage" ADD COLUMN     "client_message_id" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by_id" TEXT,
ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "pinned_at" TIMESTAMP(3),
ADD COLUMN     "pinned_by_id" TEXT,
ADD COLUMN     "reply_to_id" TEXT;

-- CreateTable
CREATE TABLE "CoachThreadState" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "muted_until" TIMESTAMP(3),
    "pinned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachThreadState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachThreadState_coach_id_client_id_idx" ON "CoachThreadState"("coach_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "CoachThreadState_user_id_coach_id_client_id_key" ON "CoachThreadState"("user_id", "coach_id", "client_id");

-- CreateIndex
CREATE INDEX "CoachMessage_coach_id_client_id_pinned_at_idx" ON "CoachMessage"("coach_id", "client_id", "pinned_at");

-- CreateIndex
CREATE UNIQUE INDEX "CoachMessage_sender_id_client_message_id_key" ON "CoachMessage"("sender_id", "client_message_id");

-- AddForeignKey
ALTER TABLE "CoachMessage" ADD CONSTRAINT "CoachMessage_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "CoachMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachThreadState" ADD CONSTRAINT "CoachThreadState_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: CoachThreadState (self only + owner staff).
ALTER TABLE "CoachThreadState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachThreadState" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_thread_state_owner_all" ON "CoachThreadState";
CREATE POLICY "coach_thread_state_owner_all" ON "CoachThreadState"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- A participant reads and writes ONLY their own preference rows, and may only
-- write a row for a thread they are on as coach or client (sub-coach rows are
-- written by the service-role runtime after the SubCoachAssignment check).
DROP POLICY IF EXISTS "coach_thread_state_self_access" ON "CoachThreadState";
CREATE POLICY "coach_thread_state_self_access" ON "CoachThreadState"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id())
  );

-- RLS: CoachMessage (D1, B-MSG2-120). No earlier chain migration enables RLS
-- on this table (only the loose rls_fitness_backend.sql does), so on a
-- chain-migrated database the participant policy from 20260607000000 was
-- inert and any authenticated principal read every thread. Production
-- already has RLS ENABLE + FORCE and exactly this one policy (permissive,
-- FOR ALL TO public, same USING and WITH CHECK): there this block is a
-- no-op. The policy is created only when absent and is then marked as owned
-- by this migration, so down.sql never drops a policy it did not create.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = '"CoachMessage"'::regclass
       AND polname = 'coach_message_participant_access'
  ) THEN
    CREATE POLICY "coach_message_participant_access" ON "CoachMessage"
      FOR ALL TO public
      USING (
        app.current_user_id() IS NOT NULL
        AND (
          "coach_id" = app.current_user_id()
          OR "client_id" = app.current_user_id()
          OR "sender_id" = app.current_user_id()
        )
      )
      WITH CHECK (
        app.current_user_id() IS NOT NULL
        AND (
          "coach_id" = app.current_user_id()
          OR "client_id" = app.current_user_id()
          OR "sender_id" = app.current_user_id()
        )
      );
    -- Ownership marker: down.sql drops the policy only when this matches.
    COMMENT ON POLICY "coach_message_participant_access" ON "CoachMessage"
      IS 'created by 20270303000000_messaging_core_actions';
  END IF;
END $$;

ALTER TABLE "CoachMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachMessage" FORCE ROW LEVEL SECURITY;
