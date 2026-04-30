# Spec — At-risk client detector (B4)

**Roadmap row:** #22.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/22-at-risk-detector.md`](../architecture/handoff/22-at-risk-detector.md).
**Cross-references:** PR #117 (AI Program Builder RFC — for the
forward-compatible LLM hook), PR #118 (Team Mode ADR — staff
attribution of an at-risk save action), PR #119 (roadmap row #22),
spec [`outcome-check-ins.md`](./outcome-check-ins.md) (#21 — the
upstream data source).

---

## WHY

The strategy memo names "at-risk clients" as a primary metric the
mini admin board must surface. Without proactive detection a
coach loses clients silently — an outcome that is both lossy for
the coach's revenue and a missed signal for the platform's
retention metrics.

The detector is **rules-based** in v1. The founder's blueprint
explicitly says: "Three rules-based signals only; no LLM yet.
Threshold tuning happens with B10 partners." This spec respects
that constraint by writing the rules in code and the thresholds
in config, with an *interface* (`AtRiskClassifier`) that a future
LLM-augmented classifier can implement without re-shaping the
runtime.

## WHEN

Trigger conditions for opening the first runtime PR:

1. The outcome check-in (#21) migration has shipped, even with
   the flag off — the at-risk rules read its `(coach_id,
   period_start)` index.
2. The design-partner cohort has agreed on the three rules and
   their default thresholds (see "Rules" below for the proposal).
3. PostHog event taxonomy has been extended to carry the at-risk
   transitions (proposed event names below).

## WHERE

- New module: `src/at-risk/` — `at-risk.module.ts`,
  `at-risk.service.ts`, `at-risk.controller.ts`, `rules/`.
- New table: `AtRiskFlag` (one row per `(client_id, rule, opened_at)`,
  closed when the rule no longer fires).
- New routes (paths under `/api/`):
  - `GET /coach/clients/at-risk` — list of currently-flagged
    clients.
  - `GET /coach/clients/:clientId/at-risk` — flag history for one
    client.
  - `POST /coach/clients/:clientId/at-risk/dismiss` — coach
    explicitly dismisses a current flag (e.g. "I called them, it's
    fine").
- Reads:
  - `CheckIn.date` to score "stalled check-ins."
  - `OutcomeCheckIn.period_start` to score "missed weekly outcome."
  - `CoachMessage.created_at` to score "no recent contact."
  - `MealPlan` / `WorkoutRoutine` to score "no plan in N days"
    (rule #3).

## WHO

- **Sign-off:** founder (Bradley) for the threshold defaults;
  backend lead for the table layout; design-partner cohort for
  threshold tuning over the first month.
- **On the hook:** backend platform.
- **Downstream consumers:** coach console (dashboard widget),
  weekly recap (#23 — recap mentions any open at-risk flag), the
  OWNER metrics endpoint (`platform.coaches_with_at_risk_clients`).

## WHAT

### Already exists

- `CheckIn` daily wellness ping (`prisma/schema.prisma:596`).
- `CoachMessage` thread (`prisma/schema.prisma:661`).
- `MealPlan`, `WorkoutRoutine`, `Lesson` plan surface.
- PostHog event taxonomy (`src/analytics/events.ts`).

### Net-new

- `AtRiskFlag` table.
- `src/at-risk/` module with three rule classes.
- One feature flag, `AT_RISK_DETECTOR_ENABLED`.
- Two PostHog events: `at_risk.opened`, `at_risk.closed`.
- Two OWNER metrics counters: `at_risk.open_flags_total`,
  `at_risk.coaches_with_open_flags`.

### Non-goals

- No LLM classification. The interface allows it; the v1 runtime
  does not implement it.
- No SMS / email outbound to the coach. The flag surfaces in the
  console; dashboard only.
- No automatic dismissal on coach action other than (a) the rule
  no longer firing, or (b) explicit POST `/dismiss`.
- No client-facing surface. Clients do not know they were
  flagged.

## HOW

Smallest first PR (PR-1):

- Adds the `AtRiskFlag` model + migration.
- Adds an empty `src/at-risk/` shell, not registered in
  `app.module.ts`.
- Adds the `AtRiskClassifier` interface, three concrete rules
  (below), and pure-function unit tests against fixtures (no DB).

PR-2 wires the module, adds the cron job (BullMQ on `REDIS_URL`,
mirroring the AI Program Builder posture), persists flags, and
emits the two PostHog events.

PR-3 ships the coach-console routes and the `dismiss` action.
PR-4 ships the OWNER metrics counters.
PR-5 turns the flag on for the design-partner cohort and tunes
thresholds.

## Data model sketch

```prisma
model AtRiskFlag {
  id                String    @id @default(uuid())
  client_id         String
  client            User      @relation("AtRiskFlagClient", fields: [client_id], references: [id])
  coach_id          String
  coach             User      @relation("AtRiskFlagCoach", fields: [coach_id], references: [id])
  rule              String    // "stalled_check_ins" | "missed_outcomes" | "no_active_plan"
  severity          String    // "warning" | "critical"
  opened_at         DateTime  @default(now())
  closed_at         DateTime?
  closed_reason     String?   // "rule_no_longer_fires" | "coach_dismissed" | "client_offboarded"
  dismissed_by      String?   // user_id of coach (or staff member, once Team Mode wires)
  context_snapshot  Json      // freeze rule inputs at open time for audit/replay

  @@unique([client_id, rule, opened_at], name: "AtRiskFlag_unique_open")
  @@index([coach_id, closed_at])
  @@index([client_id, closed_at])
}
```

`context_snapshot` example (rule "stalled_check_ins"):

```json
{
  "rule": "stalled_check_ins",
  "thresholdDays": 7,
  "lastCheckInAt": "2026-04-21",
  "evaluatedAt": "2026-04-29",
  "daysSinceLast": 8
}
```

## Rules (v1, proposal)

Each rule is a `class implements AtRiskClassifier` with a pure
`evaluate(context: ClientContext): AtRiskResult | null` method.

1. **`stalled_check_ins`** — daily `CheckIn` count over the last
   `thresholdDays` is below `floor`. Defaults: `thresholdDays = 7`,
   `floor = 2`. Severity escalates to `critical` at 14 days.
2. **`missed_outcomes`** — most recent `OutcomeCheckIn` is more
   than `cadenceDays * 1.5` old. For the default weekly cadence
   that is 10 days. Severity `warning` at 1.5×, `critical` at 2.5×.
3. **`no_active_plan`** — no `WorkoutRoutine` or `MealPlan`
   created or updated for this client in the last `staleDays`.
   Default `staleDays = 21`. Severity `warning` only.

Thresholds live in a single TypeScript constants file, not in env
vars (env vars are reserved for kill-switches). The constants file
carries a one-line comment per number citing where the default
came from (founder spec, design-partner consensus, etc.).

## API sketch

```
GET /api/coach/clients/at-risk
→ 200 { open: AtRiskFlag[] }
  COACH only. Returns currently-open flags across the calling
  coach's roster, ordered by severity desc, opened_at desc.

GET /api/coach/clients/:clientId/at-risk
→ 200 { history: AtRiskFlag[] }
  Full history (open + closed) for one client.

POST /api/coach/clients/:clientId/at-risk/dismiss
body { rule, reason? }
→ 200 { flag: AtRiskFlag }
  Closes the open flag for this client + rule with
  closed_reason="coach_dismissed" and dismissed_by=callingUserId.
  Idempotent (no-op if the flag is already closed).
```

Throttling: per-coach `60 req/min` reads, `30 req/min` dismisses.

## Cron job

- Schedule: every 30 minutes via BullMQ on the existing `REDIS_URL`.
  Single instance enforced by a `SETNX` lock so multi-Fly-machine
  deploys do not double-evaluate.
- Per-coach iteration: walk active clients (`User.coach_id ==
  coach.id`), run all three rules, upsert flags.
- Per-batch budget: max 5 minutes wall-clock, max 1k client
  evaluations per batch. Carries a watermark to resume next tick.
- Failure mode: rules are pure; a single client failure logs to
  Sentry but does not abort the batch.

## Rollout / feature flags

- **Env var:** `AT_RISK_DETECTOR_ENABLED=true|false` (default `false`).
- **Allow-list:** `AT_RISK_ALLOW_COACH_IDS` mirrors the
  outcome-check-in pattern.
- **Kill-switch behavior:** when off, the cron job exits at the
  first call; the routes return `404`.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Cron job lit up for design partners only.
  3. Coach-console widget gated on the flag.
  4. Platform-wide once thresholds are tuned.

## RBAC and privacy

- COACH role required for all routes.
- Per-row tenancy: a coach reads only flags for their own roster.
- OWNER aggregates only; never reads individual `context_snapshot`.
- GDPR scrub: cascades on client account deletion. The flag
  survives the **coach's** scrub (it carries `coach_id` but no
  client PII once the client row is gone — the snapshot is keyed
  by the deleted client and is therefore opaque).
- Audit-log entries: every coach `dismiss` action is logged
  (mirrors `AuditLog` posture for `coach.message_send`).

## Tests

- **Unit (`test/at-risk-rules.spec.ts`):**
  - Each rule's `evaluate` against fixture `ClientContext` rows.
  - Threshold off-by-one cases (exactly at boundary, one day past).
  - Severity escalation crossing the second threshold.
- **Integration (`test/at-risk-routes.int-spec.ts`):**
  - 403 cross-coach reads.
  - Idempotent dismiss.
  - Closed flag does not show up in `/at-risk` list.
- **Cron-job integration (`test/at-risk-cron.int-spec.ts`):**
  - Flag opens when threshold crossed.
  - Flag auto-closes when rule no longer fires.
  - Lock prevents concurrent runs.
- **Smoke:** OWNER metrics endpoint exposes the new counters and
  they are zero on a fresh DB.

## Risks

1. **Threshold panic.** Default thresholds will be wrong for the
   first month. *Mitigation:* the design-partner cohort tunes
   them; thresholds are in a single constants file, edited in a
   one-line PR; the change is reversible.
2. **Snapshot-shape drift.** A future rule changes the shape of
   `context_snapshot` and breaks the audit-replay path.
   *Mitigation:* every rule namespace's snapshot has a `rule`
   discriminator; consumer code switches on it.
3. **Cron-job overlap on Fly multi-instance.** *Mitigation:*
   Redis lock; if Redis is down, the cron exits with a single
   Sentry breadcrumb rather than risk double-eval.
4. **PII in `context_snapshot`.** *Mitigation:* the snapshot
   carries timestamps and counts only; never the client's notes
   or values. Reviewed by the GDPR audit on the runtime PR.
5. **False positives erode trust.** *Mitigation:* the v1 rules
   are conservative and the dashboard widget is collapsible; we
   do not page or email on a flag.

## Dependencies

- **Roadmap #21 (outcome check-ins):** rule #2 reads its data.
- **Roadmap #23 (weekly recap):** consumes flags into the recap.
- **Roadmap #29 (revenue dashboard):** the
  "coaches_with_at_risk_clients" counter feeds the OWNER side.
- **PR #118 (Team Mode):** `dismissed_by` is the natural
  attribution column for staff actions; until Team Mode wires
  this is the COACH's user_id only.

## Acceptance criteria

- [ ] Migration applied without downtime.
- [ ] Cron job runs in production every 30 min, holds the lock,
      completes within budget.
- [ ] Three rules implemented and unit-tested.
- [ ] Cross-coach 403 covered.
- [ ] OWNER metrics + PostHog events visible on the metrics doc.
- [ ] Design-partner cohort signs off on threshold defaults after
      one month of data.
- [ ] Operator handoff entry in deploy-runbook.

## Operator handoff

- **Kill-switch:** `AT_RISK_DETECTOR_ENABLED=false`.
- **Allow-list:** `AT_RISK_ALLOW_COACH_IDS=<csv>`.
- **Dashboards:** OWNER metrics counters; PostHog board
  "At-risk lifecycle"; the coach-console widget.
- **Alerts:** Sentry if cron fails ≥3 consecutive runs (PR-2 wires
  this); none on flag-rate (would page on user behavior change).
- **Threshold edits:** one-line PR against the constants file;
  rolling deploy; no migration.
- **Runbook entry:** to be added to `docs/deploy-runbook.md`
  under "Background jobs."
