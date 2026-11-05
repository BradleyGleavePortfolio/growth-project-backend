-- Down for 20270502010800_water_weight_client_uuid (WATER-WEIGHT-KEYS-BE). Drops the water and weight one-time
-- keys and their indexes. Irreversible for data: every stored key is deleted; the rows otherwise stay. A resend
-- after the down stores a second row again (the behaviour before this migration).

SET lock_timeout = '5s';

DROP INDEX IF EXISTS "WeightLog_client_uuid_key";

ALTER TABLE "WeightLog" DROP COLUMN IF EXISTS "client_uuid";

DROP INDEX IF EXISTS "water_logs_client_uuid_key";

ALTER TABLE "water_logs" DROP COLUMN IF EXISTS "client_uuid";

RESET lock_timeout;
