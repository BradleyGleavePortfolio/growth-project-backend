-- S8-D3 step 1 of 11: person-owned schema — tables, columns, CHECKs and the RLS rewrite
-- (docs/decisions/2026-09-26-s8d-person-link.md §2.1-2.5, §2.9 row D3-1; owner decision D-S8-2
-- option (a) and D-S8-LINK L1-L8).
--
-- WHAT (additive; no backfill; every new column is NULL for every existing row):
--   * Five NEW, empty, service_role-only tables: PersonInvite, PersonInviteChallenge, PersonLink,
--     PersonLinkProposal, PersonLinkOutbox — with their own PKs, plain FKs to existing PKs
--     (User(id), and to each other), closed-vocabulary CHECKs, pairing CHECKs, partial uniques and
--     RLS (ENABLE + FORCE, service_role permissive, RESTRICTIVE deny-all to anon + authenticated,
--     API-role privileges revoked) — the Person posture (20261223000200) exactly.
--     PersonLink(id, coach_id, user_id) UNIQUE is created BEFORE the self-referencing anchor FK.
--   * Person.linked_user_id TEXT NULL and ImportNativeProvenance.person_id TEXT NULL (no FK yet:
--     FKs to Person wait for the Person(id, coach_id) key built in steps 2-9 and promoted in step 10).
--   * On the five client-owned parents (WorkoutSession, WeightLog, Habit, CheckIn,
--     ClientWorkoutAssignment): ADD COLUMN person_id TEXT NULL, DROP NOT NULL on user_id /
--     client_id, the exactly-one-owner CHECK ((user_id IS NULL) <> (person_id IS NULL)) and, on
--     CheckIn, CHECK (person_id IS NULL OR coach_id IS NOT NULL) — all NOT VALID (validated in 4 of
--     4 without a write lock).
--   * RLS rewrite for eight tables (§2.2): every NON-owner policy branch gains "person_id IS NULL"
--     (USING and WITH CHECK), so a person-owned row is reachable only through the service-role code
--     path that asserts person.coach_id = caller; no permissive policy is added for person_id.
--     WorkoutSession, WeightLog and Habit had NO in-tree policy (the out-of-band
--     prisma/migrations/rls_fitness_backend.sql owned them): this file recreates those three
--     policies in-tree, guarded, and closes the migrations-only harness gap (CheckIn's ENABLE,
--     also out-of-band until now, is stated in-tree for the same reason). The app.is_owner()
--     branches on ExerciseSet, HabitLog, CheckIn and ClientWorkoutAssignmentSnapshot are kept
--     unchanged (stated owner exception, §2.2 item 2).
--
-- WHAT NOT: no composite FK to Person here (B7 ordering: unique key first, steps 2-9 / step 10); no
-- CONCURRENTLY index here (steps 2-9); no VALIDATE here (step 11); no writer, no route, no flag, no
-- data movement. Nothing reads or writes the new columns until S8-D4a / S8-E1a.
--
-- LOCKS: catalog-only ALTER TABLEs (short ACCESS EXCLUSIVE, no rewrite, no scan because every
-- constraint on a populated table is NOT VALID). Atomic under BEGIN/COMMIT with the scout
-- timeouts. A raw rerun on an applied database fails atomically at the first duplicate FK
-- constraint (nothing is dropped, adopted or repaired); after down.sql it applies cleanly again.
--
-- ROLLBACK: down.sql (refuses while any person-owned row or any link-rail row exists).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------
-- 1. Person.linked_user_id / ImportNativeProvenance.person_id (columns only; FKs in step 10)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public."Person" ADD COLUMN IF NOT EXISTS "linked_user_id" TEXT;
COMMENT ON COLUMN public."Person"."linked_user_id" IS 'S8-D3 §2.3: current active account (NULL unless state = Claimed); redundant with the active PersonLink so roster reads and the owner flip need no join. Never set by reconstruction replays.';

ALTER TABLE public."ImportNativeProvenance" ADD COLUMN IF NOT EXISTS "person_id" TEXT;
COMMENT ON COLUMN public."ImportNativeProvenance"."person_id" IS 'S8-D3 §2.6: the Person resolved as owner at import time (client-owned kinds only); never cleared. The unlink join reads this, not the mutable owner columns.';

-- ---------------------------------------------------------------------------------------------
-- 2. Five client-owned parents: nullable owner + person_id + CHECKs (NOT VALID)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public."WorkoutSession" ADD COLUMN IF NOT EXISTS "person_id" TEXT;
ALTER TABLE public."WorkoutSession" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE public."WorkoutSession" DROP CONSTRAINT IF EXISTS "WorkoutSession_owner_xor_check";
ALTER TABLE public."WorkoutSession" ADD CONSTRAINT "WorkoutSession_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;

ALTER TABLE public."WeightLog" ADD COLUMN IF NOT EXISTS "person_id" TEXT;
ALTER TABLE public."WeightLog" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE public."WeightLog" DROP CONSTRAINT IF EXISTS "WeightLog_owner_xor_check";
ALTER TABLE public."WeightLog" ADD CONSTRAINT "WeightLog_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;

ALTER TABLE public."Habit" ADD COLUMN IF NOT EXISTS "person_id" TEXT;
ALTER TABLE public."Habit" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE public."Habit" DROP CONSTRAINT IF EXISTS "Habit_owner_xor_check";
ALTER TABLE public."Habit" ADD CONSTRAINT "Habit_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;

ALTER TABLE public."CheckIn" ADD COLUMN IF NOT EXISTS "person_id" TEXT;
ALTER TABLE public."CheckIn" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_owner_xor_check";
ALTER TABLE public."CheckIn" ADD CONSTRAINT "CheckIn_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;
-- A person-owned check-in must name a coach: the composite FK (step 10) is MATCH SIMPLE and would
-- skip a NULL coach_id, so this CHECK makes the tenant pin unavoidable.
ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_person_coach_check";
ALTER TABLE public."CheckIn" ADD CONSTRAINT "CheckIn_person_coach_check"
  CHECK ("person_id" IS NULL OR "coach_id" IS NOT NULL) NOT VALID;

ALTER TABLE public."ClientWorkoutAssignment" ADD COLUMN IF NOT EXISTS "person_id" TEXT;
ALTER TABLE public."ClientWorkoutAssignment" ALTER COLUMN "client_id" DROP NOT NULL;
ALTER TABLE public."ClientWorkoutAssignment" DROP CONSTRAINT IF EXISTS "ClientWorkoutAssignment_owner_xor_check";
ALTER TABLE public."ClientWorkoutAssignment" ADD CONSTRAINT "ClientWorkoutAssignment_owner_xor_check"
  CHECK (("client_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- 3. Five new link-rail tables (empty; inline keys; FKs between them added after all five exist)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."PersonInvite" (
  "id"                 TEXT NOT NULL,
  "coach_id"           TEXT NOT NULL,
  "person_id"          TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "token_hash"         TEXT NOT NULL,
  "contact_email"      TEXT,
  "contact_phone"      TEXT,
  "sent_via"           TEXT,
  "sent_at"            TIMESTAMP(3),
  "send_status"        TEXT,
  "status"             TEXT NOT NULL DEFAULT 'open',
  "target_user_id"     TEXT,
  "expires_at"         TIMESTAMP(3) NOT NULL,
  "revoked_at"         TIMESTAMP(3),
  "revoked_by_user_id" TEXT,
  "revoke_reason"      TEXT,
  "claimed_at"         TIMESTAMP(3),
  "claimed_link_id"    TEXT,
  "declined_at"        TIMESTAMP(3),
  "failed_attempts"    INTEGER NOT NULL DEFAULT 0,
  "resend_count"       INTEGER NOT NULL DEFAULT 0,
  "last_sent_at"       TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonInvite_status_check"
    CHECK ("status" IN ('open', 'claimed', 'declined', 'revoked', 'expired')),
  CONSTRAINT "PersonInvite_sent_via_check"
    CHECK ("sent_via" IS NULL OR "sent_via" IN ('email', 'phone')),
  CONSTRAINT "PersonInvite_send_status_check"
    CHECK ("send_status" IS NULL OR "send_status" IN ('sent', 'logged', 'failed')),
  CONSTRAINT "PersonInvite_revoke_reason_check"
    CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN ('coach', 'admin', 'locked', 'superseded')),
  -- An open invite holds at least one coach-confirmed contact; terminal invites are scrubbed.
  CONSTRAINT "PersonInvite_contact_check"
    CHECK ("status" <> 'open' OR "contact_email" IS NOT NULL OR "contact_phone" IS NOT NULL),
  CONSTRAINT "PersonInvite_counters_check"
    CHECK ("failed_attempts" >= 0 AND "resend_count" >= 0),
  CONSTRAINT "PersonInvite_claimed_check"
    CHECK (("status" = 'claimed') = ("claimed_link_id" IS NOT NULL)),
  CONSTRAINT "PersonInvite_revoked_check"
    CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "PersonInvite_token_hash_key" ON public."PersonInvite" ("token_hash");
-- At most one open invite per Person (§2.4).
CREATE UNIQUE INDEX IF NOT EXISTS "PersonInvite_one_open_per_person_key"
  ON public."PersonInvite" ("person_id") WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "PersonInvite_coach_id_idx" ON public."PersonInvite" ("coach_id");
CREATE INDEX IF NOT EXISTS "PersonInvite_person_id_idx" ON public."PersonInvite" ("person_id");
CREATE INDEX IF NOT EXISTS "PersonInvite_target_user_id_idx" ON public."PersonInvite" ("target_user_id");
ALTER TABLE public."PersonInvite" ADD CONSTRAINT "PersonInvite_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonInvite" ADD CONSTRAINT "PersonInvite_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonInvite" ADD CONSTRAINT "PersonInvite_revoked_by_user_id_fkey"
  FOREIGN KEY ("revoked_by_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS public."PersonInviteChallenge" (
  "id"               TEXT NOT NULL,
  "invite_id"        TEXT NOT NULL,
  "coach_id"         TEXT NOT NULL,
  "claimant_user_id" TEXT NOT NULL,
  "channel"          TEXT NOT NULL,
  "code_hash"        TEXT NOT NULL,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "sent_at"          TIMESTAMP(3),
  "send_status"      TEXT,
  "failed_attempts"  INTEGER NOT NULL DEFAULT 0,
  "verified_at"      TIMESTAMP(3),
  "voided_at"        TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonInviteChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonInviteChallenge_channel_check" CHECK ("channel" IN ('email', 'phone')),
  CONSTRAINT "PersonInviteChallenge_send_status_check"
    CHECK ("send_status" IS NULL OR "send_status" IN ('sent', 'logged', 'failed')),
  CONSTRAINT "PersonInviteChallenge_counters_check" CHECK ("failed_attempts" >= 0)
);
-- One live (non-voided) challenge per (invite, claimant); earlier ones are voided on resend.
CREATE UNIQUE INDEX IF NOT EXISTS "PersonInviteChallenge_live_per_claimant_key"
  ON public."PersonInviteChallenge" ("invite_id", "claimant_user_id") WHERE "voided_at" IS NULL;
CREATE INDEX IF NOT EXISTS "PersonInviteChallenge_invite_id_idx" ON public."PersonInviteChallenge" ("invite_id");
CREATE INDEX IF NOT EXISTS "PersonInviteChallenge_claimant_user_id_idx" ON public."PersonInviteChallenge" ("claimant_user_id");
ALTER TABLE public."PersonInviteChallenge" ADD CONSTRAINT "PersonInviteChallenge_invite_id_fkey"
  FOREIGN KEY ("invite_id") REFERENCES public."PersonInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."PersonInviteChallenge" ADD CONSTRAINT "PersonInviteChallenge_claimant_user_id_fkey"
  FOREIGN KEY ("claimant_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS public."PersonLink" (
  "id"                         TEXT NOT NULL,
  "coach_id"                   TEXT NOT NULL,
  "person_id"                  TEXT NOT NULL,
  "user_id"                    TEXT NOT NULL,
  "path"                       TEXT NOT NULL,
  "invite_id"                  TEXT NOT NULL,
  "challenge_id"               TEXT NOT NULL,
  "proposal_id"                TEXT,
  "verified_channel"           TEXT NOT NULL,
  "verified_contact_digest"    TEXT NOT NULL,
  "client_confirmed_at"        TIMESTAMP(3) NOT NULL,
  "coach_confirmed_at"         TIMESTAMP(3) NOT NULL,
  "coach_confirmed_by_user_id" TEXT NOT NULL,
  "linked_at"                  TIMESTAMP(3) NOT NULL,
  "undo_deadline_at"           TIMESTAMP(3) NOT NULL,
  "records_moved"              JSONB NOT NULL,
  "unlinked_at"                TIMESTAMP(3),
  "unlinked_by_role"           TEXT,
  "unlinked_by_user_id"        TEXT,
  "unlink_reason_code"         TEXT,
  "unlink_note"                TEXT,
  "records_returned"           JSONB,
  "merge_anchor_link_id"       TEXT,
  "notify_status"              TEXT NOT NULL DEFAULT 'pending',
  "notify_attempts"            INTEGER NOT NULL DEFAULT 0,
  "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonLink_path_check" CHECK ("path" IN ('invite', 'proposal_match', 'proposal_merge')),
  CONSTRAINT "PersonLink_verified_channel_check" CHECK ("verified_channel" IN ('email', 'phone')),
  -- A proposal id iff the path is a proposal path (§2.5).
  CONSTRAINT "PersonLink_proposal_path_check" CHECK (("path" = 'invite') = ("proposal_id" IS NULL)),
  -- An anchor iff the path is a merge; never itself (§2.5 anchor constraints).
  CONSTRAINT "PersonLink_merge_anchor_check" CHECK (("path" = 'proposal_merge') = ("merge_anchor_link_id" IS NOT NULL)),
  CONSTRAINT "PersonLink_merge_anchor_not_self_check" CHECK ("merge_anchor_link_id" IS DISTINCT FROM "id"),
  -- L7: the undo deadline is linked_at + 30 days, computed once and never moved.
  CONSTRAINT "PersonLink_undo_deadline_check" CHECK ("undo_deadline_at" = "linked_at" + INTERVAL '30 days'),
  CONSTRAINT "PersonLink_unlinked_by_role_check"
    CHECK ("unlinked_by_role" IS NULL OR "unlinked_by_role" IN ('client', 'coach', 'admin')),
  CONSTRAINT "PersonLink_unlink_reason_code_check"
    CHECK ("unlink_reason_code" IS NULL OR "unlink_reason_code" IN
      ('not_me', 'wrong_person', 'changed_mind', 'coach_error', 'support_request', 'other')),
  -- The unlink stamps travel together (C4): all set or all NULL.
  CONSTRAINT "PersonLink_unlink_shape_check" CHECK (
    ("unlinked_at" IS NULL) = ("unlinked_by_role" IS NULL)
    AND ("unlinked_at" IS NULL) = ("unlink_reason_code" IS NULL)
    AND ("unlinked_at" IS NULL) = ("records_returned" IS NULL)
    AND ("unlinked_at" IS NULL OR "unlinked_at" >= "linked_at")
  ),
  CONSTRAINT "PersonLink_notify_status_check" CHECK ("notify_status" IN ('pending', 'delivered', 'failed')),
  CONSTRAINT "PersonLink_notify_attempts_check" CHECK ("notify_attempts" >= 0),
  -- Backs the self-referencing anchor FK below (created first: the table is new and empty).
  CONSTRAINT "PersonLink_id_coach_id_user_id_key" UNIQUE ("id", "coach_id", "user_id")
);
-- Active-link uniques (B2; strict, no merge exemption until OQ-1 — the exemption index is D6 work).
CREATE UNIQUE INDEX IF NOT EXISTS "PersonLink_active_person_key"
  ON public."PersonLink" ("person_id") WHERE "linked_at" IS NOT NULL AND "unlinked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "PersonLink_active_coach_user_key"
  ON public."PersonLink" ("coach_id", "user_id") WHERE "linked_at" IS NOT NULL AND "unlinked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "PersonLink_coach_id_idx" ON public."PersonLink" ("coach_id");
CREATE INDEX IF NOT EXISTS "PersonLink_user_id_idx" ON public."PersonLink" ("user_id");
CREATE INDEX IF NOT EXISTS "PersonLink_person_id_idx" ON public."PersonLink" ("person_id");
CREATE INDEX IF NOT EXISTS "PersonLink_invite_id_idx" ON public."PersonLink" ("invite_id");
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_coach_confirmed_by_user_id_fkey"
  FOREIGN KEY ("coach_confirmed_by_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_unlinked_by_user_id_fkey"
  FOREIGN KEY ("unlinked_by_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_invite_id_fkey"
  FOREIGN KEY ("invite_id") REFERENCES public."PersonInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_challenge_id_fkey"
  FOREIGN KEY ("challenge_id") REFERENCES public."PersonInviteChallenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Merge anchor: same coach, same account, by construction (after the triple unique above).
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_merge_anchor_link_id_coach_id_user_id_fkey"
  FOREIGN KEY ("merge_anchor_link_id", "coach_id", "user_id")
  REFERENCES public."PersonLink"("id", "coach_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS public."PersonLinkProposal" (
  "id"                   TEXT NOT NULL,
  "coach_id"             TEXT NOT NULL,
  "person_id"            TEXT NOT NULL,
  "user_id"              TEXT NOT NULL,
  "kind"                 TEXT NOT NULL,
  "proposed_by_user_id"  TEXT NOT NULL,
  "merge_anchor_link_id" TEXT,
  "status"               TEXT NOT NULL DEFAULT 'open',
  "expires_at"           TIMESTAMP(3) NOT NULL,
  "invite_id"            TEXT,
  "decided_at"           TIMESTAMP(3),
  "decided_by_user_id"   TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonLinkProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonLinkProposal_kind_check" CHECK ("kind" IN ('match', 'merge')),
  CONSTRAINT "PersonLinkProposal_status_check"
    CHECK ("status" IN ('open', 'accepted', 'declined', 'expired', 'revoked', 'superseded')),
  CONSTRAINT "PersonLinkProposal_merge_anchor_check" CHECK (("kind" = 'merge') = ("merge_anchor_link_id" IS NOT NULL)),
  -- Decided iff terminal (the sweeper's `expired` has decided_at without an actor).
  CONSTRAINT "PersonLinkProposal_decided_check" CHECK (("status" = 'open') = ("decided_at" IS NULL))
);
-- One open proposal per Person (§2.5).
CREATE UNIQUE INDEX IF NOT EXISTS "PersonLinkProposal_one_open_per_person_key"
  ON public."PersonLinkProposal" ("person_id") WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "PersonLinkProposal_coach_id_idx" ON public."PersonLinkProposal" ("coach_id");
CREATE INDEX IF NOT EXISTS "PersonLinkProposal_person_id_idx" ON public."PersonLinkProposal" ("person_id");
CREATE INDEX IF NOT EXISTS "PersonLinkProposal_user_id_idx" ON public."PersonLinkProposal" ("user_id");
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_proposed_by_user_id_fkey"
  FOREIGN KEY ("proposed_by_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_decided_by_user_id_fkey"
  FOREIGN KEY ("decided_by_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_merge_anchor_link_id_fkey"
  FOREIGN KEY ("merge_anchor_link_id") REFERENCES public."PersonLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_invite_id_fkey"
  FOREIGN KEY ("invite_id") REFERENCES public."PersonInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-links that need both sides to exist.
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES public."PersonLinkProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonInvite" ADD CONSTRAINT "PersonInvite_claimed_link_id_fkey"
  FOREIGN KEY ("claimed_link_id") REFERENCES public."PersonLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS public."PersonLinkOutbox" (
  "id"                TEXT NOT NULL,
  "link_id"           TEXT,
  "invite_id"         TEXT,
  "proposal_id"       TEXT,
  "event"             TEXT NOT NULL,
  "recipient_user_id" TEXT NOT NULL,
  "channel"           TEXT NOT NULL,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at"      TIMESTAMP(3),
  "last_error"        TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonLinkOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonLinkOutbox_event_check" CHECK ("event" IN
    ('linked', 'unlinked', 'declined',
     'proposal_created', 'proposal_declined', 'proposal_revoked', 'proposal_expired', 'proposal_superseded')),
  CONSTRAINT "PersonLinkOutbox_channel_check" CHECK ("channel" IN ('in_app', 'email')),
  CONSTRAINT "PersonLinkOutbox_attempts_check" CHECK ("attempts" >= 0),
  -- The subject matches the event: link events name a link, `declined` an invite, proposal_* a proposal.
  CONSTRAINT "PersonLinkOutbox_subject_check" CHECK (
    ("event" IN ('linked', 'unlinked') AND "link_id" IS NOT NULL)
    OR ("event" = 'declined' AND "invite_id" IS NOT NULL)
    OR ("event" LIKE 'proposal\_%' AND "proposal_id" IS NOT NULL)
  )
);
-- One row per (subject, event, recipient, channel); NULL subjects coalesce so the key is total.
CREATE UNIQUE INDEX IF NOT EXISTS "PersonLinkOutbox_subject_event_recipient_channel_key"
  ON public."PersonLinkOutbox" (
    COALESCE("link_id", ''), COALESCE("invite_id", ''), COALESCE("proposal_id", ''),
    "event", "recipient_user_id", "channel");
-- Drain path: delivered_at IS NULL AND next_attempt_at <= now().
CREATE INDEX IF NOT EXISTS "PersonLinkOutbox_pending_idx"
  ON public."PersonLinkOutbox" ("next_attempt_at") WHERE "delivered_at" IS NULL;
CREATE INDEX IF NOT EXISTS "PersonLinkOutbox_link_id_idx" ON public."PersonLinkOutbox" ("link_id");
CREATE INDEX IF NOT EXISTS "PersonLinkOutbox_recipient_user_id_idx" ON public."PersonLinkOutbox" ("recipient_user_id");
ALTER TABLE public."PersonLinkOutbox" ADD CONSTRAINT "PersonLinkOutbox_link_id_fkey"
  FOREIGN KEY ("link_id") REFERENCES public."PersonLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkOutbox" ADD CONSTRAINT "PersonLinkOutbox_invite_id_fkey"
  FOREIGN KEY ("invite_id") REFERENCES public."PersonInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkOutbox" ADD CONSTRAINT "PersonLinkOutbox_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES public."PersonLinkProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."PersonLinkOutbox" ADD CONSTRAINT "PersonLinkOutbox_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 4. RLS for the five new tables: the Person posture exactly (20261223000200 L76-86) plus the S8-B
--    belt-and-braces REVOKE of the API-role privileges Supabase's default privileges would grant.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public."PersonInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PersonInvite" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PersonInvite" FROM anon, authenticated;
DROP POLICY IF EXISTS "p_person_invite_service_role_all" ON public."PersonInvite";
CREATE POLICY "p_person_invite_service_role_all" ON public."PersonInvite" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_person_invite" ON public."PersonInvite";
CREATE POLICY "deny_all_anon_person_invite" ON public."PersonInvite" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_person_invite" ON public."PersonInvite";
CREATE POLICY "deny_all_authenticated_person_invite" ON public."PersonInvite" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE public."PersonInviteChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PersonInviteChallenge" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PersonInviteChallenge" FROM anon, authenticated;
DROP POLICY IF EXISTS "p_person_invite_challenge_service_role_all" ON public."PersonInviteChallenge";
CREATE POLICY "p_person_invite_challenge_service_role_all" ON public."PersonInviteChallenge" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_person_invite_challenge" ON public."PersonInviteChallenge";
CREATE POLICY "deny_all_anon_person_invite_challenge" ON public."PersonInviteChallenge" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_person_invite_challenge" ON public."PersonInviteChallenge";
CREATE POLICY "deny_all_authenticated_person_invite_challenge" ON public."PersonInviteChallenge" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE public."PersonLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PersonLink" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PersonLink" FROM anon, authenticated;
DROP POLICY IF EXISTS "p_person_link_service_role_all" ON public."PersonLink";
CREATE POLICY "p_person_link_service_role_all" ON public."PersonLink" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_person_link" ON public."PersonLink";
CREATE POLICY "deny_all_anon_person_link" ON public."PersonLink" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_person_link" ON public."PersonLink";
CREATE POLICY "deny_all_authenticated_person_link" ON public."PersonLink" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE public."PersonLinkProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PersonLinkProposal" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PersonLinkProposal" FROM anon, authenticated;
DROP POLICY IF EXISTS "p_person_link_proposal_service_role_all" ON public."PersonLinkProposal";
CREATE POLICY "p_person_link_proposal_service_role_all" ON public."PersonLinkProposal" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_person_link_proposal" ON public."PersonLinkProposal";
CREATE POLICY "deny_all_anon_person_link_proposal" ON public."PersonLinkProposal" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_person_link_proposal" ON public."PersonLinkProposal";
CREATE POLICY "deny_all_authenticated_person_link_proposal" ON public."PersonLinkProposal" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE public."PersonLinkOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PersonLinkOutbox" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PersonLinkOutbox" FROM anon, authenticated;
DROP POLICY IF EXISTS "p_person_link_outbox_service_role_all" ON public."PersonLinkOutbox";
CREATE POLICY "p_person_link_outbox_service_role_all" ON public."PersonLinkOutbox" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_person_link_outbox" ON public."PersonLinkOutbox";
CREATE POLICY "deny_all_anon_person_link_outbox" ON public."PersonLinkOutbox" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_person_link_outbox" ON public."PersonLinkOutbox";
CREATE POLICY "deny_all_authenticated_person_link_outbox" ON public."PersonLinkOutbox" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------------------------------------
-- 5. RLS rewrite for the eight client-owned tables (§2.2 item 1): person_id IS NULL on every
--    non-owner branch. Person-owned rows are reachable only as service_role.
-- ---------------------------------------------------------------------------------------------

-- 5a. WorkoutSession / WeightLog / Habit: first in-tree policies (they supersede the out-of-band
--     rls_fitness_backend.sql policies of the same names, which lacked the guard).
ALTER TABLE public."WorkoutSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkoutSession" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workout_session_owner_access" ON public."WorkoutSession";
CREATE POLICY "workout_session_owner_access" ON public."WorkoutSession"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id() AND "person_id" IS NULL)
  WITH CHECK ("user_id" = app.current_user_id() AND "person_id" IS NULL);
COMMENT ON POLICY "workout_session_owner_access" ON public."WorkoutSession" IS 'S8-D3: the owning user only, and never a person-owned row (person_id IS NULL). Person-owned history is service_role-only. Supersedes the out-of-band rls_fitness_backend.sql policy of the same name.';

ALTER TABLE public."WeightLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WeightLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "weight_log_owner_access" ON public."WeightLog";
CREATE POLICY "weight_log_owner_access" ON public."WeightLog"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id() AND "person_id" IS NULL)
  WITH CHECK ("user_id" = app.current_user_id() AND "person_id" IS NULL);
COMMENT ON POLICY "weight_log_owner_access" ON public."WeightLog" IS 'S8-D3: the owning user only, and never a person-owned row (person_id IS NULL). Person-owned history is service_role-only. Supersedes the out-of-band rls_fitness_backend.sql policy of the same name.';

ALTER TABLE public."Habit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Habit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "habit_owner_access" ON public."Habit";
CREATE POLICY "habit_owner_access" ON public."Habit"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id() AND "person_id" IS NULL)
  WITH CHECK ("user_id" = app.current_user_id() AND "person_id" IS NULL);
COMMENT ON POLICY "habit_owner_access" ON public."Habit" IS 'S8-D3: the owning user only, and never a person-owned row (person_id IS NULL). Person-owned history is service_role-only. Supersedes the out-of-band rls_fitness_backend.sql policy of the same name.';

-- 5b. CheckIn (20260607000000 L354-391): client, coach-select, coach-insert, coach-update gain the
--     guard in USING and WITH CHECK; check_in_owner_all is kept unchanged (owner exception).
--     ENABLE is stated in-tree (20260607000000 only re-FORCEs; the out-of-band file enabled it).
ALTER TABLE public."CheckIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CheckIn" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "check_in_client_all" ON public."CheckIn";
CREATE POLICY "check_in_client_all" ON public."CheckIn"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id() AND "person_id" IS NULL)
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND "person_id" IS NULL
    AND ("coach_id" IS NULL OR app.is_user_coached_by("user_id", "coach_id"))
  );
DROP POLICY IF EXISTS "check_in_coach_select" ON public."CheckIn";
CREATE POLICY "check_in_coach_select" ON public."CheckIn"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND "person_id" IS NULL);
DROP POLICY IF EXISTS "check_in_current_coach_insert" ON public."CheckIn";
CREATE POLICY "check_in_current_coach_insert" ON public."CheckIn"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND "person_id" IS NULL
    AND app.is_current_coach_of("user_id")
  );
DROP POLICY IF EXISTS "check_in_current_coach_update" ON public."CheckIn";
CREATE POLICY "check_in_current_coach_update" ON public."CheckIn"
  FOR UPDATE TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND "person_id" IS NULL)
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND "person_id" IS NULL
    AND app.is_current_coach_of("user_id")
  );

-- 5c. ClientWorkoutAssignment (20260702000000 L28-63; 20260621000000 L47-56): auth.uid()-keyed
--     policies, unchanged except for the guard.
DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";
CREATE POLICY "assignment_coach_manage"
    ON public."ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "person_id" IS NULL
        AND "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
    )
    WITH CHECK (
        "person_id" IS NULL
        AND "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND EXISTS (
            SELECT 1
            FROM "WorkoutPlan" wp
            WHERE wp."id" = "workout_plan_id"
              AND wp."coach_id" = (
                  SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
              )
        )
    );
DROP POLICY IF EXISTS "assignment_client_read" ON public."ClientWorkoutAssignment";
CREATE POLICY "assignment_client_read"
    ON public."ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR SELECT
    TO PUBLIC
    USING (
        "person_id" IS NULL
        AND "client_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );

-- 5d. Children: the non-owner EXISTS(parent) branch gains parent.person_id IS NULL; the
--     app.is_owner() branch is unchanged.
DROP POLICY IF EXISTS "p_exerciseset_select" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_select" ON public."ExerciseSet" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."person_id" IS NULL AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_select" ON public."ExerciseSet" IS 'Child-via-session read: owner, the session owner (user_id), or that user''s current coach may SELECT; never through a person-owned session (S8-D3).';
DROP POLICY IF EXISTS "p_exerciseset_insert" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_insert" ON public."ExerciseSet" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."person_id" IS NULL AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_insert" ON public."ExerciseSet" IS 'Child-via-session write: owner, the session owner, or that user''s current coach may INSERT; never under a person-owned session (S8-D3).';
DROP POLICY IF EXISTS "p_exerciseset_update" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_update" ON public."ExerciseSet" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."person_id" IS NULL AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."person_id" IS NULL AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_update" ON public."ExerciseSet" IS 'Child-via-session update: owner, session owner, or current coach may UPDATE; CHECK reverifies the parent session; never a person-owned session (S8-D3).';
DROP POLICY IF EXISTS "p_exerciseset_delete" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_delete" ON public."ExerciseSet" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."person_id" IS NULL AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_delete" ON public."ExerciseSet" IS 'Child-via-session delete: owner, session owner, or current coach may DELETE; never under a person-owned session (S8-D3).';

DROP POLICY IF EXISTS "p_habitlog_select" ON public."HabitLog";
CREATE POLICY "p_habitlog_select" ON public."HabitLog" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."person_id" IS NULL AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_select" ON public."HabitLog" IS 'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may read a habit log; never through a person-owned habit (S8-D3).';
DROP POLICY IF EXISTS "p_habitlog_insert" ON public."HabitLog";
CREATE POLICY "p_habitlog_insert" ON public."HabitLog" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."person_id" IS NULL AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_insert" ON public."HabitLog" IS 'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may write a habit log; never under a person-owned habit (S8-D3).';
DROP POLICY IF EXISTS "p_habitlog_update" ON public."HabitLog";
CREATE POLICY "p_habitlog_update" ON public."HabitLog" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."person_id" IS NULL AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."person_id" IS NULL AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_update" ON public."HabitLog" IS 'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may update a habit log; never under a person-owned habit (S8-D3).';
DROP POLICY IF EXISTS "p_habitlog_delete" ON public."HabitLog";
CREATE POLICY "p_habitlog_delete" ON public."HabitLog" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."person_id" IS NULL AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_delete" ON public."HabitLog" IS 'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may delete a habit log; never under a person-owned habit (S8-D3).';

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_select" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_select" ON public."ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."person_id" IS NULL AND (cwa."client_id" = app.current_user_id() OR cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_select" ON public."ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment read: owner admin, the assigned client, the assigning coach, or that client''s current coach/sub-coach may SELECT the snapshot; never through a person-owned assignment (S8-D3).';
DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_insert" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_insert" ON public."ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."person_id" IS NULL AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_insert" ON public."ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment write: owner admin, the assigning coach, or that client''s current coach/sub-coach may INSERT the snapshot (taken inside the assign tx); never under a person-owned assignment (S8-D3).';
DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_update" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_update" ON public."ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."person_id" IS NULL AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."person_id" IS NULL AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_update" ON public."ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment update: owner admin, the assigning coach, or that client''s coach/sub-coach may UPDATE; snapshots are immutable in practice but the policy keeps the parent check symmetric; never a person-owned assignment (S8-D3).';
DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_delete" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_delete" ON public."ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."person_id" IS NULL AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_delete" ON public."ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment delete: owner admin, the assigning coach, or that client''s coach/sub-coach may DELETE; never under a person-owned assignment (S8-D3).';

COMMIT;
