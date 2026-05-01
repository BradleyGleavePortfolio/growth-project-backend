# Spec — Coach-created challenges (fitness + finance)

**Roadmap row:** #30.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/30-coach-challenges.md`](../architecture/handoff/30-coach-challenges.md).
**Cross-references:** PR #117 (AI Program Builder RFC — per-kind
validators), PR #118 (Team Mode foundation — `acted_by_member_user_id`
forward-compat), PR #121 specs
[`outcome-check-ins.md`](./outcome-check-ins.md) (#21 — field-types
vocabulary) and [`program-templates.md`](./program-templates.md)
(#28 — coach-private vs platform-curated split). Adjacent specs
in this wave: [`leaderboards.md`](./leaderboards.md) (#31 — the
leaderboard projection), [`tiering-l2-l3.md`](./tiering-l2-l3.md)
(#37 — quota gating).

---

## 1. Status

This spec describes a **net-new** feature family. Nothing in
`main` implements it. The closest existing primitives are the
merged `Habit` / `HabitLog` family
(`prisma/schema.prisma:530`–`541`) and the merged `CommunityWin`
row (`prisma/schema.prisma:711`); both are different shapes and
are deliberately not extended for challenges. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #30."

## 2. WHY

Coaches today have no first-class way to run a time-bounded,
metric-driven competition or commitment within their roster.
The gap shows up in three distinct user pains:

- **Fitness coach pain.** "I want my roster to do 10,000 steps a
  day for 30 days, see each other's progress, and compare." The
  closest the platform supports is `Habit` / `HabitLog` — but
  habits are a *personal* per-user rhythm, not a *cohort* event
  with a start, an end, and a leaderboard.
- **Finance coach pain.** "I want my clients to save $500 in 60
  days, log a weekly transfer, and see they are not alone." A
  finance coach today has no metric vocabulary at all — there is
  no `FinanceLog`, and the workout/meal vocabulary is fitness-
  shaped.
- **Cross-vertical pain.** Both coaches want the same primitive:
  a coach-defined metric with a target, a window, and a roster
  of participants. Building two separate features (one per
  vertical) would duplicate state machines and moderation
  surfaces.

This spec proposes a **vertical-agnostic** challenge primitive
that a fitness coach and a finance coach instantiate with
different `metric_kind` adapters but operate from the same
state machine, the same submission API, and the same
leaderboard projection (#31). The fitness adapter reads from the
existing fitness signal sources (`WorkoutSession`, `WeightLog`,
`HabitLog`); the finance adapter reads from manual submissions
only in this phase, with a forward-compat hook to a future
finance signal source.

The strategic value: this is the first feature in the platform
that is **explicitly cross-vertical**. Building it now sets the
shape that future cross-vertical features (group challenges,
cohort programs, accountability circles) inherit.

## 3. WHEN

Trigger conditions:

1. PR #121 spec #21 (`outcome-check-ins.md`) is merged or
   reviewed against this spec to confirm the field-types
   vocabulary (`number`, `scale`, `boolean`, `text`, `image`)
   is the same vocabulary used by `CoachChallengeMetric`.
2. PR #117 §3 (per-kind validator pattern) is reviewed against
   this spec's `metric_kind` enum to confirm the same validator
   shape is reused.
3. The leaderboard projection (#31) is spec'd. Challenges
   without leaderboards is a degenerate case but the leaderboard
   spec defines the visibility model the challenge spec depends
   on.
4. Tiering (#37) defines the per-tier challenge quota
   (`max_active_challenges_per_coach`), the `max_participants`
   ceiling, and whether public challenges are L1 / L2 / L3.

This work does **not** start before all four are reviewed.

## 4. WHERE

- **New module:** `src/challenges/` — `challenges.module.ts`,
  `challenges.service.ts`, `challenges.controller.ts`,
  `participations.controller.ts`, `submissions.service.ts`,
  `metric-adapters/` (one file per `metric_kind`).
- **New tables:** `CoachChallenge`, `CoachChallengeMetric`,
  `CoachChallengeParticipation`, `CoachChallengeSubmission`,
  `CoachChallengeAuditEvent`.
- **New routes (paths under `/api/`):**
  - Coach-facing CRUD:
    - `GET /coach/challenges`
    - `GET /coach/challenges/:id`
    - `POST /coach/challenges`
    - `PATCH /coach/challenges/:id`
    - `POST /coach/challenges/:id/open`
    - `POST /coach/challenges/:id/close`
    - `POST /coach/challenges/:id/archive`
    - `GET /coach/challenges/:id/participants`
    - `POST /coach/challenges/:id/invitations`
    - `DELETE /coach/challenges/:id/participants/:user_id`
  - Participant-facing:
    - `GET /me/challenges` (own active + invitations)
    - `POST /challenges/:id/join`
    - `POST /challenges/:id/leave`
    - `POST /challenges/:id/submissions` (idempotent, period-keyed)
    - `GET /challenges/:id/leaderboard` (delegates to spec #31)
  - OWNER moderation:
    - `POST /admin/challenges/:id/freeze`
    - `POST /admin/challenges/:id/takedown`
- **Reads (during submission validation and projection):**
  `WorkoutSession`, `HabitLog`, `WeightLog`, `User`,
  `ClientCoachConsent`.
- **Existing tables not touched:** none. The challenge family is
  fully additive.

## 5. WHO

- **Sign-off:** founder for the metric-kind catalog and the
  finance adapter shape (because the finance vertical is new
  surface area); backend lead for the state machine and the
  submission idempotency contract; product for the participant
  invitation UX.
- **On the hook for the runtime work:** backend platform.
- **Downstream consumers:** spec #31 (leaderboard projection
  reads `CoachChallengeSubmission`), spec #36 (progress
  envelope reads `CoachChallengeParticipation` adherence),
  spec #29 (revenue dashboard counts active challenges as a
  coach-engagement signal), the OWNER admin console (moderation
  and audit views).

## 6. WHAT

**Already exists:**

- The merged `Habit` / `HabitLog` family — *not* the same shape
  (personal rhythm, not cohort competition).
- The merged `CommunityWin` row — *not* the same shape (a
  one-off testimonial, not a metric-driven competition).
- The merged `messaging` module — used by participants to
  receive challenge announcements (deferred to spec #36 wiring).
- The merged `entitlements` read model — gates the per-coach
  quota (deferred to spec #37 wiring).

**New surface (this spec):**

- The challenge state machine (draft / open / running / closed /
  archived).
- The participation envelope (private / invitation / public).
- The metric-kind catalog (steps, weight, weighted-lift, fasting
  hours, water, habit, finance-savings, finance-debt-paydown,
  text-streak, image-checkpoint).
- The submission API and idempotency contract.
- The metric-adapter interface (one file per kind).
- The moderation surface (freeze, takedown, audit).

**Non-goals (this spec):**

- Group / cohort programs — that is parking-lot row #09 in PR
  #119's roadmap.
- Cross-coach challenges (one coach's roster against another) —
  parked for a later wave.
- Real-time leaderboard updates — the leaderboard is a snapshot
  projection (#31), not a live stream.
- Push notifications when a participant overtakes another —
  deferred to roadmap row #07 (mobile push fan-out).
- Reward / payout mechanics — out of scope.

## 7. HOW

Smallest first PR (the one that lands first under
`CHALLENGES_ENABLED=off` everywhere): the migration + the
read-only `GET /coach/challenges` endpoint + the
`metric-adapters/` skeleton with one adapter
(`steps`) wired and the rest stubbed.

Rollout phases:

1. **Phase 1 — schema + read.** Migration, module skeleton,
   read endpoints, no write paths. Flag default off.
2. **Phase 2 — coach-side write.** `POST /coach/challenges`,
   `PATCH`, state-machine transitions, no participant surface.
3. **Phase 3 — participant join + submission.** Join, leave,
   submission idempotency, with the `steps` and `habit`
   adapters first. Other adapters land one at a time.
4. **Phase 4 — invitations + visibility.** Invitation flow,
   public-challenge visibility, deep-link join.
5. **Phase 5 — moderation.** OWNER freeze + takedown,
   audit-event surface.
6. **Phase 6 — leaderboard wire-up.** Spec #31 publishes the
   snapshot projection.
7. **Phase 7 — flag flip.** `CHALLENGES_ENABLED=on` for L2 + L3
   tiers; L1 remains off.

Feature flag: `CHALLENGES_ENABLED` (`off` | `coach_only` |
`on`). `coach_only` exposes coach-side CRUD without participant
join, used during Phase 3 dogfood.

## 8. Data model sketch

> **Sketch only.** No migration is committed by this PR. All FKs
> are concrete; all columns follow the conventions in
> [`../../prisma/README.md`](../../prisma/README.md).

```prisma
enum CoachChallengeState {
  draft
  open      // invitations sent, not started
  running   // window active
  closed    // window ended, leaderboard frozen
  archived
}

enum CoachChallengeVisibility {
  private        // coach + invited only
  invitation     // anyone with invitation link
  public         // listed on coach public profile (#27 / #31)
}

enum CoachChallengeMetricKind {
  steps
  weight_lost
  weighted_lift
  fasting_hours
  water_oz
  habit
  finance_savings
  finance_debt_paydown
  text_streak
  image_checkpoint
}

enum CoachChallengeMetricAggregation {
  sum
  max
  min
  avg
  streak_days
}

enum CoachChallengeMetricSource {
  manual_submission
  workout_session
  habit_log
  weight_log
  fasting_window
  water_log
  // forward-compat:
  finance_log
}

model CoachChallenge {
  id                          String                       @id @default(uuid())
  coach_user_id               String
  title                       String
  description                 String                        @db.Text
  visibility                  CoachChallengeVisibility      @default(private)
  state                       CoachChallengeState           @default(draft)
  starts_at                   DateTime
  ends_at                     DateTime
  max_participants            Int?
  rules_text                  String?                       @db.Text
  // Forward-compat for Team Mode (PR #118):
  acted_by_member_user_id     String?
  created_at                  DateTime                      @default(now())
  updated_at                  DateTime                      @updatedAt

  coach                       User                          @relation("CoachChallengeCoach", fields: [coach_user_id], references: [id])
  metrics                     CoachChallengeMetric[]
  participations              CoachChallengeParticipation[]
  submissions                 CoachChallengeSubmission[]
  audit_events                CoachChallengeAuditEvent[]

  @@index([coach_user_id, state])
  @@index([visibility, state])
}

model CoachChallengeMetric {
  id                String                            @id @default(uuid())
  challenge_id      String
  label             String
  kind              CoachChallengeMetricKind
  source            CoachChallengeMetricSource
  aggregation       CoachChallengeMetricAggregation
  target_numeric    Float?
  target_unit       String?    // "steps", "lb", "$", "hours", "days"
  validator_config  Json       // per-kind config; shape mirrors PR #117 §3
  weight            Float      @default(1.0)
  display_order     Int        @default(0)

  challenge         CoachChallenge                    @relation(fields: [challenge_id], references: [id], onDelete: Cascade)

  @@index([challenge_id])
}

model CoachChallengeParticipation {
  id                String     @id @default(uuid())
  challenge_id      String
  user_id           String
  display_handle    String?    // overrides User.email-derived handle for leaderboard
  joined_at         DateTime   @default(now())
  left_at           DateTime?
  invitation_token  String?    @unique
  consent_snapshot  Json       // ClientCoachConsent shape captured at join

  challenge         CoachChallenge   @relation(fields: [challenge_id], references: [id], onDelete: Cascade)
  user              User             @relation(fields: [user_id], references: [id])
  submissions       CoachChallengeSubmission[]

  @@unique([challenge_id, user_id])
  @@index([user_id])
}

model CoachChallengeSubmission {
  id                  String     @id @default(uuid())
  participation_id    String
  metric_id           String
  period_key          String     // "2026-W18", "2026-04-30", etc.
  numeric_value       Float?
  text_value          String?    @db.Text
  image_storage_key   String?
  source_record_id    String?    // FK to WorkoutSession / HabitLog / etc., null when manual
  source_kind         CoachChallengeMetricSource
  submitted_at        DateTime   @default(now())
  idempotency_key     String     @unique

  participation       CoachChallengeParticipation  @relation(fields: [participation_id], references: [id], onDelete: Cascade)
  metric              CoachChallengeMetric         @relation(fields: [metric_id], references: [id])

  @@unique([participation_id, metric_id, period_key])
  @@index([participation_id, period_key])
}

model CoachChallengeAuditEvent {
  id                String     @id @default(uuid())
  challenge_id      String
  actor_user_id     String     // OWNER for freeze/takedown, coach for state changes
  action            String     // 'state_changed' | 'frozen' | 'taken_down' | ...
  detail            Json
  created_at        DateTime   @default(now())

  challenge         CoachChallenge   @relation(fields: [challenge_id], references: [id], onDelete: Cascade)

  @@index([challenge_id, created_at])
}
```

Indexes are sized for the read paths in §9; the per-period
unique on `CoachChallengeSubmission` enforces the idempotency
contract (one submission per (participation, metric, period)).

## 9. API sketch

All routes are `JwtAuthGuard`-gated. The coach routes additionally
require `RolesGuard + @Roles('coach')`; the OWNER routes require
`@Roles('owner')`. Throttling reuses the per-surface limits from
`src/common/throttling/`.

### Coach CRUD

`POST /api/coach/challenges`

Request:
```json
{
  "title": "30 days, 10k a day",
  "description": "...",
  "visibility": "invitation",
  "starts_at": "2026-06-01T00:00:00Z",
  "ends_at": "2026-06-30T23:59:59Z",
  "rules_text": "...",
  "max_participants": 50,
  "metrics": [
    {
      "label": "Steps",
      "kind": "steps",
      "source": "workout_session",
      "aggregation": "sum",
      "target_numeric": 300000,
      "target_unit": "steps",
      "weight": 1.0,
      "validator_config": {
        "min_per_day": 0,
        "max_per_day": 100000
      }
    }
  ]
}
```

Response (201): the full `CoachChallenge` envelope.

Validation:
- `starts_at < ends_at`
- `ends_at - starts_at <= 365 days`
- `metrics.length` between 1 and 10
- `metric.target_numeric` is required when `metric.aggregation`
  in `{sum, max, min, avg}`
- `metric.validator_config` validates against the `kind`-specific
  schema (mirrors PR #117 §3)

State transitions (`POST /open`, `/close`, `/archive`):
- `draft → open` (no participants required; opens invitation
  surface)
- `open → running` (automatic, when `now() >= starts_at`)
- `running → closed` (automatic, when `now() > ends_at`; manual
  early-close allowed by coach)
- `(open | running | closed) → archived` (coach action)

### Participant submission

`POST /api/challenges/:id/submissions`

Headers: `Idempotency-Key: <uuid>` (required).

Request:
```json
{
  "metric_id": "<uuid>",
  "period_key": "2026-06-15",
  "numeric_value": 11240,
  "source_kind": "manual_submission"
}
```

Response (201): the submission envelope, plus a derived
`leaderboard_position_after` field (best-effort; server
computes from the snapshot projection in #31, returns `null` if
the snapshot is older than 60 seconds and the request did not
opt-in to a synchronous rebuild).

Errors:
- `400` — value fails the metric's `validator_config`
- `409` — idempotency key has been seen with a different body
- `409` — submission for `(participation, metric, period_key)`
  already exists with a different value (returns the existing
  submission)
- `404` — participant not in challenge
- `423` — challenge is `frozen` or `taken_down`

### OWNER moderation

`POST /api/admin/challenges/:id/freeze`

Effect: writes a `CoachChallengeAuditEvent` with
`action='frozen'`, sets a derived `is_frozen` flag (the spec
proposes a separate column, not a new state, so the state machine
stays orthogonal to moderation), and rejects new submissions with
`423`.

`POST /api/admin/challenges/:id/takedown`

Effect: same as freeze, plus removes the challenge from any
public surfaces (#31 leaderboard projection scrubs it on next
rebuild; #27 public coach profile drops the link). The challenge
row is **not** deleted — audit history must persist.

## 10. Rollout / feature flags

- **Env var:** `CHALLENGES_ENABLED` (`off` | `coach_only` |
  `on`). Default `off` in every environment until Phase 6
  completes. Validated as `optional` in `env-validation.ts`.
- **Kill switch.** Setting `CHALLENGES_ENABLED=off` causes every
  challenge route to return `404` (route is conditionally
  registered). In-flight submissions complete; no data is
  destroyed.
- **Tier gate.** Independent of the env flag, the per-coach
  quota (`max_active_challenges_per_coach`) is read from the
  entitlement read model (#37). A coach on L1 has a quota of 0
  (writes return `402 Payment Required` with the upgrade hint
  envelope used by the billing module).
- **Fan-out order.** Backend → mobile (read), backend → BFF
  (coach console), mobile (write), public web (visibility
  surface for `public` challenges, deferred until #31 is live).

## 11. RBAC and privacy

- **Coach-side reads** are `coach`-gated and scoped to
  `coach_user_id = req.user.id`; no challenge is visible across
  coaches.
- **Coach-side writes** require an active `CoachSubscription`
  via the existing `SubscriptionGuard` from
  [`src/billing/README.md`](../../src/billing/README.md).
- **Participant-side join** is gated by the existing
  `ClientCoachConsent` row; a challenge invitation does not
  bypass consent. The participation row captures a snapshot of
  the consent state at join.
- **Participant-side submission** is gated by an active
  participation. A submission whose `source_record_id` references
  a foreign source must verify the source row's `user_id`
  matches the participant.
- **Public challenges** (`visibility=public`) require an active
  L2 or L3 tier (#37) and trigger the moderation surface (#31
  leaderboard) before the challenge appears on the coach's
  public profile.
- **GDPR.** A user-deletion event from
  [`docs/audit-and-gdpr.md`](../audit-and-gdpr.md):
  - Scrubs `display_handle` to `"deleted_user_<short_id>"`.
  - Replaces `text_value` and `image_storage_key` on the user's
    submissions with `null` (audit row notes the scrub).
  - Does **not** delete the participation or submission rows
    themselves — leaderboard integrity requires the rows to
    persist.

## 12. Tests

- **Unit:**
  - State machine transitions (every legal transition; every
    illegal transition rejects).
  - Each metric-adapter validator (`steps`, `habit`,
    `finance_savings`, etc.) — minimum 5 tests per adapter.
  - Idempotency contract: same key + same body → 201; same key
    + different body → 409; same `(participation, metric,
    period)` + different value → 409 with existing.
- **Integration:**
  - Full coach create → invite → participant join → submit →
    leaderboard read flow against a real Postgres.
  - Consent-revoked-mid-challenge: the participant's
    submissions stop accepting writes; the leaderboard
    projection drops their entry on next rebuild.
- **Smoke (CI on every PR):**
  - `GET /coach/challenges` returns 200 when flag is `on`.
  - `POST /coach/challenges` rejects when flag is `off`.
- **Manual eval:** the founder verifies the metric-kind catalog
  is sufficient for both verticals on at least three real
  coach scenarios per vertical.

## 13. Risks

- **Metric-kind catalog drift.** The catalog is a closed enum;
  adding a new kind requires a migration and a code release.
  Mitigation: ship the catalog with explicit `text_streak` and
  `image_checkpoint` *catch-all* kinds that capture coach
  intent without a code change.
- **Leaderboard abuse.** Spec #31 owns the abuse surface;
  this spec defers the moderation primitives to it. Risk: if
  #31 slips, public-visibility challenges must remain hidden.
- **Submission spam.** Idempotency + per-period unique limits
  blast radius. Mitigation: per-user throttle on the
  submission endpoint at 10/min via `src/common/throttling/`.
- **Cross-vertical mistake.** A finance challenge using a
  fitness `source_kind` would be a configuration error.
  Mitigation: validator rejects mismatched
  `(metric_kind, source)` combinations in `validator_config`.
- **GDPR partial-delete confusion.** Operators may expect a
  user-delete to remove leaderboard entries. The audit-and-gdpr
  doc must explicitly call out the scrub-not-delete posture
  (see §11).

## 14. Dependencies

- **Roadmap rows.** #21 (field-types vocab), #28 (template
  family for forward-compat), #31 (leaderboard projection),
  #37 (tier-gated quota).
- **Existing modules.** `src/billing/` (`SubscriptionGuard`),
  `src/auth/` (role guards), `src/common/throttling/`.
- **External services.** None. The challenge family does not
  add a provider, a new queue, or a new bucket.
- **Decisions that must close.**
  - Is the metric-kind catalog *closed* (enum) or *open*
    (string + registry)? Spec defaults to closed for
    type-safety; founder may relax.
  - Are public challenges available on L2 or only L3?
    Defaults to L2 in this spec; tiering spec (#37) is the
    final source of truth.

## 15. Acceptance criteria

A future PR series is considered "shipping" this spec when:

1. The migration adding the four new tables and the audit
   table lands on `main`, idempotently re-runnable, with all
   FKs concrete.
2. Every coach-facing route returns the documented response
   shape against the deployed staging environment.
3. The per-period idempotency contract is verified by the
   integration test in §12.
4. The OWNER freeze + takedown workflow writes an
   `AuditLog` entry per
   [`../audit-and-gdpr.md`](../audit-and-gdpr.md) §
   "AuditAction constants."
5. A staging end-to-end run completes: coach creates a public
   challenge, two test participants join, both submit, the
   leaderboard projection (#31) renders, an OWNER takes it
   down, the public surface drops.
6. The handoff brief at
   [`../architecture/handoff/30-coach-challenges.md`](../architecture/handoff/30-coach-challenges.md)
   is updated with the live module README link and the
   roadmap row stage flips to "in flight."
7. Tier-gating (#37) is verified: an L1 coach receives `402`
   on `POST /coach/challenges`; an L2 coach succeeds.

## 16. Operator handoff

When this feature ships, the operator gets:

- **Runbook entry** in [`../deploy-runbook.md`](../deploy-runbook.md)
  covering: how to flip `CHALLENGES_ENABLED`, how to freeze a
  challenge from the OWNER admin, how to read the
  `CoachChallengeAuditEvent` log, what to do when a participant
  reports abuse.
- **Dashboard tiles:**
  - "Active challenges by tier" (L1 / L2 / L3).
  - "Submission error rate" (per metric kind).
  - "Frozen challenges in the last 30 days."
- **Alerts:**
  - Submission error rate > 2% over 1 hour.
  - Any `taken_down` event (one-shot Slack to OWNER).
- **Kill switches:**
  - `CHALLENGES_ENABLED=off` — disables the route surface.
  - `CHALLENGES_PUBLIC_VISIBILITY=off` — keeps the routes
    live but forces every challenge to render as `private`
    until further notice.
