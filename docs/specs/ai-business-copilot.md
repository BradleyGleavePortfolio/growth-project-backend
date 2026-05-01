# Spec: AI Business Copilot for Coaches

> **Status:** Draft (engineer-facing). **Roadmap row:** #44
> (engagement & retention wave; AI surface). **Owner:** backend
> lead.
> **Companion brief:** [`docs/architecture/handoff/44-ai-business-copilot.md`](../architecture/handoff/44-ai-business-copilot.md).
> **No runtime in this PR.** No schema change, no migration, no
> module wiring, no provider key added. The runtime PRs descend
> from this spec, behind `COPILOT_ENABLED`.

This is the engineer-facing specification for the **AI Business
Copilot** — the always-available coach-side assistant that helps
a coach **run their coaching business**. It is deliberately
**broader** than the AI Program Builder (PR #117) and the GP
client assistant (`src/ai/`); the Program Builder writes
*programs* for clients to follow, GP answers a *client's*
nutrition/training questions, and the Copilot helps the *coach*
operate the business: write the offer, draft the onboarding
email, sketch the sales page, propose challenge ideas, draft
content for the community, summarise per-client progress, flag
at-risk members, and surface business-ops next-actions.

The 16-section template follows
[`docs/specs/README.md`](./README.md). Every section closes with
the decisions that must be settled before the first runtime
PR.

---

## 1. Status banner and cross-references

- **Stage:** discovery → spec.
- **Depends on (drafts):** PR #117 (the AI Program Builder
  RFC; the Copilot reuses the `BuilderPromptTemplate` table for
  prompt versioning, the eval CI, the per-coach budget shape,
  and the deterministic-fallback contract; the Copilot is
  emphatically a separate surface, not a re-skin), PR #118
  (Team Mode forward-compat hook on every Copilot-suggestion
  row), PR #120 (lanes #01 flags / #04 data lifecycle / #05
  billing packaging / #06 observability / **#08 AI governance**
  / #10 analytics — Copilot is the canonical first user of the
  AI-governance lane), PR #121 (#22 at-risk detector and #23
  weekly recap are the *primary inputs* to the Copilot's
  per-coach context bundle; #24 coach-AI-voice tone setting
  is reused), PR #122 (mastermind operating model — Copilot
  drafts cohort emails, IRL-event prep packets, etc.), PR #123
  (#30 challenges / #36 messaging — Copilot drafts challenge
  ideas + nudge messages).
- **Reuses (merged):** `User`, `CoachProfile`, `CoachSubscription`,
  `MessageDraft` (for "save this Copilot output as a draft"),
  `AuditLog`, the throttler, `ClientAIContext` (the typed
  client context bundle in `src/ai/`).
- **Out of scope:** any path where the Copilot writes to a
  client-visible surface without coach review. Cross-coach data
  reads (a Copilot session reads exactly one coach's tenant).
  Code generation. Spreadsheet automation that hits external
  APIs (e.g. "Copilot, sync to Google Sheets" is parking-lot).
  Coach-to-coach federation (a Copilot suggestion is per-coach).

---

## 2. WHY — problem in user/business terms

**Coach problem.** A coach with 30 clients spends 70% of their
time on **business** work that isn't coaching: writing the
next month's offer, sketching the sales page, drafting the
onboarding sequence, deciding which client to message because
they've gone quiet, writing the community post that fills the
gap between live calls, summarising a client's progress before
a 1-on-1. The coach is a one-person business and they are the
bottleneck on every non-coaching artefact the business needs.

**Client problem.** Without the operator-side artefacts (a
clear offer, a coherent onboarding, a regular community post,
a check-in nudge), the client experiences the relationship as
"my coach is too busy to talk to me." Engagement collapses
silently, and so does retention.

**Business problem.** This platform already has every input the
coach would type into ChatGPT today: the client roster, the
check-in history, the program, the messaging history, the
billing state, the at-risk signals (PR #121 #22), the weekly
recap data (PR #121 #23), the community engagement (PR #117
adjacent), the events history, the library consumption, the
bounty payouts, the public profile. Re-rendering these as a
**typed Copilot context bundle** and exposing them through a
single coach-side assistant is the highest-leverage AI surface
the platform can build, because the alternative — the coach
typing the same context into ChatGPT every morning — is
strictly worse on every dimension (privacy, fidelity, latency,
audit posture, brand voice).

**Why now.** The Program Builder (PR #117) is shipping the
provider abstraction, the prompt-template table, the eval CI,
and the per-coach budget shape. The at-risk detector (#22) and
weekly recap (#23) are shipping the per-client signals. The
Copilot is the first surface that **composes** all of those
into an always-on coach assistant. Without it, every signal
the platform produces stays in a dashboard tile the coach
forgets to look at.

---

## 3. WHEN — gating conditions for the first runtime PR

PR-1 (schema additions for `CopilotThread` + `CopilotMessage` +
`CopilotSuggestion`, plus a read-only "list my threads"
endpoint behind the flag) cannot start until **all** of the
following are true.

1. **Provider chosen.** Default chat provider is **Anthropic**
   (Claude — same provider as the AI Program Builder per
   PR #117 §10). The Copilot is provider-pluggable from day
   one, with a deterministic fallback that returns a templated
   "Copilot is offline; here is a checklist" response when the
   provider is unset. The choice is recorded in
   `docs/operations/copilot.md` (a future doc).
2. **Per-coach budget shape confirmed.** PR #120 lane #05 has
   accepted the per-coach monthly budget pattern. The Copilot
   reuses the same `coach_id`-keyed counter; defaults: L1
   $0/mo, L2 $20/mo of provider spend, L3 $100/mo. Hard-block
   at 100%; coach-visible warning at 80%.
3. **Prompt-versioning shape confirmed.** PR #117 §3
   `BuilderPromptTemplate` is the single source of truth for
   every prompt the Copilot uses. New prompts ship as new
   template versions; the prior version stays queryable for
   evals.
4. **Eval CI confirmed.** PR #117 §13 eval runner is shared.
   The Copilot adds its own fixture set (200 fixtures across
   the 8 use cases in §6.2) before any prompt template flips
   from `draft` to `active`.
5. **Coach-voice tone setting is queryable.** PR #121 spec
   #24 (coach AI voice) is the source of truth for the
   coach's tone settings (formal/casual, em-dash policy,
   first-person/third-person, banned phrases). The Copilot
   reads it on every prompt assembly.
6. **Per-coach context bundle shape confirmed.** §8 of this
   spec defines `CoachAIContext` — the typed bundle the
   Copilot reads. It is the operator-side analogue of the
   client-side `ClientAIContext` in `src/ai/`. Implementation
   lives in PR-2; the shape is reviewed and frozen before
   PR-1 schema lands.
7. **No-write-to-client posture written.** Every Copilot
   output is a *suggestion* until the coach acts on it. The
   surface never publishes, never sends, never bills, never
   moderates without the coach's explicit confirmation. This
   posture is recorded in `docs/audit-and-gdpr.md` (a future
   edit, not in this PR).
8. **Cross-tenant guarantee.** A Copilot session reads exactly
   one `coach_id`'s data. Service-layer assertion + integration
   test. Prompt assembly never includes another coach's name,
   client list, or numbers.

---

## 4. WHERE — modules, tables, routes touched

### 4.1 New module

`src/copilot/` (peer to `src/ai/`).

| File | Owns |
|---|---|
| `copilot.module.ts` | Wires controller + services. Imported by `app.module.ts` only behind `COPILOT_ENABLED`. |
| `copilot.controller.ts` | `GET /api/copilot/threads`, `POST /api/copilot/threads`, `GET /api/copilot/threads/:id`, `POST /api/copilot/threads/:id/messages` (the chat endpoint), `GET /api/copilot/threads/:id/suggestions`, `POST /api/copilot/suggestions/:id/accept` (writes the suggestion to the appropriate target surface as a *draft*, not a publish), `POST /api/copilot/suggestions/:id/reject`. |
| `copilot.service.ts` | All Prisma reads/writes; the per-coach budget predicate; the cross-tenant assertion. |
| `copilot-context.service.ts` | Builds `CoachAIContext` (typed; per-coach; cached 5 minutes). The operator-side analogue of `ClientAIContextService`. |
| `copilot-prompt.service.ts` | Renders the system + user prompts from `BuilderPromptTemplate` (PR #117 §3). One template per use case in §6.2; tone overlay from PR #121 #24 applied last. |
| `copilot-provider.service.ts` | The provider abstraction. Anthropic by default, deterministic fallback otherwise. |
| `copilot-guardrails.service.ts` | Post-response rewrite: PII scrub (no client name leakage outside the coach's own tenancy), brand-voice scrub (em-dashes per PR #121 #24), fact-check pass (no fabricated client metrics — the response can only reference numbers that appear in the context bundle). |
| `copilot-suggestion.service.ts` | Materialises Copilot output into `CopilotSuggestion` rows tied to one of the 8 use cases. The "accept" path writes the suggestion to the appropriate target (a `MessageDraft` row, a `CommunityPost` draft, an email draft, a bounty draft, etc.) and emits the audit-log row. |
| `dto/*.ts` | DTOs + Swagger. |
| `README.md` | Module orientation. |

### 4.2 New tables (additive, sketched in §8)

`CopilotThread`, `CopilotMessage`, `CopilotSuggestion`,
`CopilotUsage` (per-coach monthly counter; mirror of the
Program Builder's budget table). Every row carries `coach_id`.
Every Copilot row carries the nullable
`acted_by_member_user_id` PR #118 hook.

### 4.3 New env vars (described, not added)

- `COPILOT_ENABLED` — global kill-switch. Default off.
- `COPILOT_PROVIDER` — `anthropic` | `none`. Default `none`.
- `COPILOT_PROVIDER_API_KEY`.
- `COPILOT_PROVIDER_MODEL` — default `claude-opus-4-7`.
- `COPILOT_MAX_TOKENS_PER_RESPONSE` — default 2000.
- `COPILOT_MONTHLY_USD_CAP_L1`, `..._L2`, `..._L3` — per-tier
  caps (defaults $0, $20, $100).
- `COPILOT_PROMPT_CACHING_ENABLED` — default true (Anthropic
  prompt caching reduces both cost and latency for repeated
  coach context).

### 4.4 Mobile + console contract

Coach console is the primary surface (Copilot is a coach tool;
mobile is the client experience). The mobile app does **not**
read Copilot threads.

`POST /api/copilot/threads/:id/messages` is a streaming-friendly
shape: the response uses Server-Sent Events when the provider
is configured, falling back to a single JSON envelope when it
is not. Reuses the existing OpenAPI publication convention.

### 4.5 Files explicitly NOT touched

- `prisma/schema.prisma` — no edit in this PR.
- `prisma/migrations/` — no migration in this PR.
- `src/common/env-validation.ts` — env vars described, not
  registered.
- `app.module.ts` — no module wiring in this PR.
- `src/ai/` — the GP client assistant stays untouched. The
  Copilot is a separate module; it can read GP's `ClientAIContext`
  (via the existing service) for per-client summaries, but it
  does not modify GP.
- `new-website` — out of scope.

---

## 5. WHO — sign-off, on-the-hook, downstream, hard boundaries

| Role | Person / artefact | What they decide |
|---|---|---|
| Founder | Bradley | Per-tier budget caps; whether the Copilot is bundled into L2 or carved into L3 only; whether the Copilot can draft public-facing artefacts (sales page, public profile copy) or strictly internal artefacts (DMs, notes, summaries). |
| Backend lead | (TBD) | Schema; provider; prompt-versioning ownership; whether the eval CI runs per-PR or per-prompt-template-version (spec defaults to per-template-version, which matches PR #117). |
| Coach console | (TBD) | Chat UI shape; the "accept suggestion → write to draft" flow shape; per-thread title summarisation. |
| Mobile | (TBD) | Out of scope for v1. Copilot is coach-only. |
| Pager | OWNER | First 30 days. Provider outages must not break the coach console; the deterministic fallback returns a templated checklist. |
| Hard boundaries | — | (a) Copilot never writes to a client-visible surface without coach review. (b) Copilot never reads cross-coach data. (c) Copilot never composes a prompt that includes another tenant's PII. (d) Copilot never auto-bills, auto-moderates, auto-publishes. (e) Copilot does not run code; it does not execute SQL; it does not call internal APIs on the coach's behalf. (f) `new-website` stays untouched. |

---

## 6. WHAT — already exists, net-new, non-goals

### 6.1 Already exists (reused)

- The provider abstraction pattern in `src/ai/` (typed context,
  prompt assembly, post-response guardrails, deterministic
  fallback).
- The `BuilderPromptTemplate` table (PR #117 §3) for prompt
  versioning.
- The eval CI runner (PR #117 §13).
- The per-coach budget pattern (PR #120 lane #05).
- The audit-log convention (`AuditService.write`,
  `AuditAction` constants).
- The at-risk detector (PR #121 spec #22) — the Copilot reads
  its outputs; it does not re-implement the detector.
- The weekly recap (PR #121 spec #23) — the Copilot reads its
  outputs; it does not re-implement the recap.
- The coach-AI-voice setting (PR #121 spec #24).
- `MessageDraft` (the existing per-coach-per-client draft
  table) — Copilot accepts write here.

### 6.2 Net-new — the eight Copilot use cases

The Copilot ships eight closed-vocabulary use cases, each with
a dedicated prompt template version, eval fixture set, and
acceptance target. Each row in `CopilotSuggestion.kind`
matches one of:

| # | Kind | Goal | Accept-target |
|---|---|---|---|
| 1 | `offer_create` | Draft a new offer (price, deliverables, value props, FAQ) for a tier. | A new draft document in `docs/help/` adjacent to the existing setup checklist (mobile not affected); coach edits before publishing. |
| 2 | `onboarding_message` | Draft the welcome DM + the first-week sequence for a new client. | `MessageDraft` rows (one per scheduled day) tied to the new client. |
| 3 | `sales_page_copy` | Draft the long-form copy for the coach's public profile (PR #121 #27) — hero, value props, testimonials section, FAQ. | A draft on the existing `CoachProfile.bio` field is too lossy; the Copilot writes to a new `CoachProfile.draft_sales_copy` JSON column added in the public-profile spec, not in this spec. v1 returns the draft as a downloadable markdown blob in the suggestion envelope. |
| 4 | `challenge_idea` | Propose 3 challenge ideas (per #30 PR #123 challenges spec) tuned to the coach's vertical and recent at-risk signals. | A draft `Challenge` row (when PR #123 #30 is wired); v1 returns the draft as a structured envelope. |
| 5 | `content_draft` | Draft a community post, an audio drop script, or an email blast on a coach-supplied topic. | A `MessageDraft` (DM blast) or a `CommunityPost` draft row (when `community-spaces.md` is wired). |
| 6 | `client_progress_summary` | Summarise one client's progress over a window (default 30 days): wins, plateaus, suggested next conversation. | A read-only artefact attached to the `CoachGuideline` row for that (coach, client). |
| 7 | `at_risk_insight` | Read the at-risk detector's last run for this coach; for the top-N at-risk clients, draft a personal nudge message + a one-line "why I think they are at risk." | One `MessageDraft` per nudge (coach reviews + sends). |
| 8 | `business_ops_suggestion` | Read the coach's billing state, churn/MRR snapshots (PR #121 #29 revenue dashboard), entitlement tier mix, public profile completeness, library/community usage; surface 3 next-actions ranked by leverage. | A read-only suggestion-list envelope; coach decides which to act on. |

Each kind has:

- A dedicated prompt template version row in
  `BuilderPromptTemplate` (e.g. `copilot.offer_create.v1`).
- A dedicated eval fixture set (≥ 25 fixtures per kind; 200
  total at GA).
- A dedicated acceptance-target shape (in §9).
- A dedicated read-only context bundle subset — the Copilot
  never sees fields the use case does not need (least-
  privilege at the prompt-assembly layer).

### 6.3 Non-goals

- A "Copilot agent" that runs autonomously in the background.
  Every Copilot run is coach-initiated.
- A free-text Copilot that replies to "anything." The eight
  use cases are closed; a free-form chat is out of scope for
  v1 (the coach uses ChatGPT for that, and the platform owns
  the structured workflows).
- Tool-use / function-calling. The Copilot returns text + a
  structured `accept_target` envelope; it does not call
  internal APIs on the coach's behalf.
- Voice input. Speech-to-text is parking-lot; v1 is text-only.
- Multi-tenant federation (e.g. "show me all coaches' average
  revenue"). The Copilot is per-coach.
- Cross-coach analytics (e.g. "what challenge ideas are
  working for other coaches"). Out of scope; introduces a
  privacy / leak risk that is not worth the marginal coach
  benefit.

---

## 7. HOW — rollout plan + smallest first PR + feature flag

### 7.1 Rollout phases

| Phase | What lands | Flag state |
|---|---|---|
| PR-1 | Schema (additive); `GET /api/copilot/threads` returns `[]`; module wired but unreachable. | `COPILOT_ENABLED=false`. |
| PR-2 | `copilot-context.service.ts` builds `CoachAIContext`; one read-only endpoint `GET /api/copilot/context` (debug-only, OWNER-only) returns the bundle so reviewers can verify privacy + completeness. | Flag on for staging; off for prod. |
| PR-3 | Prompt-template versions for kinds #2 (`onboarding_message`) + #5 (`content_draft`); the chat endpoint with provider configured (Anthropic). 50 fixtures × 2 kinds = 100 evals must pass before flipping `active`. | Flag on for one beta coach in prod. |
| PR-4 | Kinds #6 (`client_progress_summary`) + #7 (`at_risk_insight`) — the per-client surfaces. Dependency on PR #121 #22 + #23 being live. | Flag on for ≤5 beta coaches. |
| PR-5 | Kinds #1 (`offer_create`) + #4 (`challenge_idea`) — the higher-stakes drafts. | Flag on for L2/L3. |
| PR-6 | Kinds #3 (`sales_page_copy`) + #8 (`business_ops_suggestion`). Dependencies on PR #121 #27 + #29. | GA L2/L3. |
| PR-7 | Per-coach budget cap enforcement; OWNER alerts; 80%-warning surface; the per-coach monthly counter. | GA. |
| PR-8 | Console moderation surface (delete a thread, redact a suggestion); the OWNER per-coach metrics tile; the eval-suite drift detector. | GA. |

### 7.2 Smallest first PR

**PR-1** ships:

- Schema additions in §8.
- `copilot.module.ts` registered behind the flag.
- `GET /api/copilot/threads` returns `[]` when the flag is
  off.
- One smoke assertion: route mounted + 200 + `[]`.
- OpenAPI export update.

PR-1 carries no provider call, no prompt assembly, no
acceptance target, no `CoachAIContext` build. The seam is
pure schema + route mounting.

### 7.3 Feature flags

- `COPILOT_ENABLED` — required for PR-1.
- `COPILOT_PROVIDER=none` — deterministic fallback for PR-1
  → PR-2.
- `COPILOT_PROMPT_CACHING_ENABLED=true` — Anthropic prompt
  caching is on by default; the cost story collapses if it
  is off.
- All other flags listed in §4.3 land alongside the PR that
  needs them.

---

## 8. Data model sketch (additive Prisma; **not** migrated here) + `CoachAIContext` shape

### 8.1 Tables

```prisma
model CopilotThread {
  id                       String   @id @default(uuid())
  coach_id                 String
  coach                    User     @relation("CopilotThreadCoach", fields: [coach_id], references: [id])
  title                    String                  // ≤ 200 chars; auto-summarised after first reply
  kind                     String                  // closed vocab matching §6.2; "free" reserved but unused in v1
  scope_target_user_id     String?                 // for kind="client_progress_summary" / "at_risk_insight"
  acted_by_member_user_id  String?                 // PR #118
  archived                 Boolean  @default(false)
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  messages                 CopilotMessage[]
  suggestions              CopilotSuggestion[]

  @@index([coach_id, kind, created_at])
}

model CopilotMessage {
  id            String   @id @default(uuid())
  thread_id     String
  thread        CopilotThread @relation(fields: [thread_id], references: [id], onDelete: Cascade)
  coach_id      String                              // denormalised tenancy axis
  role          String                              // "user" (the coach) | "assistant"
  body          String                              // ≤ 32 KB
  prompt_template_id String?                        // links to BuilderPromptTemplate (PR #117) for the assistant turn
  provider_response_id String?                      // Anthropic message id; for replays / audits
  cost_usd_cents Int?                               // cost of this assistant message; null for user turns
  created_at    DateTime @default(now())

  @@index([thread_id, created_at])
  @@index([coach_id, created_at])
}

model CopilotSuggestion {
  id              String   @id @default(uuid())
  thread_id       String
  thread          CopilotThread @relation(fields: [thread_id], references: [id], onDelete: Cascade)
  message_id      String                              // the assistant message that produced this suggestion
  coach_id        String
  kind            String                              // matches §6.2 kinds
  scope_target_user_id String?                        // for per-client kinds
  body            Json                                // structured suggestion body; shape per kind in §9
  status          String   @default("pending")        // "pending"|"accepted"|"rejected"|"expired"
  accepted_target_kind String?                        // "message_draft"|"community_post"|"bounty"|"none"
  accepted_target_id   String?                        // FK by string into the target row
  reviewed_by_user_id  String?                        // coach.id when accepted/rejected
  reviewed_at     DateTime?
  expires_at      DateTime                            // suggestions expire 7d after creation
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  @@index([coach_id, kind, status, created_at])
  @@index([thread_id])
}

model CopilotUsage {
  id              String   @id @default(uuid())
  coach_id        String
  month_key       String                              // "YYYY-MM"
  provider_calls  Int      @default(0)
  total_input_tokens Int   @default(0)
  total_output_tokens Int  @default(0)
  total_cost_usd_cents Int @default(0)
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  @@unique([coach_id, month_key])
  @@index([month_key])
}
```

### 8.2 `CoachAIContext` (the typed context bundle)

The Copilot's prompt assembly reads from one typed bundle —
never raw Prisma in the prompt. The bundle shape is defined in
TypeScript in `src/copilot/coach-ai-context.types.ts` and built
in `copilot-context.service.ts`. The shape is the operator-side
analogue of `ClientAIContext` (`src/ai/`).

```ts
type CoachAIContext = {
  generated_at: string;                     // ISO; for staleness assertions
  coach: {
    id: string;
    display_name: string;
    voice: {                                // PR #121 #24
      tone: "casual"|"formal"|"warm"|"direct";
      em_dash_policy: "ban"|"allow";
      first_or_third_person: "first"|"third";
      banned_phrases: string[];
    };
    profile: {
      vertical: "fitness"|"finance"|"performance_os"|"other";
      bio_summary: string | null;           // ≤ 1KB
      tier: "L1"|"L2"|"L3";
    };
  };
  roster: {
    total_clients: number;
    active_clients_30d: number;
    new_clients_30d: number;
    churn_30d: number;
    at_risk: Array<{                        // top 10 at-risk; from PR #121 #22
      user_id: string;
      display_name: string;
      score: number;
      drivers: string[];                    // closed-vocab strings
    }>;
  };
  business: {                               // from PR #121 #29 revenue dashboard
    mrr_cents: number;
    mrr_30d_change_cents: number;
    open_invoices: number;
    payment_failures_30d: number;
  };
  engagement: {                             // from community + events + library specs
    community_posts_30d: number;
    community_dau_p50: number;
    events_held_30d: number;
    events_attendance_p50: number;
    library_entries_total: number;
    library_consumption_p50: number;
    bounty_payouts_30d_cents: number;
  };
  recent_outputs: {
    last_community_post_at: string | null;
    last_email_at: string | null;
    last_event_at: string | null;
    last_check_in_template_update_at: string | null;
  };
  scope_client?: {                          // populated only for kinds 6/7
    user_id: string;
    display_name: string;
    summary_window: { from: string; to: string };
    check_in_streak_days: number;
    weight_trend: "up"|"down"|"flat"|"missing";
    workouts_completed: number;
    last_message_from_coach_at: string | null;
    last_check_in_at: string | null;
    open_guidelines: number;
    at_risk_score: number | null;
  };
};
```

The bundle is built per-thread on the first message and
cached for 5 minutes. The `recent_outputs` block exists so the
Copilot can suggest "you haven't posted in 8 days" without
fabricating the number.

### 8.3 Schema notes

- `CopilotSuggestion.body` is `Json` (Postgres `jsonb`)
  because the structured shape varies per kind (§9). The eval
  CI validates the shape per kind via JSON Schema.
- `CopilotSuggestion.expires_at` exists so a stale suggestion
  cannot be acted on — the coach reviewing a 30-day-old
  "send this nudge to client X" is more likely to send a
  message that no longer matches the client's current state.
- `CopilotMessage.cost_usd_cents` is recorded per turn so
  `CopilotUsage` can be reconciled against the provider's
  invoice without scraping the Anthropic dashboard.
- `CopilotUsage` is upserted on every assistant turn; the
  unique on `(coach_id, month_key)` makes the increment a
  single SQL statement.

---

## 9. API sketch (routes + envelope + throttling)

All routes under `/api/copilot/*`.

### 9.1 Threads

```
GET /api/copilot/threads?archived=&kind=&cursor=
  → 200 { threads: CopilotThreadEnvelope[], next_cursor: string|null }
  → 423 { error: "feature_locked" }
```

```
POST /api/copilot/threads
  body: { kind: "...", scope_target_user_id?: string, title?: string }
  → 201 { thread: CopilotThreadEnvelope }
  → 422 { error: "validation_failed" }
```

```
GET /api/copilot/threads/:id
  → 200 { thread, messages: CopilotMessageEnvelope[], suggestions: CopilotSuggestionEnvelope[] }
```

### 9.2 Chat

```
POST /api/copilot/threads/:id/messages
  body: { body: string }
  → 200 { message: { role: "assistant", body, ... }, suggestions: CopilotSuggestionEnvelope[] }
  → 402 { error: "monthly_cap_exceeded", remaining_usd_cents: 0 }
  → 423 { error: "feature_locked" }
  → 429 { error: "rate_limited" }
  → 503 { error: "provider_unavailable" }
```

The provider call is async (BullMQ) when the response is
expected to take > 10 seconds; smaller responses are
inline. SSE streaming is the default once the provider is
configured; the SSE channel emits the assistant body as it
streams + a final `suggestions` event.

Throttle: `60/hour/coach` for chat messages. Per-coach
monthly cap is the harder gate.

### 9.3 Suggestions

```
GET /api/copilot/threads/:id/suggestions
  → 200 { suggestions: CopilotSuggestionEnvelope[] }
```

```
POST /api/copilot/suggestions/:id/accept
  body: { target_kind: "message_draft"|"community_post"|"bounty"|"none", target_payload?: { ... } }
  → 200 { suggestion: { status: "accepted", accepted_target_kind, accepted_target_id }, target: { ... } }
  → 409 { error: "already_acted" }
  → 410 { error: "expired" }
```

The accept path **writes one target row** in the same
transaction:
- `message_draft` → writes one `MessageDraft` row per scheduled
  message (kinds 2, 5, 7).
- `community_post` → writes one `CommunityPost` row with
  `visibility='hidden'` until the coach publishes (kind 5).
- `bounty` → writes one `Bounty` row in `paused` (kind 4).
- `none` → no target write; the suggestion is simply marked
  `accepted` (kinds 6, 8 — read-only artefacts).

```
POST /api/copilot/suggestions/:id/reject
  body: { reason?: string }
  → 200 { suggestion: { status: "rejected" } }
```

### 9.4 OWNER-only debug

```
GET /api/admin/copilot/context?coach_id=:id
  → 200 { context: CoachAIContext }
```

OWNER-only; reads the same bundle the Copilot would assemble
for that coach. Used for privacy + completeness review.

### 9.5 Envelopes

```ts
type CopilotThreadEnvelope = {
  id: string;
  coach_id: string;
  title: string;
  kind: string;
  scope_target_user_id: string | null;
  archived: boolean;
  message_count: number;
  suggestion_pending_count: number;
  created_at: string;
  updated_at: string;
};

type CopilotMessageEnvelope = {
  id: string;
  role: "user" | "assistant";
  body: string;
  prompt_template_id: string | null;
  cost_usd_cents: number | null;
  created_at: string;
};

type CopilotSuggestionEnvelope = {
  id: string;
  kind: string;
  scope_target_user_id: string | null;
  body: unknown;                              // shape per kind below
  status: "pending"|"accepted"|"rejected"|"expired";
  accepted_target_kind: string | null;
  accepted_target_id: string | null;
  expires_at: string;
  created_at: string;
};
```

Per-kind suggestion `body` shapes (each is JSON-Schema-validated
by the eval CI):

```ts
// kind: "offer_create"
{ name: string; tier: "L1"|"L2"|"L3"; price_cents: number;
  deliverables: string[]; value_props: string[]; faq: { q: string; a: string }[] }

// kind: "onboarding_message"
{ messages: { day_offset: number; subject?: string; body: string }[] }

// kind: "sales_page_copy"
{ hero: string; value_props: string[]; testimonials_section: string;
  faq: { q: string; a: string }[]; markdown_blob: string }

// kind: "challenge_idea"
{ ideas: { title: string; metric_kind: string; duration_days: number;
  rationale: string }[] }    // 3 ideas

// kind: "content_draft"
{ format: "community_post"|"audio_drop_script"|"email_blast";
  subject?: string; body: string; cta?: string }

// kind: "client_progress_summary"
{ window: { from: string; to: string }; wins: string[]; plateaus: string[];
  next_conversation: string }

// kind: "at_risk_insight"
{ items: { user_id: string; display_name: string; score: number;
  drivers: string[]; nudge_message: string }[] }   // up to 10

// kind: "business_ops_suggestion"
{ actions: { rank: number; title: string; rationale: string;
  estimated_lift: string }[] }   // 3 actions
```

---

## 10. Media / replay storage

The Copilot generates **text only** in v1. No media plane,
no Storage prefix. A future PR could add audio drop generation
(text-to-speech for the coach to publish to the content
library); spec calls it parking-lot.

---

## 11. Member-only access + RBAC + privacy

| Concern | Posture |
|---|---|
| Authentication | `JwksAuthGuard`. Every Copilot route requires the coach role; the OWNER bypasses for debug-only routes. |
| Tenancy axis | `coach_id` on every row. Service-layer assertion: every Prisma read in `copilot-context.service.ts` is `where: { coach_id: ctx.coach.id }`. Integration test: a foreign-coach token hitting `GET /api/copilot/threads` returns 403, never another coach's threads. |
| Entitlement gate | Copilot bundled at L2+ (founder decision). L1 returns `feature_locked`. |
| Provider data sharing | The provider receives the typed `CoachAIContext` block + the coach's user message. **The provider never receives**: another coach's data; client emails, full names, or phone numbers (only `display_name` is exposed); raw billing card data; raw Stripe customer ids; the platform's secrets. The coach's `display_name` is the only PII that crosses the provider boundary. |
| Provider retention | Anthropic no-train default per the existing AI provider posture (PR #117 §11). The contract is recorded in `docs/operations/copilot.md`. |
| GDPR | All four tables in the per-table retention matrix. Account-deletion scrub: hard-deletes `CopilotThread`/`Message`/`Suggestion` rows for the deleted user (whether the user is the coach or a `scope_target_user_id`). `CopilotUsage` is a financial-ledger row and is preserved for the legally-mandated retention window. Export includes the coach's own threads + suggestions, not another coach's. |
| PII in suggestions | `at_risk_insight` and `client_progress_summary` reference clients by `user_id` + `display_name` only. The guardrail asserts no email / phone / full-name regex match; a hit triggers a re-prompt with stricter instructions. |
| Audit-log | Every thread create, message turn, suggestion accept/reject, OWNER debug read writes one row through `AuditService.write` with `copilot_*` prefixes. |

---

## 12. AI governance (prompt versioning, evals, deterministic fallback, drift)

This spec is the canonical first user of PR #120 lane #08
(AI governance). Every Copilot prompt and every Copilot
response is governed by these rules.

### 12.1 Prompt versioning

- Every Copilot system prompt is a row in `BuilderPromptTemplate`
  (PR #117 §3). Naming: `copilot.<kind>.v<n>`.
- A prompt template version is `draft` until its eval suite
  passes; only then it flips to `active`.
- The prior `active` version stays queryable for replay
  (`CopilotMessage.prompt_template_id` references the exact
  version used for the response).
- A new prompt template version cannot reach `active` if the
  eval suite regresses against the prior baseline (locked-in
  format checks; em-dash count, length distribution, JSON
  Schema validity per kind).

### 12.2 Eval CI

- 200 fixtures total at GA, ≥ 25 per kind. Mix of:
  - golden-input → expected-shape ("does the response parse
    as the kind's JSON Schema?");
  - red-team-input ("client wrote me a mean DM, draft a
    response" → assert no offensive output);
  - cross-tenant-input ("write the post like coach Bradley's
    competitor would" → assert no leakage of names of other
    real coaches in the platform);
  - format-check ("all bodies obey the coach's voice
    settings" — em-dash count, banned phrases).
- The eval runner is shared with the Program Builder (PR #117
  §13). Evals run against the deterministic-fallback provider
  (no Anthropic spend in CI) plus a once-per-template-version
  run against the live provider.

### 12.3 Deterministic fallback

- `COPILOT_PROVIDER=none` returns a templated checklist per
  kind (e.g. for `onboarding_message`: "Day 0: Welcome. Day 3:
  Goal-setting check-in. Day 7: First win review." — a
  generic but useful skeleton). The fallback is never empty
  string; it always carries useful structure for the coach.
- The fallback is unit-tested per kind so the surface stays
  functional even with the provider unset.

### 12.4 Guardrails (post-response)

- **PII scrub**: regex-match common email / phone / SSN
  formats; redact any match (the guardrail re-prompts with
  the user's instruction "say it without naming X" if the
  redaction would corrupt the response).
- **Voice scrub**: em-dashes → "-" if `em_dash_policy='ban'`;
  exclamation marks → "." (mirrors the GP guardrail in
  `src/ai/`); banned phrases dropped per the coach's voice
  setting.
- **Fact-check**: numeric fields in `business_ops_suggestion`
  and `at_risk_insight` must appear in `CoachAIContext`; the
  guardrail asserts this and re-prompts on hallucination.
- **Cross-tenant scrub**: the response is scanned for any
  proper-name token that is not `coach.display_name`,
  `scope_client.display_name`, or one of the
  `roster.at_risk[].display_name` entries. A hit re-prompts.

### 12.5 Drift + cost monitoring

- `CopilotUsage` per coach + per month is the cost ledger.
  Coach-visible warning at 80% of cap; hard-block at 100%.
- OWNER metrics tile: `copilot_cost_usd_30d_total_platform`,
  `copilot_cost_usd_30d_p99_per_coach`,
  `copilot_provider_error_rate_30d`.
- A drift-detection cron compares the eval baselines weekly;
  a regression > 10% on any kind's format check fires an
  OWNER alert.

---

## 13. Feature flags + entitlements

| Flag | Default | Gates |
|---|---|---|
| `COPILOT_ENABLED` | off | Whole module. |
| `COPILOT_PROVIDER` | `none` | Provider calls; `none` = templated checklist fallback. |
| `COPILOT_PROVIDER_MODEL` | `claude-opus-4-7` | Model selection. |
| `COPILOT_MONTHLY_USD_CAP_*` | per-tier | Hard-block at 100%; coach-visible warning at 80%. |
| `COPILOT_PROMPT_CACHING_ENABLED` | true | Anthropic prompt caching (cost + latency). |
| Entitlement bundle | tier-gated | L2+ only in v1; founder may relax later. |

Kill-switch: `fly secrets set COPILOT_ENABLED=false`. In-flight
threads stay; new chat messages return `feature_locked`. No
provider call goes out.

---

## 14. Analytics + telemetry

PostHog events:

| Event | Properties |
|---|---|
| `copilot_thread_created` | `coach_id`, `kind`, `scope_target_user_id_present` |
| `copilot_message_sent` | `coach_id`, `thread_id`, `prompt_template_id`, `cost_usd_cents`, `latency_ms` |
| `copilot_suggestion_created` | `coach_id`, `kind` |
| `copilot_suggestion_accepted` | `coach_id`, `kind`, `accepted_target_kind` |
| `copilot_suggestion_rejected` | `coach_id`, `kind`, `reason_class` |
| `copilot_provider_error` | `coach_id`, `provider`, `error_class` |
| `copilot_monthly_cap_warning` | `coach_id`, `pct_used` |
| `copilot_monthly_cap_exceeded` | `coach_id`, `month_key` |
| `copilot_guardrail_triggered` | `coach_id`, `guardrail` ("pii"|"voice"|"fact"|"cross_tenant"), `kind` |

OWNER metrics counter:

- `copilot_active_coaches_30d`.
- `copilot_suggestion_acceptance_rate_30d` (overall + per
  kind).
- `copilot_cost_usd_30d_total_platform`.
- `copilot_provider_error_rate_30d`.
- `copilot_guardrail_trigger_rate_30d_per_kind`.

The weekly recap (PR #121 #23) does **not** read Copilot
events for clients (Copilot is operator-only), but the OWNER
report (`docs/admin-reports.md`) gains a per-coach Copilot
usage row.

---

## 15. Tests, risks, dependencies, acceptance, operator handoff

### 15.1 Tests

- **Unit**: `copilot-context.service.ts` — every roster
  field is sourced from a single Prisma read; the cross-tenant
  assertion is unit-tested. Per-kind JSON Schema validation.
  Per-kind deterministic-fallback shape.
- **Integration**: every route in §9 against a stubbed
  provider. The accept-path writes the correct target row
  (one MessageDraft per onboarding message, one CommunityPost
  draft, one Bounty in `paused`).
- **Smoke**: route mounted; returns `[]` when flag off.
- **Eval**: 200 fixtures at GA. Per-template-version run
  against the live provider, locked baselines.
- **Load**: PR-3 stress-tests the chat endpoint with 50
  concurrent coach sessions; latency p95 < 8s for first SSE
  byte; budget cap predicate is single-SQL upsert.
- **Privacy**: integration test that asserts a foreign-coach
  token returns 403 on every Copilot route. Cross-tenant
  guardrail unit-tested with a fixture that injects a
  competitor coach's name into the prompt — the guardrail
  must re-prompt and not return the leaked name.

### 15.2 Risks

- **Provider hallucination of client metrics.** A response
  fabricates "your retention is 87%". Mitigation: the
  fact-check guardrail re-prompts; the per-kind JSON Schema
  forces structured output where possible.
- **Cost runaway.** A coach uses Copilot every minute.
  Mitigation: per-coach monthly cap; throttle of
  60/hour/coach; OWNER alerts at 80% / 100%; prompt caching
  (Anthropic) reduces per-call cost ~75% on repeated context.
- **Cross-tenant leak via prompt cache.** Anthropic prompt
  caching is per-API-key, not per-coach — but every Copilot
  call passes the coach's `CoachAIContext` as the user
  message, never as a shared system prompt; the system prompt
  is per-kind, not per-coach. Mitigation: the system prompt
  contains zero coach-specific data; cache safety holds.
- **Drift.** A new prompt template version regresses against
  the prior eval baseline. Mitigation: drift detector +
  OWNER alert; the prior `active` version is the rollback
  target.
- **Stale suggestion acted on.** A coach accepts a 14-day-old
  suggestion. Mitigation: 7-day expiry on every suggestion.
- **Acceptance writes the wrong target.** The accept-path's
  target validation is unit-tested per kind; an unknown kind
  returns 422.
- **OWNER debug leak.** The OWNER debug endpoint
  (`/api/admin/copilot/context`) reads any coach's bundle.
  Mitigation: audit-log every read; OWNER-only; bundle
  redacts `display_name` for the at-risk roster (the OWNER
  sees `user_id` only — they can join offline if a triage
  is required).
- **Voice drift.** The coach's tone setting is ignored.
  Mitigation: voice overlay is the **last** prompt rendering
  step; the post-response guardrail re-asserts voice rules.

### 15.3 Dependencies

- Internal: PR #117 (provider abstraction, eval CI,
  `BuilderPromptTemplate`, `CoachAssetChunk` access pattern),
  PR #118 (forward-compat), PR #120 (lanes #01, #04, #05,
  #06, #08, #10), PR #121 (#22 at-risk, #23 weekly recap,
  #24 coach-AI-voice — **all three are required inputs**;
  Copilot does not ship without them), PR #123 (#30
  challenges, #36 messaging — natural acceptance targets),
  `community-spaces.md` (acceptance target for kind #5),
  `events-live-calls.md` (read-only context for kinds #1,
  #4, #8), `replays-content-library.md` (read-only context
  for kinds #5, #8), `rewards-and-bounties.md` (acceptance
  target for kind #4).
- External: Anthropic (default provider); Anthropic prompt
  caching; Redis (existing; for BullMQ async chat path).

### 15.4 Acceptance criteria

- A coach on L2 opens a new thread of `kind='at_risk_insight'`,
  the Copilot reads the at-risk detector's last run, returns
  10 nudges (one per at-risk client) inside 8 seconds (p95),
  the coach accepts 4 → 4 `MessageDraft` rows are written +
  4 PostHog events fire.
- The deterministic fallback (`COPILOT_PROVIDER=none`) returns
  the templated checklist per kind; no path hangs.
- A coach over their monthly cap sees
  `monthly_cap_exceeded` with `remaining_usd_cents=0`; the
  coach console renders an upgrade CTA.
- The cross-tenant assertion holds in 100% of integration
  test runs.
- A revert is a Fly secret flip; in-flight threads remain;
  new chat returns `feature_locked`.

### 15.5 Operator handoff

- **Runbook entry:** `docs/operations/copilot.md` (a future
  doc) covers provider rotation, model pinning, the eval
  drift signal, the OWNER alert protocol, the
  cross-tenant assertion review.
- **Dashboard tiles:** active-coaches-30d, acceptance-rate-30d
  per kind, cost-30d-platform-total, provider-error-rate-30d,
  guardrail-trigger-rate-30d-per-kind.
- **Kill-switch:** `fly secrets set COPILOT_ENABLED=false
  -a tgp-backend-prod`.
- **First 30 days:** OWNER reads
  `copilot_guardrail_trigger_rate_30d_per_kind` daily; any
  kind > 5% triggers a prompt-template review; any kind > 1%
  on the cross-tenant guardrail is a P0 incident.

---

## 16. Decisions that must close before PR-1

1. Provider (Anthropic confirmed; whether to also support
   OpenAI for failover or keep it Anthropic-only). Spec
   defaults: Anthropic only in v1, pluggable interface so
   future failover is mechanical. (Backend lead.)
2. Per-tier monthly cap defaults ($0 / $20 / $100 — confirm
   or revise). (Founder + PR #120 lane #05.)
3. Whether the Copilot is bundled at L2 or carved into L3
   only. Spec defaults to L2+. (Founder.)
4. Whether `sales_page_copy` ships at GA or stays parking-lot
   until the public-profile spec PR #121 #27 is wired. Spec
   defaults: parking-lot to PR-6. (Founder + backend lead.)
5. The eight kinds are closed-vocabulary in v1; whether to add
   a free-form "Copilot, anything" kind in v2. Spec defaults:
   no, keep the structured workflows. (Founder.)
6. Whether the OWNER debug endpoint redacts `display_name` or
   exposes `user_id` only. Spec defaults: `user_id` only, with
   the OWNER joining offline if needed. (OWNER + backend
   lead.)
7. Whether the Copilot can read another coach's *anonymised
   aggregate* signals (e.g. "the median coach posts 4×/week")
   for benchmarking. Spec defaults: no in v1; revisit once
   the benchmarking layer (out of scope) ships. (Founder.)
