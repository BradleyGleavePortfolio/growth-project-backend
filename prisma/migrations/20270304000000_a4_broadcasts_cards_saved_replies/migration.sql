-- A4-MSG-BROADCAST — segmented / scheduled / recurring coach broadcasts,
-- rich message cards, saved replies and coach-private client tags.
-- ADDITIVE ONLY: six new tables, no change to any existing table or row.
-- Kill switch: FEATURE_COACH_BROADCASTS (unset -> off). With the flag off no
-- route writes these tables and the dispatcher does nothing.
--
-- RLS: every table is server-only. RLS is enabled and FORCED, service_role
-- has full access (the API connects as the service role and scopes every
-- query to the caller's coaching tenant), and anon / authenticated are
-- denied by RESTRICTIVE policies, so a PostgREST or Realtime caller with a
-- user JWT can read or write nothing here. Proven by
-- test/broadcasts/broadcasts-rls.live.spec.ts in community-live-tests.

-- CreateTable
CREATE TABLE "coach_broadcasts" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "author_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "body" TEXT NOT NULL,
    "card" JSONB,
    "segment" JSONB NOT NULL,
    "timezone" TEXT NOT NULL,
    "send_at" TIMESTAMP(3),
    "recurrence" JSONB,
    "next_run_at" TIMESTAMP(3),
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "occurrences_sent" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "idempotency_key" TEXT,
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_broadcast_runs" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lease_holder" TEXT,
    "lease_until" TIMESTAMP(3),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "fanned_out_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_broadcast_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deliver_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "defer_reason" TEXT,
    "lease_holder" TEXT,
    "lease_until" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "message_id" TEXT,
    "push_status" TEXT,
    "failure_code" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_message_cards" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "card_type" TEXT NOT NULL,
    "ref_id" TEXT,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_message_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_saved_replies" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_client_tags" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_client_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coach_broadcasts_status_next_run_at_idx" ON "coach_broadcasts"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "coach_broadcasts_coach_id_created_at_idx" ON "coach_broadcasts"("coach_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "coach_broadcasts_coach_id_idempotency_key_key" ON "coach_broadcasts"("coach_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "coach_broadcast_runs_status_lease_until_idx" ON "coach_broadcast_runs"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "coach_broadcast_runs_broadcast_id_run_key_key" ON "coach_broadcast_runs"("broadcast_id", "run_key");

-- CreateIndex
CREATE UNIQUE INDEX "coach_broadcast_deliveries_message_id_key" ON "coach_broadcast_deliveries"("message_id");

-- CreateIndex
CREATE INDEX "coach_broadcast_deliveries_status_deliver_after_idx" ON "coach_broadcast_deliveries"("status", "deliver_after");

-- CreateIndex
CREATE INDEX "coach_broadcast_deliveries_broadcast_id_status_idx" ON "coach_broadcast_deliveries"("broadcast_id", "status");

-- CreateIndex
CREATE INDEX "coach_broadcast_deliveries_recipient_id_idx" ON "coach_broadcast_deliveries"("recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_broadcast_deliveries_run_id_recipient_id_key" ON "coach_broadcast_deliveries"("run_id", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_message_cards_message_id_key" ON "coach_message_cards"("message_id");

-- CreateIndex
CREATE INDEX "coach_message_cards_card_type_ref_id_idx" ON "coach_message_cards"("card_type", "ref_id");

-- CreateIndex
CREATE INDEX "coach_saved_replies_owner_user_id_updated_at_idx" ON "coach_saved_replies"("owner_user_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "coach_saved_replies_owner_user_id_title_key" ON "coach_saved_replies"("owner_user_id", "title");

-- CreateIndex
CREATE INDEX "coach_client_tags_coach_id_tag_idx" ON "coach_client_tags"("coach_id", "tag");

-- CreateIndex
CREATE INDEX "coach_client_tags_client_id_idx" ON "coach_client_tags"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_client_tags_coach_id_client_id_tag_key" ON "coach_client_tags"("coach_id", "client_id", "tag");

-- AddForeignKey
ALTER TABLE "coach_broadcasts" ADD CONSTRAINT "coach_broadcasts_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_broadcasts" ADD CONSTRAINT "coach_broadcasts_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_broadcast_runs" ADD CONSTRAINT "coach_broadcast_runs_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "coach_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_broadcast_deliveries" ADD CONSTRAINT "coach_broadcast_deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "coach_broadcast_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_broadcast_deliveries" ADD CONSTRAINT "coach_broadcast_deliveries_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_broadcast_deliveries" ADD CONSTRAINT "coach_broadcast_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "CoachMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_message_cards" ADD CONSTRAINT "coach_message_cards_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "CoachMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_saved_replies" ADD CONSTRAINT "coach_saved_replies_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_client_tags" ADD CONSTRAINT "coach_client_tags_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_client_tags" ADD CONSTRAINT "coach_client_tags_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS: server-only posture on all six tables.
ALTER TABLE "coach_broadcasts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_broadcasts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_coach_broadcasts_service_role_all" ON "coach_broadcasts";
CREATE POLICY "p_coach_broadcasts_service_role_all" ON "coach_broadcasts" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_coach_broadcasts" ON "coach_broadcasts";
CREATE POLICY "deny_all_anon_coach_broadcasts" ON "coach_broadcasts" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_coach_broadcasts" ON "coach_broadcasts";
CREATE POLICY "deny_all_authenticated_coach_broadcasts" ON "coach_broadcasts" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE "coach_broadcast_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_broadcast_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_coach_broadcast_runs_service_role_all" ON "coach_broadcast_runs";
CREATE POLICY "p_coach_broadcast_runs_service_role_all" ON "coach_broadcast_runs" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_coach_broadcast_runs" ON "coach_broadcast_runs";
CREATE POLICY "deny_all_anon_coach_broadcast_runs" ON "coach_broadcast_runs" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_coach_broadcast_runs" ON "coach_broadcast_runs";
CREATE POLICY "deny_all_authenticated_coach_broadcast_runs" ON "coach_broadcast_runs" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE "coach_broadcast_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_broadcast_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_coach_broadcast_deliveries_service_role_all" ON "coach_broadcast_deliveries";
CREATE POLICY "p_coach_broadcast_deliveries_service_role_all" ON "coach_broadcast_deliveries" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_coach_broadcast_deliveries" ON "coach_broadcast_deliveries";
CREATE POLICY "deny_all_anon_coach_broadcast_deliveries" ON "coach_broadcast_deliveries" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_coach_broadcast_deliveries" ON "coach_broadcast_deliveries";
CREATE POLICY "deny_all_authenticated_coach_broadcast_deliveries" ON "coach_broadcast_deliveries" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE "coach_message_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_message_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_coach_message_cards_service_role_all" ON "coach_message_cards";
CREATE POLICY "p_coach_message_cards_service_role_all" ON "coach_message_cards" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_coach_message_cards" ON "coach_message_cards";
CREATE POLICY "deny_all_anon_coach_message_cards" ON "coach_message_cards" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_coach_message_cards" ON "coach_message_cards";
CREATE POLICY "deny_all_authenticated_coach_message_cards" ON "coach_message_cards" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE "coach_saved_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_saved_replies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_coach_saved_replies_service_role_all" ON "coach_saved_replies";
CREATE POLICY "p_coach_saved_replies_service_role_all" ON "coach_saved_replies" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_coach_saved_replies" ON "coach_saved_replies";
CREATE POLICY "deny_all_anon_coach_saved_replies" ON "coach_saved_replies" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_coach_saved_replies" ON "coach_saved_replies";
CREATE POLICY "deny_all_authenticated_coach_saved_replies" ON "coach_saved_replies" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE "coach_client_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_client_tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_coach_client_tags_service_role_all" ON "coach_client_tags";
CREATE POLICY "p_coach_client_tags_service_role_all" ON "coach_client_tags" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_coach_client_tags" ON "coach_client_tags";
CREATE POLICY "deny_all_anon_coach_client_tags" ON "coach_client_tags" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_coach_client_tags" ON "coach_client_tags";
CREATE POLICY "deny_all_authenticated_coach_client_tags" ON "coach_client_tags" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

