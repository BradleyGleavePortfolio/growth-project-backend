-- Add CoachMessage: direct bidirectional Coach↔Client thread. `coach_id` and
-- `client_id` always identify the thread participants; `sender_id` records
-- direction for each row. `read_at` is set when the opposite party marks the
-- thread read. The composite (coach_id, client_id, created_at) index backs
-- the paginated thread query.

-- CreateTable
CREATE TABLE "CoachMessage" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "CoachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachMessage_coach_id_idx" ON "CoachMessage"("coach_id");

-- CreateIndex
CREATE INDEX "CoachMessage_client_id_idx" ON "CoachMessage"("client_id");

-- CreateIndex
CREATE INDEX "CoachMessage_created_at_idx" ON "CoachMessage"("created_at");

-- CreateIndex
CREATE INDEX "CoachMessage_coach_id_client_id_created_at_idx" ON "CoachMessage"("coach_id", "client_id", "created_at");

-- AddForeignKey
ALTER TABLE "CoachMessage" ADD CONSTRAINT "CoachMessage_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachMessage" ADD CONSTRAINT "CoachMessage_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachMessage" ADD CONSTRAINT "CoachMessage_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
