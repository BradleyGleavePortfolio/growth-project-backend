-- Reverse of 20261223000300_scout_reconstructed_entity (R82/R106).
-- Drops the generic canonical reconstructed-entity table and its RLS policies.
-- Additive-only forward migration, so the reverse is a clean drop with no
-- data-preserving concerns.
DROP TABLE IF EXISTS "ScoutReconstructedEntity";
