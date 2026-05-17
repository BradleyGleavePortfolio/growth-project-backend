ALTER TABLE "LoggedFoodEntry" ADD COLUMN IF NOT EXISTS "client_uuid" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "LoggedFoodEntry_client_uuid_key" ON "LoggedFoodEntry"("client_uuid");
