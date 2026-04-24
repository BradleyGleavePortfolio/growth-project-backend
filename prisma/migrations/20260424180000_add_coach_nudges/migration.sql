-- Add CoachNudge: coach → client in-app "nudge" notifications (real backing
-- for the mobile coach's Send Notification button, previously written only to
-- the coach's local SQLite). Mirrors the CoachMessage shape minus the
-- sender_id column — nudges are always coach-authored.

-- CreateTable
CREATE TABLE "CoachNudge" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "CoachNudge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachNudge_coach_id_idx" ON "CoachNudge"("coach_id");

-- CreateIndex
CREATE INDEX "CoachNudge_client_id_idx" ON "CoachNudge"("client_id");

-- CreateIndex
CREATE INDEX "CoachNudge_created_at_idx" ON "CoachNudge"("created_at");

-- CreateIndex
CREATE INDEX "CoachNudge_client_id_created_at_idx" ON "CoachNudge"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "CoachNudge_client_id_read_at_idx" ON "CoachNudge"("client_id", "read_at");

-- AddForeignKey
ALTER TABLE "CoachNudge" ADD CONSTRAINT "CoachNudge_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachNudge" ADD CONSTRAINT "CoachNudge_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
