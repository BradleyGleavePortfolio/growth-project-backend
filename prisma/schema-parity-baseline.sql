-- Schema parity baseline: drift between the database the migration chain builds and
-- prisma/schema.prisma that predates the blocking gate (BL-MIGRATION-REBASELINE).
-- Read by scripts/ci/schema-parity-gate.js in .github/workflows/schema-parity.yml.
-- One normalized item per line. This file may only shrink: when a change fixes an item,
-- delete its line in the same change. Never add a line to accept new drift; write the
-- migration (or the schema change) that removes it. Tables, enums, enum values and
-- columns missing from the chain can never be listed here; the gate rejects them.


