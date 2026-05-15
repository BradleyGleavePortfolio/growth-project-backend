-- Phase 8 Connect / Team-mode — minimal team profile + sub-coach invite.
--
-- TeamProfile attaches a business name + public team code + cached
-- capacity counters to each head coach. Sub-coach invites are
-- per-issuer rows with a unique acceptance token. Both tables hang
-- off User (CASCADE on delete) so test teardown and GDPR erase sweep
-- them cleanly.

CREATE TABLE "TeamProfile" (
    "id"                TEXT        NOT NULL,
    "head_coach_id"     TEXT        NOT NULL,
    "business_name"     TEXT        NOT NULL,
    "team_code"         TEXT        NOT NULL,
    "client_capacity"   INTEGER     NOT NULL DEFAULT 0,
    "clients_assigned"  INTEGER     NOT NULL DEFAULT 0,
    "payouts_enabled"   BOOLEAN     NOT NULL DEFAULT false,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamProfile_head_coach_id_key"
    ON "TeamProfile"("head_coach_id");
CREATE UNIQUE INDEX "TeamProfile_team_code_key"
    ON "TeamProfile"("team_code");
CREATE INDEX "TeamProfile_team_code_idx"
    ON "TeamProfile"("team_code");

ALTER TABLE "TeamProfile"
    ADD CONSTRAINT "TeamProfile_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "SubCoachInvite" (
    "id"                  TEXT        NOT NULL,
    "head_coach_id"       TEXT        NOT NULL,
    "email"               TEXT        NOT NULL,
    "name"                TEXT,
    "max_clients"         INTEGER,
    "token"               TEXT        NOT NULL,
    "expires_at"          TIMESTAMP(3) NOT NULL,
    "accepted_at"         TIMESTAMP(3),
    "accepted_by_user_id" TEXT,
    "revoked_at"          TIMESTAMP(3),
    "revoked_by_user_id"  TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubCoachInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubCoachInvite_token_key"
    ON "SubCoachInvite"("token");
CREATE INDEX "SubCoachInvite_head_coach_id_accepted_at_idx"
    ON "SubCoachInvite"("head_coach_id", "accepted_at");
CREATE INDEX "SubCoachInvite_email_idx"
    ON "SubCoachInvite"("email");

ALTER TABLE "SubCoachInvite"
    ADD CONSTRAINT "SubCoachInvite_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubCoachInvite"
    ADD CONSTRAINT "SubCoachInvite_accepted_by_user_id_fkey"
    FOREIGN KEY ("accepted_by_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
