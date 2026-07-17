-- Reverse of 20261223000000_scout_reconstruction (R82/R106).
-- Drops the reconstruction ledger + invite-pending roster table and their RLS
-- policies, then the PersonState enum. Additive-only forward migration, so the
-- reverse is a clean drop with no data-preserving concerns.
DROP TABLE IF EXISTS "ScoutReconstructionLedger";
DROP TABLE IF EXISTS "Person";
DROP TYPE IF EXISTS "PersonState";
