-- Reverse of 20270215000000_dunning_billing_actions. Drops only what that
-- migration creates (tables take their indexes, FKs and policies with them).
-- Billing leases, operation journals, notice delivery records and 2A markers
-- written after the migration are lost; run only with no billing action in
-- flight and the dunning v2 flag off.
DROP TABLE IF EXISTS "DunningNoticeDelivery";
DROP TABLE IF EXISTS "ClientBillingOperation";
DROP TABLE IF EXISTS "ClientBillingLease";
ALTER TABLE "DunningState" DROP COLUMN IF EXISTS "client_canceled_at";
