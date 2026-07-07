-- Reverse of 20261222000000_add_extension_pair_codes (R82/R106).
-- Additive migration → the reverse simply drops the table (policies, indexes
-- and the FK are dropped with it).
DROP TABLE IF EXISTS "ExtensionPairCode";
