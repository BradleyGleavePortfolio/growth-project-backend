-- S12-B4 read-only observation pack — seed_synthetic.sql
-- NOT part of the pilot pack itself. Used only under docs/pilot/PILOT_RUNBOOK.md §4 to validate
-- 00-07 against a THROWAWAY LOCAL Postgres, migrated to this slice's base with
-- `prisma migrate deploy`. Every id below is a fixed, obviously-fake UUID; no real coach, no
-- real source data, no real account. Never run this against any hosted database.
--
-- Fixture shape: coach C (legacy pilot coach), one server-mode PARTIAL run with one declaration,
-- two observations (one known family, one unknown-coverage family), a settled basis with three
-- families (one complete-coverage, one unknown-coverage, one unmapped), native provenance for
-- two persons (created, already_present) and one unresolved workout_program, plus a second coach
-- D used ONLY to prove 05_tenant_isolation.sql returns zero rows for the real pilot coach.

BEGIN;

INSERT INTO "User" (id, supabase_id, email, name, role, coach_id, created_at)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'sb-coach-c', 'coach-c@example.test', 'Coach C', 'coach', NULL, now()),
  ('22222222-2222-2222-2222-222222222222', 'sb-coach-d', 'coach-d@example.test', 'Coach D', 'coach', NULL, now());

INSERT INTO "ImportIntent" (id, coach_id, chosen_platform, created_at, paired_at)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'truecoach', now() - interval '2 hours', now() - interval '2 hours');

-- Server-mode run, PARTIAL, one fence-free settle (D-S7L mode_shape CHECK requires the server
-- vocabulary + import_intent_id/accepted_start_at/deadline_at for mode='server').
INSERT INTO "ScoutImport"
  (id, coach_id, intent_id, mode, state, terminal_status, phase, execution_epoch,
   import_intent_id, accepted_start_at, deadline_at, last_observed_at, started_at, completed_at,
   reason_code)
VALUES
  ('44444444-4444-4444-4444-444444444444',
   '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333',
   'server', 'partial', 'partial', 'reconciling', 1,
   '33333333-3333-3333-3333-333333333333',
   now() - interval '90 minutes', now() - interval '60 minutes', now() - interval '58 minutes',
   now() - interval '90 minutes', now() - interval '58 minutes',
   'coverage_basis_unknown');

INSERT INTO "ScoutImportCompletion" (id, coach_id, intent_id, terminal_status, final_counts, completed_at)
VALUES ('f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'partial',
        '{"clients": 2, "workouts": null}'::jsonb, now() - interval '58 minutes');

INSERT INTO "ScoutRunDeclaration" (coach_id, intent_id, source_platform, account_scope_id_digest, challenge, declared_at)
VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'truecoach',
        repeat('a', 64), decode(repeat('00', 32), 'hex'), now() - interval '89 minutes');

INSERT INTO "ScoutRunObservation"
  (id, coach_id, intent_id, execution_epoch, source_platform, account_scope_id_digest, family,
   basis_kind, evidence, evidence_digest, received_at)
VALUES
  ('55555555-5555-5555-5555-555555555555',
   '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 1,
   'truecoach', repeat('a', 64), 'clients', 'source_signed_enumeration',
   '{"declared_total": 2, "observed_unique": 2}'::jsonb, repeat('b', 64), now() - interval '85 minutes'),
  ('66666666-6666-6666-6666-666666666666',
   '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 1,
   'truecoach', repeat('a', 64), 'workouts', 'source_signed_enumeration',
   '{"declared_total": null, "observed_unique": null}'::jsonb, repeat('c', 64), now() - interval '84 minutes');

INSERT INTO "ScoutRunSettledBasis" (coach_id, intent_id, execution_epoch, report_version, report, observation_digests, settled_at)
VALUES (
  '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 1, 1,
  '{
     "report_version": 1,
     "basis": "recomputed",
     "conditions": ["coverage_basis_unknown"],
     "required_families": ["clients", "workouts", "client_history"],
     "ledger_without_staged": 0,
     "families": [
       {"family": "clients", "mapped": true, "tokens": ["clients"], "staged_unique": 2,
        "native_present_verified": 2, "rejected": 0, "unresolved": 0, "failed": 0,
        "ledger_without_staged": 0, "unresolved_children": {}, "relationship_closure": "not_applicable",
        "relationship_unverified": 0, "reasons": [], "child_reasons": {}, "qualifiers": [],
        "completeness_basis": "source_signed_enumeration", "observed_unique": 2},
       {"family": "workouts", "mapped": true, "tokens": ["workouts"], "staged_unique": 5,
        "native_present_verified": 0, "rejected": 0, "unresolved": 5, "failed": 0,
        "ledger_without_staged": 0, "unresolved_children": {}, "relationship_closure": "not_applicable",
        "relationship_unverified": 0, "reasons": ["unresolved:no_native_target"], "child_reasons": {},
        "qualifiers": [], "completeness_basis": "none", "observed_unique": null},
       {"family": "client_history", "mapped": false, "tokens": ["client_history"], "staged_unique": 1,
        "native_present_verified": 0, "rejected": 0, "unresolved": 0, "failed": 0,
        "ledger_without_staged": 0, "unresolved_children": {}, "relationship_closure": "not_applicable",
        "relationship_unverified": 0, "reasons": ["unresolved_family:client_history"], "child_reasons": {},
        "qualifiers": [], "completeness_basis": "none", "observed_unique": null}
     ]
   }'::jsonb,
  ARRAY[repeat('b', 64), repeat('c', 64)],
  now() - interval '58 minutes'
);

INSERT INTO "ScoutReconstructionLedger" (id, coach_id, intent_id, entity_type, source_id, source_platform, status, target_kind, target_id, reason, created_at)
VALUES
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'clients', 'src-person-1', 'truecoach', 'reconstructed', 'person', '88888888-8888-8888-8888-888888888888', NULL, now() - interval '70 minutes'),
  ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'clients', 'src-person-2', 'truecoach', 'reconstructed', 'person', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '69 minutes');

INSERT INTO "Person" (id, coach_id, source_platform, source_person_id, display_name, state, created_at, updated_at)
VALUES
  ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'truecoach', 'src-person-1', 'Synthetic Person One', 'InvitePending', now() - interval '70 minutes', now() - interval '70 minutes'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'truecoach', 'src-person-2', 'Synthetic Person Two', 'InvitePending', now() - interval '69 minutes', now() - interval '69 minutes');

-- S8-D1 person provenance: one created, one already_present (idempotent replay), one unresolved
-- workout_program (no native destination yet).
INSERT INTO "ImportNativeProvenance"
  (id, coach_id, import_intent_id, source_namespace, entity_type, source_id, native_kind, native_id, outcome, reason, created_at)
VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'truecoach', 'clients', 'src-person-1', 'person', '88888888-8888-8888-8888-888888888888', 'created', NULL, now() - interval '70 minutes'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'truecoach', 'clients', 'src-person-2', 'person', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'already_present', NULL, now() - interval '69 minutes'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'truecoach', 'workouts', 'src-workout-1', 'workout_program', NULL, 'unresolved', 'unresolved:no_native_target', now() - interval '68 minutes');

-- A second, OPEN, past-deadline, unfenced run for coach C — exercises 06_open_runs.sql's C4 case.
INSERT INTO "ScoutImport"
  (id, coach_id, intent_id, mode, state, terminal_status, phase, execution_epoch,
   import_intent_id, accepted_start_at, deadline_at, last_observed_at, started_at, completed_at, reason_code)
VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   '11111111-1111-1111-1111-111111111111', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
   'legacy', 'in_progress', NULL, NULL, 1,
   NULL, NULL, NULL, now() - interval '10 minutes', now() - interval '40 minutes', NULL, NULL);

-- Coach D's own, fully separate run — must NEVER appear in a query scoped to coach C.
INSERT INTO "ImportIntent" (id, coach_id, chosen_platform, created_at, paired_at)
VALUES ('12121212-1212-1212-1212-121212121212', '22222222-2222-2222-2222-222222222222', 'truecoach', now() - interval '3 hours', now() - interval '3 hours');

INSERT INTO "ScoutImport"
  (id, coach_id, intent_id, mode, state, terminal_status, phase, execution_epoch,
   import_intent_id, accepted_start_at, deadline_at, last_observed_at, started_at, completed_at, reason_code)
VALUES
  ('13131313-1313-1313-1313-131313131313',
   '22222222-2222-2222-2222-222222222222', '12121212-1212-1212-1212-121212121212',
   'server', 'complete', 'complete', 'reconciling', 1,
   '12121212-1212-1212-1212-121212121212',
   now() - interval '3 hours', now() - interval '2 hours 30 minutes', now() - interval '2 hours 29 minutes',
   now() - interval '3 hours', now() - interval '2 hours 29 minutes', NULL);

COMMIT;
