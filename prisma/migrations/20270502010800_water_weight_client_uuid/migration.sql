-- 20270502010800_water_weight_client_uuid (WATER-WEIGHT-KEYS-BE, agent 192; #191-D3 op 1): a water or weight
-- save sent twice after a lost answer is stored once.
--
-- water_logs.client_uuid and WeightLog.client_uuid: the optional one-time key the phone sends on
-- POST /nutrition/water and POST /weight, in the same form as LoggedFoodEntry.client_uuid (food's key,
-- 20260606000002). A resend with the same key returns the stored row and creates nothing. The key is unique
-- across all members, as food's is. NULL = a save without a key, exactly as before.
-- Additive only: two nullable columns, no default, no backfill and no data rewrite; every existing row keeps
-- client_uuid NULL, and NULLs never collide in a Postgres unique index, so both indexes build over existing
-- data without conflict.
-- No RLS change: both tables keep their existing row-level policies, which cover every column.
-- Reverse: down.sql.

SET lock_timeout = '5s';

ALTER TABLE "water_logs" ADD COLUMN IF NOT EXISTS "client_uuid" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "water_logs_client_uuid_key" ON "water_logs"("client_uuid");

ALTER TABLE "WeightLog" ADD COLUMN IF NOT EXISTS "client_uuid" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WeightLog_client_uuid_key" ON "WeightLog"("client_uuid");

RESET lock_timeout;
