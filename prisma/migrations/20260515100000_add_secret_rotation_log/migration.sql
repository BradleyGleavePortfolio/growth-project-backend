-- CreateTable
CREATE TABLE "secret_rotation_log" (
    "id" TEXT NOT NULL,
    "secret_name" TEXT NOT NULL,
    "rotated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_by_user_id" TEXT,
    "notes" TEXT,

    CONSTRAINT "secret_rotation_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "secret_rotation_log_secret_name_idx" ON "secret_rotation_log"("secret_name");

-- CreateIndex
CREATE INDEX "secret_rotation_log_rotated_at_idx" ON "secret_rotation_log"("rotated_at");

-- CreateIndex
CREATE INDEX "secret_rotation_log_rotated_by_user_id_idx" ON "secret_rotation_log"("rotated_by_user_id");
