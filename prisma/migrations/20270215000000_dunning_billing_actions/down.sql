-- Reverse of 20270215000000_dunning_billing_actions. Drops only the three
-- nullable columns this migration adds. A lease or a 2A marker written after
-- the migration is lost; run only with no billing action in flight.
ALTER TABLE "DunningState" DROP COLUMN IF EXISTS "client_canceled_at";
ALTER TABLE "DunningState" DROP COLUMN IF EXISTS "billing_action_until";
ALTER TABLE "DunningState" DROP COLUMN IF EXISTS "billing_action";
