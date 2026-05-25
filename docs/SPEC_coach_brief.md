# SPEC — Coach Brief (R43)

**Owner module:** `src/coach/brief/`
**Schema:** `prisma/schema.prisma` (CoachBrief, CoachDailyLog, CoachBriefPreferences, CoachBriefPushLedger)
**Migrations:** `20260525120000_add_coach_brief_tables`, `20260525130000_add_coach_brief_last_push_date`, `20260703000000_add_coach_brief_generation_lease`, `20260703000001_add_coach_brief_push_ledger`, `20260703000002_add_coach_brief_check_constraints`

## 1. Product contract

The Coach Brief is a once-per-day narrative that the TGP platform writes to a coach. It is:

- A short paragraph (3–5 sentences, ≤ 600 chars) generated each morning.
- Voiced in first-person plural as TGP ("we / we're / we've") — TGP is the agent doing the work; the coach is the receiver.
- Addressed to the coach by **first name** in the opening sentence.
- Mode-aware:
  - **solo_coach** — the coach manages their own clients. Brief covers their direct roster.
  - **sub_coach** — the coach is a sub-coach delegated to a head coach. Brief covers only the clients open-assigned to them via `SubCoachAssignment`.
  - **head_coach** — the coach runs a team. **Business-only**: revenue, MRR, dunning queue value, team headcount, sub-coach highlights. **NEVER** client identifiers, client_id, client_name, workout ids, weight logs, or unread message previews. (CPO ruling — see `agent-context/CPO_BRIEFING.md`.)

A deterministic fallback (no Claude) is used when the Anthropic call fails or the model output fails the voice contract validation.

## 2. HTTP surface

All routes are mounted under `/coach/brief` and gated by `JwtAuthGuard + CoachGuard + @Roles('coach')`. The authenticated `req.user.id` is the only coach identifier the service trusts — no client-supplied coach_id is accepted on any endpoint.

| Method | Path                | Purpose                                                                      |
|--------|---------------------|------------------------------------------------------------------------------|
| GET    | `/today`            | Get or generate today's brief. Idempotent via (coach_id, brief_date).         |
| GET    | `/history`          | 30-day history, paginated (`page`, `limit ≤ 30`).                            |
| POST   | `/regenerate`       | Force-regenerate today's brief. Throttled at 3 calls / hour per coach.       |
| GET    | `/log/today`        | Read today's free-text coach log (or empty stub).                            |
| PUT    | `/log/today`        | Create / update today's free-text coach log (≤ 4000 chars).                  |
| GET    | `/log/history`      | 30-day log history.                                                          |
| GET    | `/preferences`      | Read brief notification preferences (notification_time, timezone, enabled).  |
| PUT    | `/preferences`      | Upsert preferences. Timezone must be a valid IANA tz string.                 |

### Response shapes

`CoachBriefResponse`:
```jsonc
{
  "id": "uuid",
  "coach_id": "uuid",
  "brief_date": "YYYY-MM-DD",      // in the coach's local tz
  "status": "pending" | "generated" | "failed",
  "brief_mode": "solo_coach" | "head_coach" | "sub_coach" | null,
  "generated_at": "ISO-8601" | null,
  "summary": null | {              // null when status != 'generated'
    "date": "YYYY-MM-DD",
    "brief_mode": "...",
    "narrative": "string ≤ 600 chars, 3–5 sentences, 'we' voice",
    "brief_context": { /* mode-specific aggregates */ },
    "action_items": [...],          // ActionItem[] for solo/sub-coach
                                    // HeadCoachActionItem[] for head-coach
    "generated_by": "ai" | "fallback"
  },
  "created_at": "ISO-8601"
}
```

`brief_context` for **solo / sub-coach** is `BriefContext`: roster size, check-ins, workouts pending, revenue today cents, dunning_in_progress, etc.

`brief_context` for **head_coach** is `BriefContextHeadCoach`: `team_size`, `team_clients_total`, `total_revenue_today_cents`, `team_revenue_30d_cents`, `mrr_projected_cents`, `dunning_in_progress`, `dunning_amount_cents`, `new_clients_last_24h`, and `sub_coach_highlights[]`. No client-level fields.

`action_items` for solo / sub-coach is `ActionItem[]` (`type`, `client_id`, `client_name`, `detail`, `priority`, `deep_link`). For head-coach it is `HeadCoachActionItem[]` (`type ∈ {team_revenue_review, dunning_queue, team_performance, sub_coach_operations}`, `detail`, `priority`, `deep_link` — **no client identifiers**).

## 3. Generation pipeline

1. `getOrGenerateTodaysBrief(coachId)` resolves the coach's timezone via `CoachBriefPreferences`, buckets today via `bucketDateLocal()`.
2. `generateBrief(coachId, timezone, briefDate, { force })` is the atomic claim path:
   - **Idempotent path**: if `status='generated'`, return the cached row. If `status='generating'` AND `generation_started_at` is fresh (< `BRIEF_GENERATION_LEASE_MS = 5 min`), return pending so the client polls. If the lease is stale, atomically steal it.
   - **Force path**: `updateMany` flips the row to `generating` unless another fresh lease holder exists; concurrent regenerates collapse to one Claude call.
3. `detectBriefMode(coachId)` returns `sub_coach` if `TeamSubCoachAssignment.sub_coach_id` is set (precedence), else `head_coach` if `TeamSubCoachAssignment.head_coach_id` is set, else `solo_coach`.
4. `resolveClientScope` returns the active student IDs in scope:
   - `solo_coach` / `head_coach`: students with `coach_id = req.user.id`.
   - `sub_coach`: students appearing in open `SubCoachAssignment` rows for this sub-coach (see P1-4). `User.coach_id` is **NOT** used for sub-coach attribution.
5. Aggregation:
   - Solo / sub-coach: `aggregateSoloContext` queries check-ins, pending workout approvals, MRR / dunning, weight-log flags, and unread messages. **Unread messages** (P1-5) are scoped by `client_id IN clientIds AND sender_id != coach_id` so sub-coaches correctly see messages stored under the head coach's namespace.
   - Head coach: `aggregateHeadCoachContext` derives team headcount from `SubCoachAssignment` + the head coach's non-delegated direct clients; aggregates revenue across all coach IDs in the team; computes MRR by normalising `package.interval` (year / month) and `interval_count`.
6. `callClaude(ctx)` issues a single Anthropic round-trip with 15 s timeout. Output is normalised (strip code fences and meta prefixes), then validated against the voice contract:
   - 3 ≤ sentences ≤ 5
   - Coach first name in sentence 1 or 2
   - Contains `we / we're / we've / we'll`
   - No markdown, no meta prefix, ≤ 600 chars
   On violation: one repair attempt with the violation reason in the prompt, then deterministic fallback.
7. On success: row `status` flips to `generated`, lease cleared. On failure: row `status` flips to `failed`, lease cleared, next caller can retry.

## 4. Daily push dispatch

- `CoachBriefScheduler` runs every UTC minute (configurable via `COACH_BRIEF_CRON`). When `COACH_BRIEF_NOTIFICATIONS_ENABLED=off` the scheduler is a no-op.
- For each enabled `CoachBriefPreferences` row, the scheduler computes the coach's wall-clock minute in their timezone and matches against `notification_time`.
- Order of operations (P1-2):
  1. Compute the brief and check `brief.summary` — abort the tick if generation is still in-flight (summary is null).
  2. Atomic pre-send claim against `CoachBriefPushLedger` (`last_push_attempt_date != today`). Server-only table (P1-9) so coaches cannot poison the dedup state through their `CoachBriefPreferences` UPDATE policy.
  3. Send push with a 10 s `AbortController` that is plumbed through to `NotificationsService.pushToUser`. Timeout cancels the underlying Expo request (P2-6).
  4. On confirmed success, write `last_push_date = today` for observability.

## 5. Database & RLS

| Table                  | RLS policy                                                                                                |
|------------------------|-----------------------------------------------------------------------------------------------------------|
| `CoachBrief`           | service_role bypass; coach SELECT on own rows only. **No** coach INSERT / UPDATE — server-only writes.    |
| `CoachDailyLog`        | service_role bypass; coach SELECT / INSERT / UPDATE on own rows.                                          |
| `CoachBriefPreferences`| service_role bypass; coach SELECT / INSERT / UPDATE on own row (preferences fields only).                 |
| `CoachBriefPushLedger` | service_role bypass **only**. Coaches have NO direct policy — dedup state cannot be poisoned. (P1-9.)     |

CHECK constraints (P2-4) enforce:
- `CoachBrief.status ∈ {pending, generating, generated, failed}`
- `CoachBrief.brief_date / CoachDailyLog.log_date ~ '^\d{4}-\d{2}-\d{2}$'`
- `CoachBrief.generated_by ∈ {ai, fallback}`
- `CoachBrief.brief_mode ∈ {solo_coach, head_coach, sub_coach}`
- `CoachBrief.narrative` length ≤ 600
- `CoachDailyLog.content` length ≤ 4000
- `CoachBriefPreferences.notification_time ~ 'HH:MM' 24h`
- `CoachBriefPreferences.timezone` length 1–80

## 6. Mobile consumption notes

- Always branch on `summary.brief_mode` before rendering action items: solo / sub-coach renders per-client rows; head-coach renders KPI tiles.
- Treat `status='pending'` as "show a placeholder + poll every ~10 s up to one minute". After that, surface "brief is taking longer than expected" — never block the home screen.
- `generated_by='fallback'` is a valid happy path; render the narrative the same way regardless. The flag is exposed for observability dashboards, not the UI.
- Use the `deep_link` field verbatim — never construct paths from `client_id` on the client side.

## 7. Operational env vars

| Var                                 | Default   | Description                                                                          |
|-------------------------------------|-----------|--------------------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY`                 | (none)    | Required for AI generation. When unset or invalid the deterministic fallback is used. |
| `COACH_BRIEF_NOTIFICATIONS_ENABLED` | `on`      | Set to `off` to disable the per-minute push dispatcher.                              |
| `COACH_BRIEF_CRON`                  | `* * * * *` | Schedule expression for the dispatcher. Override only for non-production debugging.   |

## 8. Cross-references

- Voice contract & CPO ruling: `agent-context/CPO_BRIEFING.md`
- Cross-cutting hard rules: `agent-context/R36_TO_R45_OPERATOR_RULES.md` (R39 idempotency, R44 errors, R45 domain)
- Auditor checklist & catalogue: `agent-context/AUDIT_MANDATE.md`, `agent-context/50_FAILURES.md`
