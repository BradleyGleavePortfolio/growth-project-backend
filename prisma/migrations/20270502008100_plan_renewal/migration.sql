-- RENEWAL-BE: the plan-renewal sequence (Day 0, 1, 3, 7) a client gets after
-- a plan with their coach ended normally. Additive: one table, two read
-- policies, two defaulted columns, no data change.
--
-- Row rules (RLS enabled and forced; anon has no table access):
--   * the client reads their own rows;
--   * a coach reads a row only while that client is still theirs
--     (app.is_current_coach_of); a new coach never reads a former coach's;
--   * no API role writes: the server writes through Prisma's service-role
--     connection (bypasses RLS) from the sweep and the signed-in client's
--     pop-up acknowledgement.
-- NotificationPreferences.plan_renewal_push (default true) is the client's
-- "plan renewal reminders" switch; CoachWelcomeMessageSetting.
-- renewal_messages_enabled (default true) is the coach's switch for the
-- renewal chat messages. Both tables keep their existing policies.
-- Live proof: test/rls/plan-renewal-rls.spec.ts (rls-live-tests).
-- Reverse: down.sql.

SET lock_timeout = '5s';

CREATE TABLE "PlanRenewal" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "client_user_id" TEXT NOT NULL,
    "coach_user_id" TEXT NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stop_reason" TEXT,
    "step_index" INTEGER NOT NULL DEFAULT -1,
    "step_claimed_at" TIMESTAMP(3),
    "popup_step" INTEGER NOT NULL DEFAULT -1,
    "popup_acked_step" INTEGER NOT NULL DEFAULT -1,
    "message_step" INTEGER,
    "message_key" TEXT,
    "message_status" TEXT,
    "message_attempts" INTEGER NOT NULL DEFAULT 0,
    "message_next_at" TIMESTAMP(3),
    "message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanRenewal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanRenewal_purchase_id_key" ON "PlanRenewal"("purchase_id");
CREATE INDEX "PlanRenewal_client_user_id_coach_user_id_idx" ON "PlanRenewal"("client_user_id", "coach_user_id");
CREATE INDEX "PlanRenewal_status_idx" ON "PlanRenewal"("status");
CREATE INDEX "PlanRenewal_message_status_message_next_at_idx" ON "PlanRenewal"("message_status", "message_next_at");

ALTER TABLE "PlanRenewal" ADD CONSTRAINT "PlanRenewal_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlanRenewal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlanRenewal" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PlanRenewal" FROM anon;

CREATE POLICY "PlanRenewal_client_select" ON "PlanRenewal" FOR SELECT TO public
  USING ("client_user_id" = app.current_user_id());
CREATE POLICY "PlanRenewal_coach_select" ON "PlanRenewal" FOR SELECT TO public
  USING ("coach_user_id" = app.current_user_id() AND app.is_current_coach_of("client_user_id"));

ALTER TABLE "NotificationPreferences" ADD COLUMN "plan_renewal_push" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CoachWelcomeMessageSetting" ADD COLUMN "renewal_messages_enabled" BOOLEAN NOT NULL DEFAULT true;

RESET lock_timeout;
