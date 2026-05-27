-- Dunning v1 — cadence rewrite. Additive only.
--
-- Adds (a) cadence columns to DunningState so the tick loop can locate
-- rows due for a reminder, and (b) a new DunningAttempt table with one
-- row per scheduled cadence step. Existing rows survive untouched (new
-- cols are nullable / defaulted; existing rows get step_index=-1, which
-- the tick loop treats as "no cadence scheduled yet").

ALTER TABLE "DunningState"
  ADD COLUMN "step_index"       INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN "next_attempt_at"  TIMESTAMP(3),
  ADD COLUMN "entered_at"       TIMESTAMP(3),
  ADD COLUMN "recovered_at"     TIMESTAMP(3),
  ADD COLUMN "escalated_at"     TIMESTAMP(3);

CREATE INDEX "DunningState_status_next_attempt_at_idx"
  ON "DunningState" ("status", "next_attempt_at");

CREATE TABLE "DunningAttempt" (
  "id"                     TEXT NOT NULL,
  "dunning_state_id"       TEXT NOT NULL,
  "step_index"             INTEGER NOT NULL,
  "kind"                   TEXT NOT NULL,
  "scheduled_for"          TIMESTAMP(3) NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'pending',
  "sent_at"                TIMESTAMP(3),
  "email_idempotency_key"  TEXT,
  "provider_message_id"    TEXT,
  "failure_reason"         TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DunningAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DunningAttempt_dunning_state_id_step_index_key"
  ON "DunningAttempt" ("dunning_state_id", "step_index");

CREATE UNIQUE INDEX "DunningAttempt_email_idempotency_key_key"
  ON "DunningAttempt" ("email_idempotency_key");

CREATE INDEX "DunningAttempt_status_scheduled_for_idx"
  ON "DunningAttempt" ("status", "scheduled_for");

CREATE INDEX "DunningAttempt_dunning_state_id_status_idx"
  ON "DunningAttempt" ("dunning_state_id", "status");

ALTER TABLE "DunningAttempt"
  ADD CONSTRAINT "DunningAttempt_dunning_state_id_fkey"
  FOREIGN KEY ("dunning_state_id")
  REFERENCES "DunningState" ("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
