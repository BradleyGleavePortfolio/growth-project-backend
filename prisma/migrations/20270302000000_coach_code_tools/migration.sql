-- A2 coach code tools (annex lane A2-COACH-TOOLS, T4).
--
-- Additive only. Adds five nullable columns to "InviteCode" (label,
-- revoked_at, idempotency_key, rotated_from_id, successor_code) with two unique indexes, and
-- creates the append-only signup ledger "InviteRedemption". No existing
-- column, index, policy or constraint is altered or dropped; existing rows
-- keep NULL in every new column. The User / CoachPackage back-relations in
-- schema.prisma are Prisma-virtual and emit no DDL.
--
-- "InviteCode" RLS is unchanged: the existing invite_code_coach_owner_access
-- policy (20260607000000_rls_remaining_gaps) already scopes every column of
-- the row, including the new ones, to the owning coach (coach_id) or the
-- sub-coach who issued it (invited_by_user_id).
--
-- RLS POLICY CITATION (ENGINEERING_RULES §2), helpers from
-- 20261212000000_rls_helper_search_path / 20260704000000_rls01_helper_searchpath_hibp:
--   app.current_user_id()  session GUC set by RlsContextInterceptor
--   app.is_owner()         platform owner context
--
-- InviteRedemption (signup ledger; coach tenancy):
--   p_inviteredemption_service_role_all  service_role ALL (the attach
--                                         transaction writes the row)
--   p_inviteredemption_select            SELECT owner OR the coach the row
--                                         belongs to (coach_id = caller)
--   NO public INSERT / UPDATE / DELETE: rows are written only server-side
--   and never edited; account deletion cascades through the FKs.
--   RESTRICTIVE anon deny-all.
--   The redeemed client cannot read the ledger (it carries coach analytics,
--   not client data the client needs), and a different coach never sees
--   another tenant's rows.
--
-- Rollback: down.sql drops the ledger and the five columns (loses signup
-- history recorded since deploy; codes keep working). Otherwise fix forward.

-- AlterTable
ALTER TABLE "InviteCode" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "rotated_from_id" TEXT,
ADD COLUMN     "successor_code" TEXT;

-- CreateTable
CREATE TABLE "InviteRedemption" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_user_id" TEXT NOT NULL,
    "invite_code_id" TEXT,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "package_id" TEXT,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InviteRedemption_coach_id_redeemed_at_idx" ON "InviteRedemption"("coach_id", "redeemed_at");

-- CreateIndex
CREATE INDEX "InviteRedemption_invite_code_id_idx" ON "InviteRedemption"("invite_code_id");

-- CreateIndex
CREATE INDEX "InviteRedemption_client_user_id_idx" ON "InviteRedemption"("client_user_id");

-- CreateIndex
CREATE INDEX "InviteRedemption_package_id_idx" ON "InviteRedemption"("package_id");

-- CreateIndex
CREATE INDEX "InviteRedemption_code_idx" ON "InviteRedemption"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_rotated_from_id_key" ON "InviteCode"("rotated_from_id");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_coach_id_idempotency_key_key" ON "InviteCode"("coach_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_rotated_from_id_fkey" FOREIGN KEY ("rotated_from_id") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_invite_code_id_fkey" FOREIGN KEY ("invite_code_id") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "CoachPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- RLS: InviteRedemption
ALTER TABLE "InviteRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InviteRedemption" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_inviteredemption_service_role_all" ON "InviteRedemption";
CREATE POLICY "p_inviteredemption_service_role_all" ON "InviteRedemption" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_inviteredemption_service_role_all" ON "InviteRedemption" IS 'Primitive A: service_role bypass for the attach transaction and server-side reads.';

DROP POLICY IF EXISTS "p_inviteredemption_select" ON "InviteRedemption";
CREATE POLICY "p_inviteredemption_select" ON "InviteRedemption" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_inviteredemption_select" ON "InviteRedemption" IS 'The coach the signup belongs to reads it; platform owner reads all. No public writes.';

DROP POLICY IF EXISTS "p_inviteredemption_anon_deny" ON "InviteRedemption";
CREATE POLICY "p_inviteredemption_anon_deny" ON "InviteRedemption" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
