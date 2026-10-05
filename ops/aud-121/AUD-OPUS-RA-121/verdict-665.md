AUDIT Claude Opus 5.5 — growth-project-backend#665 @ eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5 — VERDICT: REQUEST CHANGES

AUD-OPUS-RA-121 (agent 121). First full T4 review of A2 at this head: client context service, disclosure controller and the lockout route-table line. The tier is T4 because the PR reads health data, PII and the coach thread. **A/B/C = 0/3/3.**

I read all 6 files of `git diff bacd83e1..eb7cb7a8` line by line. For every query I checked the models it reads against main's schema and against the services that own those rows on main: messaging, wearables ingestion/samples, the dunning lockout guard, macros and onboarding. #651 verdicts were used for history only, and no evidence was reused (my lens never approved #651).

### Prior findings assigned to this piece (verified closed in code)
- **B-651-10:**
  - `roman-context.controller.ts:49-74` maps transient Prisma/transport failures (P1001/P1002/P1008/P1017/P2024/P2034, init errors, ECONNRESET…) to a coded **503 ROMAN_CONTEXT_UNAVAILABLE** with retry copy. Anything else becomes a coded **500 ROMAN_CONTEXT_FAILED** with the support path and reference.
  - Logs and Sentry carry only `romanErrorTag`.
  - Copy has no first person, no exclamation marks, and nothing generic.
- **C-651-4:**
  - Expired memo entries are evicted on every lookup, and the memo is capped at 500 entries (`:249-258`).
  - Generation fences exist only while a build is in flight (`:233-241,282-292`).
  - I walked two concurrent builds with an invalidation between them: the stale build answers its own turn and is not stored, and the later build is stored.
- **C-651-7:** the service header (`:26-32`) now describes the narrow booking select. The doc still does not (C-667-1 on #667).

### What holds
- **Tenancy:**
  - The subject is the JWT id.
  - Every query carries `user_id`/`client_id`/`author_id` = caller.
  - Coach-owned rows need DB role and JWT role both `student`, plus a live current coach.
  - CoachingSession selects `title, start_at, end_at, status` only, never `coach_notes_md`, recap, links or provider ids.
  - WearableConnection selects provider, status and last sync only.
  - There are no reads of bloodwork, purchases, invoices, CommunityWin, or other clients' rows.
- **Who sees it:** the disclosure route is `@Roles('student')` with no parameter, so coaches get nothing from this piece. That matches the owner 11:22 rule.
- **Deletion:** there are no new tables. The in-process memo is bounded by a 15 s TTL plus the 500-entry cap.
- **Size and CI:** 2,282 lines (grandfathered, 3,000 ceiling). The A1+A2 tree merges cleanly with current main. All checks that run on a stacked base are green at this head.

### B-665-1: wearable numbers from two connected providers are added together, so Roman states doubled sleep and steps
- **Where:**
  - `roman-client-context.service.ts:550-562` selects `metric, value, start_at, end_at, source_tz` with no provider.
  - `summarizeWearables` (`:1198-1219`) sums STEPS / ACTIVE_ENERGY / SLEEP_* and averages the rest across every row of the day.
- **What main does:** main keeps one row per provider by design. The WearableSample docs say "cross-provider overlap is distinct rows ... resolved at read time". The read-time policy is `IngestionService.resolveBest` (`src/wearables/ingestion/ingestion.service.ts:180-248`): the client's preferred provider for the metric, else the most recently recorded provider. The app's own series use it (`wearable-samples.service.ts:404-417`).
- **Impact:** a client with Apple Health plus Oura (a common pair) gets "last night 12.6 h" for a 6.3 h night and 12,200 steps for 6,100. The post-check then validates replies against these wrong numbers.
- **Probe** (`B-665-1`, RUN_LINK), real `RomanClientContextService` on the persona double:
  - Control: one provider gives 6.3 h. Passes.
  - Adding the same night through APPLE_HEALTHKIT expects 6.3 h and gets 12.6 h. Today's steps expect 6,100 and get 12,200.
- **Minimal fix:**
  - Select `provider` and `recorded_at`.
  - Per metric, keep only the preferred provider's rows (`WearableUserMetricPreference`), else the provider with the newest `recorded_at` in the window, exactly like `resolveBest`, then aggregate.
  - Stay inside the 16-query budget: fold the preference rows into the Q1 user select or reuse an existing query.
  - Add a two-provider test for sleep, steps and HRV.

### B-665-2: GET /roman/context/me gives a locked-out client the coach's paid program
- **Where:**
  - `roman-context.controller.ts:37-50` mounts under `roman/`.
  - The global `DunningLockoutGuard` (`app.module.ts:494`) admits all of `/roman/*` (`dunning-lockout.guard.ts:91,211-214`) *so Roman can explain the lockout*.
  - This PR adds `'roman/context/me'` to `EXPECTED_REACHABLE_WHILE_LOCKED` (`test/dunning-v2-lockout-allowlist-route-table.spec.ts:178`).
- **Why it matters:** the route returns:
  - today's and the next session (exercises, sets, reps, cues);
  - the meal plan;
  - up to 1,500 characters of coach guidelines;
  - the coach-set macro targets;
  - the last 8 coach messages.

  That is the paid value the guard exists to lock ("workouts, programs ... are all 403", `dunning-lockout.guard.ts:18-23`). It also applies to dispute lockouts once R-DISPUTE-PAUSE ("dispute ends access") lands. The spec header says: "do NOT paste the new path in to make it green. Answer 'may a locked-out, non-paying client call this?'". The permitted yes-answers are payment recovery, auth, liveness, the Roman lockout explanation and the AI-consent privacy control, and this route is none of them.
- **Probe** (`B-665-2`, RUN_LINK):
  - `isAllowedWhileLocked(normalizePath('/api/roman/context/me'))` expects `false` and gets `true`.
  - Controls pass: `roman/sessions` stays allowed; `workouts` and `ai/chat` stay locked.
- **Minimal fix:**
  - In the guard, exclude `roman/context` from the Roman carve-out with an exact route prefix.
  - Remove the spec line, so the route-table spec pins it as locked.
  - Add a guard unit test.

  If the operator instead rules that an own-data view must stay reachable, return only the client's own logs while locked: no coach-owned blocks.
- **Note for #668 (not counted here):** the same carve-out grounds a locked client's live Roman turns in the full plan. That belongs to the turn path.

### B-665-3: the coach thread and plan Roman reads are not the thread and plan the client sees (sub-coach rows dropped, blocked author kept)
- **Where:** `roman-client-context.service.ts:407-413` (assignments `assigned_by_coach_id = head coach`), `:489-501` + `:780-788` (messages `sender_id in [head coach, client]`), and `:503-512` (meal plan).
- **What main does:**
  - `User.coach_id` is always the head coach. A delegated sub-coach writes in the head-coach thread with `sender_id = sub-coach`. `messaging.service.ts:296-323` pins the thread to the head coach, and `:746-747` reads: "sender_id = coachId would miss sub-coach messages".
  - The sub-coach assigns programs as itself (`program-delivery.service.ts:225`).
  - The comment at `:486-488` ("a sender outside the pair is impossible by the thread's own invariant") is therefore false.
- **Impact:**
  - For every delegated client, Roman omits the sub-coach's messages and reports "no plan" (`data_quality.missing: plan`) while the app shows one.
  - The read also skips the client's block list. `MessagingService.filterBlockedAuthors` (`messaging.service.ts:389-403`, the Apple 1.2 mirror) hides a blocked coach's messages, but Roman and this disclosure route bring them back.
- **Probes** (`B-665-3`, RUN_LINK), real service with an open SubCoachAssignment:
  - A sub-coach message in the head-coach thread is missing from `recent_messages`.
  - A workout the sub-coach assigned for today is missing from `today_session`.
- **Minimal fix:**
  - Read the thread the way MessagingService reads it for the client: `coach_id = head coach, client_id = caller`, any sender, minus the other party when blocked.
  - Accept plan and meal-plan rows from the head coach or the client's open `SubCoachAssignment` sub-coach.
  - Add both cases plus a blocked-coach case as tests.

### C (follow-ups)
- **C-665-1:** the wearable query at `:560` uses `take: 600` ordered by `start_at desc`, which silently cuts the oldest local day(s). A partial day is then reported as a full day and pulls `avg_7d` down. HealthKit alone sends hourly steps plus hourly active energy (48 rows a day over the 9-day query window) before HRV and sleep. Fix: aggregate per metric/day in SQL, or drop a day the cap cut into and record `wearables.days` in `data_quality.truncated`.
- **C-665-2:** `roman-context-invalidation.ts:7-9` says macro-target and profile writes call the hook, but only `client-ai-context` does. Staleness is bounded by the 15 s TTL. Fix: wire the two writes or correct the comment.
- **C-665-3:** clients in the C05 "simple" macro display (calories and protein only for 7 days when N4 = never; `macros.service.ts:135-150`) still get carbs and fat in Roman's context. Fix: carry `macro_display_mode` so the contract follows what the app shows.

### Day-1 requirement (coach pool debit + client daily cap)
A2 has no turn path. Across #667-#670 and the C2 source branch, nothing under `src/roman` debits CoachAIBudget (`recordUsage`). The turn path is in #668, which the operator is handling separately (report: ops/reports/AUD-OPUS-RA-121.md).

Evidence:
- Lane `audit/AUD-OPUS-RA-121/665-1` at this head plus the probe file only (RUN_LINK, RUN_RESULT).
- Probe source: `test/roman/audit-opus-ra121.probe.spec.ts` (saved at ops/aud-121/AUD-OPUS-RA-121/probes/).

Head re-read immediately before posting: `eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5`. No push to the PR branch, no merge, no production action.
