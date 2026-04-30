# Spec — AI weekly recap (B2)

**Roadmap row:** #23.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/23-weekly-recap.md`](../architecture/handoff/23-weekly-recap.md).
**Cross-references:** PR #117 (AI Program Builder RFC — same
provider plumbing, same cost cap), PR #119 (roadmap row #23),
spec [`outcome-check-ins.md`](./outcome-check-ins.md) (#21 — primary
input), spec [`at-risk-detector.md`](./at-risk-detector.md) (#22 —
mentioned in the recap), spec [`coach-ai-voice.md`](./coach-ai-voice.md)
(#24 — supplies the tone parameters).

> The recap is the **first user-facing AI surface that a coach
> personally signs off on** before sending to a client. The
> human-in-the-loop edit step is non-negotiable.

---

## WHY

The strategy memo names "AI weekly recap — one-click, sent from
the coach. Pulls program, check-ins, calls, wins; produces a
personalized summary" as a 1–4 week build that ships before the
AI Program Builder. It is the smallest end-to-end use of the AI
infrastructure: one prompt, one input bundle, one human edit
step, one outbound message.

The recap is also the *forcing function* for two adjacent
features: (a) the coach AI voice / tone setting (#24), because a
recap that does not sound like the coach is unusable, and (b) the
outcome check-in (#21), because the recap's data quality is
proportional to the structured weekly inputs.

## WHEN

Trigger conditions for opening the first runtime PR:

1. The coach AI voice / tone setting (#24) has shipped at least
   the data model — recaps must read the coach's tone preferences
   from day one, not be retrofitted later.
2. The outcome check-in (#21) is in flight; recaps degrade
   gracefully when no outcome rows exist.
3. The platform has at least one design-partner coach willing to
   review the first ten recaps before they are sent.

## WHERE

- New module: `src/weekly-recap/` —
  `weekly-recap.module.ts`, `weekly-recap.service.ts`,
  `weekly-recap.controller.ts`, `prompt-templates/`.
- New table: `WeeklyRecap` (one row per `(coach_id, client_id,
  period_start)`).
- New routes (paths under `/api/`):
  - `POST /coach/clients/:clientId/weekly-recap/draft`
  - `GET /coach/clients/:clientId/weekly-recap/latest`
  - `PATCH /coach/weekly-recaps/:id`
  - `POST /coach/weekly-recaps/:id/send`
- Reads:
  - `OutcomeCheckIn` rows for the period (#21).
  - `CheckIn` rows for the period.
  - `CoachMessage` thread (last 30 days) for "wins."
  - `WorkoutRoutine` / `MealPlan` updates for the period.
  - `AtRiskFlag` open flags (#22) — surfaced in the recap.
  - `CoachProfile.ai_monthly_spend_cap_cents` for budget gate.
  - `CoachAIVoiceSetting` (#24) for tone.
- Outbound: posts the sent recap as a `CoachMessage` (the existing
  thread surface) — does **not** add a new outbound channel.

## WHO

- **Sign-off:** founder (Bradley) for the first recap reviewed
  manually; backend lead for the table layout; design partners for
  prompt iteration.
- **On the hook:** backend platform.
- **Downstream consumers:** coach console (the recap drafting +
  edit + send UI).
- **Provider posture:** Anthropic (per AI Program Builder RFC §4)
  with deterministic fallback.

## WHAT

### Already exists

- Anthropic provider plumbing reused from the in-app AI coach.
- `CoachMessage` thread (`prisma/schema.prisma:661`) — the
  send-target.
- `MessageDraft` (`prisma/schema.prisma:291`) — *not* the storage
  for the recap; recaps live in their own table because they have
  more structure.
- `CoachProfile.ai_monthly_spend_cap_cents` already enforces the
  per-coach budget for the in-app AI coach; the recap participates
  in the same cap.

### Net-new

- `WeeklyRecap` table.
- `src/weekly-recap/` module.
- One feature flag, `WEEKLY_RECAP_ENABLED`.
- One PostHog event family: `weekly_recap.{drafted,edited,sent,
  skipped,failed}`.
- One OWNER metrics counter: `weekly_recap.sent_total`.

### Non-goals

- Not auto-send. Drafts always require explicit
  `POST /send` after coach edit.
- No client-facing surface other than the resulting
  `CoachMessage`.
- No separate analytics opt-in — the in-app AI coach's posture
  applies.

## HOW

Smallest first PR (PR-1):

- Adds the `WeeklyRecap` model + migration.
- Adds an empty `src/weekly-recap/` shell.
- Defines the prompt template under `prompt-templates/recap.v1.md`
  and ships fixture inputs / expected-output snapshots for the
  deterministic fallback.

PR-2 wires the module, exposes the four routes, and adds the
budget gate.

PR-3 adds the prompt-eval CI step (10 fixture clients → produce
recap → snapshot diff against last green) — this is the first
piece of AI eval infrastructure, foundational for #117 too.

PR-4 turns the flag on for the design-partner cohort.

## Data model sketch

```prisma
model WeeklyRecap {
  id                 String    @id @default(uuid())
  coach_id           String
  coach              User      @relation("WeeklyRecapCoach", fields: [coach_id], references: [id])
  client_id          String
  client             User      @relation("WeeklyRecapClient", fields: [client_id], references: [id])
  period_start       DateTime  @db.Date
  period_end         DateTime  @db.Date
  prompt_version     String    // "recap.v1" | "recap.v1.1" — matches the file under prompt-templates/
  body_initial       String    // raw model output, never edited
  body_final         String    // current edit; equals body_initial until the coach edits
  edited_by          String?   // user_id of the coach (or staff member, future Team Mode)
  state              String    @default("drafted") // drafted | edited | sent | failed
  cost_cents         Int       @default(0)
  tokens_in          Int       @default(0)
  tokens_out         Int       @default(0)
  provider           String?   // "anthropic" | "deterministic_fallback"
  model_id           String?
  message_id         String?   // FK-loose: the CoachMessage created on send
  failure_reason     String?
  drafted_at         DateTime  @default(now())
  sent_at            DateTime?

  @@unique([coach_id, client_id, period_start], name: "WeeklyRecap_unique_period")
  @@index([coach_id, sent_at])
  @@index([state])
}
```

`body_initial` is preserved verbatim for evals + recovery (this is
the same posture taken by the AI Program Builder RFC §11).

## API sketch

```
POST /api/coach/clients/:clientId/weekly-recap/draft
body { periodStart?: ISO_DATE, periodEnd?: ISO_DATE }
→ 201 { recap: WeeklyRecap }
  Defaults the period to "the most recent Monday-Sunday." Idempotent
  on (coach, client, period_start) — re-POST returns the existing
  draft. Synchronous: returns the model output in <30s.

GET /api/coach/clients/:clientId/weekly-recap/latest
→ 200 { recap: WeeklyRecap | null }
  Returns the most recent recap for this client (any state).

PATCH /api/coach/weekly-recaps/:id
body { body_final: string }
→ 200 { recap: WeeklyRecap }
  Updates body_final; transitions state to "edited" if previously
  "drafted." Cannot edit after "sent."

POST /api/coach/weekly-recaps/:id/send
→ 200 { recap: WeeklyRecap, message: CoachMessage }
  Creates a CoachMessage from body_final, marks recap state="sent",
  links message_id. Idempotent — second POST is a no-op.
```

Throttling: per-coach `10 req/min` on `/draft` (LLM cost gate);
`60 req/min` on the rest.

Budget gate: every `/draft` call increments
`CoachAIBudgetLedger` (an existing per-coach monthly counter, or
a new column on `CoachProfile`; the runtime PR picks one and
documents it). Returning `429` with body
`{ code: "ai_budget_exceeded" }` when over cap.

## Prompt + provider posture

- Prompt template lives at
  `src/weekly-recap/prompt-templates/recap.v1.md`. Versioned by
  filename. The version string is persisted on every row so a
  prompt edit does not retroactively rewrite history.
- Anthropic Claude (model id pinned in env, not in prompt).
- Deterministic fallback: if the provider is unset or the
  per-coach budget is hit, returns a templated string assembled
  from the structured inputs. Fallback ships in PR-1 so dev /
  test environments do not depend on a live provider key.
- Prompt caching: the per-coach context block (voice/tone, brand,
  niche) is identical across all of that coach's clients within
  a week; mark it cacheable so the second client onward hits
  cache. (See AI Program Builder RFC §16 for the same posture.)

## Rollout / feature flags

- **Env var:** `WEEKLY_RECAP_ENABLED=true|false` (default `false`).
- **Allow-list:** `WEEKLY_RECAP_ALLOW_COACH_IDS`.
- **Provider knob:** reuses the AI Program Builder's
  `ANTHROPIC_API_KEY` if set; otherwise deterministic fallback.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Eval CI step lit up.
  3. Allow-list 1 design partner; review every recap by hand for
     two weeks.
  4. Allow-list expands to the cohort.
  5. Platform-wide.

## RBAC and privacy

- COACH role required.
- Per-row tenancy: a coach drafts / sends only against their own
  roster.
- The recap reads client check-in + outcome data; the LLM
  provider posture is "no retain" (matches AI Program Builder
  RFC §13).
- `body_initial` is treated as PII (it cites the client's notes)
  and is included in GDPR export and scrub paths.
- Audit log entries: `weekly_recap.sent`.
- Staff attribution (Team Mode): `edited_by` carries the staff
  member's user_id once `acted_by_member_user_id` is wired.

## Tests

- **Unit (`test/weekly-recap-prompt.spec.ts`):**
  - Prompt assembly from fixture inputs is byte-stable across
    runs.
  - Deterministic fallback produces a non-empty string for every
    fixture.
- **Integration (`test/weekly-recap-routes.int-spec.ts`):**
  - 403 cross-coach.
  - Idempotent re-draft.
  - Cannot edit after sent.
  - Budget gate returns 429 with the documented error code.
- **Eval (`test/weekly-recap-eval.spec.ts`):** snapshot-diff
  against last-green outputs for 10 fixture clients. Diff > N
  characters fails the build.
- **Smoke:** GET `/latest` against a seeded design-partner client
  returns 200 with `null` initially.

## Risks

1. **Hallucination of facts.** The recap might invent a workout
   the client didn't do. *Mitigation:* the prompt template forbids
   inventing facts not in the input bundle; the eval suite
   includes a "no-data week" fixture that must produce a graceful
   empty recap.
2. **Voice drift.** Recaps that don't sound like the coach erode
   trust. *Mitigation:* hard dependency on the coach AI voice
   setting (#24); recap is gated on having one set.
3. **Budget runaways.** A buggy auto-retry pattern blows the
   per-coach cap. *Mitigation:* the budget gate is the same one
   used by the in-app AI coach; the cap is per-coach and
   per-month; provider call has 1 retry max.
4. **PII in logs.** Sentry breadcrumbs accidentally capturing
   `body_initial`. *Mitigation:* explicit Sentry scrubber for the
   `weekly_recap` namespace; covered by an integration test.
5. **Send before review.** A bug auto-sends a draft.
   *Mitigation:* `state` transitions are explicit and the test
   suite covers the negative path.

## Dependencies

- **#21 outcome check-ins:** input data (graceful when missing).
- **#22 at-risk detector:** open flags get cited in the recap.
- **#24 coach AI voice / tone:** the tone source.
- **PR #117 AI Program Builder:** the eval CI step shipped here is
  shared infrastructure.

## Acceptance criteria

- [ ] Migration applied without downtime.
- [ ] Four routes return the standard envelope.
- [ ] Idempotency, budget gate, RBAC, and Sentry-scrub tests
      green.
- [ ] Eval CI runs on every PR that touches `prompt-templates/`.
- [ ] OWNER metrics counter `weekly_recap.sent_total` visible.
- [ ] PostHog events visible in `docs/metrics.md`.
- [ ] Design-partner cohort signs off after the first 50 recaps.

## Operator handoff

- **Kill-switch:** `WEEKLY_RECAP_ENABLED=false`.
- **Cost dashboards:** PostHog `weekly_recap.cost_cents` rolling
  90-day chart per coach; OWNER metrics
  `weekly_recap.spend_last_30d_cents`.
- **Cap edits:** per-coach cap edited via the existing OWNER
  surface (`CoachProfile.ai_monthly_spend_cap_cents`).
- **Prompt rotation:** ship a new file under `prompt-templates/`,
  bump the version string in the service constants, deploy. Old
  recaps keep rendering against their original prompt version.
- **Runbook entry:** added to `docs/deploy-runbook.md` under
  "AI features."
