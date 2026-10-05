# B-SPLIT-COACHLESS-121 — split backend #657 coachless / featured coach / coach-code redemption (agent 121)

Job: JOBS121.md "B-SPLIT-COACHLESS-121". T4 (auth, money-adjacent). Split only; no behaviour change beyond the main-merge resolution.
Stack lock: ops/lanes121/locks/coachless (taken 12:39 PDT 10-05).
Worktrees: /home/user/workspace/wt/B-SPLIT-COACHLESS-121-1 (reference M, deps linked), -2 (piece builds).
Tools: ops/split/B-SPLIT-COACHLESS-121/{plan.json,build.sh,fixture_subset.py,bodies/,prs.txt}.

## Source
- Original #657 head c25960a8b82ed4dd6bea0b7da9f1d77ce783078d (annex/a1-coachless-be), merge-base 53b6d472, 27 files +3,184. Never
  reviewed (bot comments only). DIRTY vs main 5da537d6.

## Main merge (reference M = f3f0d659ecb4ad098ff65f454b8ada12be39a5c9, branch agent121/coachless-split-0-merged-reference; tree 0279a4f5)
- 4a072edf = merge of main 5da537d6 into c25960a8 (textual conflicts, all both-sides additions, resolved as unions):
  1. .github/fly-env-desired-state.json (2 hunks: flags + notes): FEATURE_COACHLESS_HOME next to main's COACH_WELCOME_SCHEDULER_ENABLED /
     WORKOUT_REMINDERS_ENABLED.
  2. docs/runbooks/launch-flags.md (1 hunk): FEATURE_COACHLESS_HOME row next to main's two #609 rows.
  3. .github/workflows/ci.yml (1 hunk, rls-live-tests): coachless step (+ own NODE_OPTIONS env) before main's #609 and A-636-1 steps.
- f3f0d659 = semantic resolutions required by main-only gates:
  4. src/account-deletion/account-deletion.manifest.ts (A-608-1 erasure-manifest-coverage): CoachCodeRedemption.user_id delete,
     CoachCodeRedemption.coach_id delete (ledger row replays the erased coach's card), CoachlessPromptState.user_id delete,
     FeaturedCoachConfig.coach_user_id / updated_by_user_id detach (singleton stays; matches FK SET NULL).
  5. src/coachless/coach-code-redemption.service.ts (no-pii-in-logs C-700-2: new files have no exception-text baseline): two log
     calls print describeFailure(err).

## Inherited red (found 13:2x: #657's own CI at c25960a8, run 37082215722, was red on two required checks) — fixed in the owning piece
6. build-and-test: test/roles-enforced.spec.ts, 5 CoachlessController routes ungated. Fix e3368cc3 (split 3): class-level
   @Roles('student', 'coach', 'owner', 'sub_coach') (OnboardingController form); behaviour unchanged (all roles still reach the
   handlers, which answer non-students specifically). Local: roles-enforced 2/2 on M' (heavy.sh).
7. rls-live-tests: test/rls/coachless-rls.spec.ts anon case got 42501 (anon cannot EXECUTE app.is_owner). Fix d90b4842 (split 1): accept
   zero rows OR 42501 (main's clinic-engagement-rls.spec.ts rule); a visible row still fails. Migration unchanged. Needs CI (no local PG).
Reference M' = fcdc1d6c08481f088377abfea8c9e9b894fc9d31 (= M + cherry-picks of the two fixes; branch agent121/coachless-split-0-merged-reference).

## Pieces (drafts opened 13:05 PDT; fix round pushed 13:31 as new commits + merges, no force-push)
| k | PR | branch | head | base | size | contents |
|---|---|---|---|---|---|---|
| 1 | #721 | agent121/coachless-split-1-schema-rls | d90b484278f432e6e73e41326dc31cadc8892999 | main | 808 | migration+down, schema, manifest, live RLS spec (+fix 7), ci.yml step |
| 2 | #722 | agent121/coachless-split-2-featured-home | c219d2f391c37edd700d5204f31b50286f280d82 | split-1 | 1,290 (851 non-test) | flag (env rule, fly, runbook, feature-flags key), errors, guard, lookup, featured-coach, prompt, home services, home spec, fixture variant |
| 3 | #723 | agent121/coachless-split-3-redeem-routes | e3368cc3cbb0961326ddf147728f7fc32d884188 | split-2 | 1,117 (751 non-test) | redemption service, DTOs, controllers (+fix 6), module, app.module, README, redemption spec, fixture restore |
Top tree of split-3 == tree of M' (31ad366ffca001ef47446b9ad2374935b0c2f566); git diff M split-3 = the two fixes (+16/-1).
First heads (5bd16994 / 619c28a6 / 2e649446; top tree == M tree 0279a4f5): their queued CI runs were cancelled at 13:31.
Only non-M' file in any piece: split-2 fixture omits the redemption import/construction (restored in split-3, +8/-1).

## CI / evidence
- Lane ci/B-SPLIT-COACHLESS-121-1 (run 37365581470) cancelled 13:10 (redundant with PR CI; runner incident).
- Local heavy.sh on M (f3f0d659): coachless-home + coach-code-redemption, erasure-manifest-coverage, manifest-fk-order, no-pii-in-logs,
  fly-env-manifest, feature-flags service + controller: 8 suites pass (163 tests); roles-enforced FAIL (inherited, fix 6). On M':
  roles-enforced 2/2. tsc at 2.5 GB heap OOM; rerun at 4 GB queued (ops/aud-121/B-SPLIT-COACHLESS-121/tsc-Mprime.log).
- Piece 2 local (fixture variant): ops/aud-121/B-SPLIT-COACHLESS-121/jest-piece2.log.
- PR CI #721-#723 at the new heads: queued (GitHub runner incident).

## Decisions for the operator
- D1: migration name 20270301000000_coachless_featured_coach (A3 annex reservation) shares its timestamp with two applied migrations
  and sorts before the applied 20270301000000_notification_zone... and 20270311000000. prisma migrate deploy applies unapplied
  migrations regardless of order; nothing in it depends on a later migration. Recommended default: keep the name (rename = behaviour
  change; deploy with migrations=apply-migrations when the stack ships).
- D2: CoachCodeRedemption.coach_id erasure = delete (vs detach + null response). Recommended default: delete (the stored response holds
  the erased coach's card).

## Mobile (main b79ca594) — which screens use this backend feature, what is missing for day 1
No mobile file calls any /coachless/* or /admin/featured-coach route; no mobile PR for A1-COACHLESS is open.
- Client Home: src/screens/client/HomeScreen.tsx has no coachless banner / featured-coach card / scripted Roman card.
- Flag: src/api/featureFlagsApi.ts SERVER_FEATURE_FLAG_KEYS (l.44-49) lacks 'coachless_home'.
- Coach-code entry after signup: only day-one pairing exists (src/screens/day-one/CoachPairingScreen.tsx + src/screens/day-one/api.ts
  pairWithCoach -> POST /auth/attach-invite-code, l.87-91; error mapping reads only `reason`, l.45-56). Missing: code sheet calling
  POST /coachless/coach-code/check (instant validation) and /redeem with an Idempotency-Key (UUID, reused on retry), welcome moment
  from the redeem response, hand-off to Day 1 checkout with next.featured_package / packages_available.
- Error copy: no mobile mapping for code_invalid / code_expired / code_revoked / code_exhausted / code_email_mismatch /
  coach_not_accepting / already_attached / role_cannot_redeem / idempotency_key_* / redemption_in_progress / redemption_failed
  (with request_id).
- Roman card: src/screens/roman/RomanChatScreen.tsx and Home need the scripted card with POST /coachless/roman-card/seen and /not-now.
- Owner config: no owner screen for GET/PUT /admin/featured-coach in mobile (owner sets the offer through the API or an admin client).

## Follow-ups (C)
- C-CL-1 src/coachless/coachless.controller.ts: no controller-level spec (guards, throttles, Idempotency-Key header parsing, owner
  route roles). Fix rule: add a controller spec covering 404 coachless_disabled, missing/non-UUID key 400, owner-only admin routes.
- C-CL-2 src/data-export/data-export.service.ts: CoachCodeRedemption and CoachlessPromptState rows are not in the user's data export.
  Fix rule: export the user's own rows (status, outcome, created_at; prompt counters).

## HANDOFF
- State: pieces open as drafts #721/#722/#723 at the heads above; waiting for PR CI (and local tsc); then FIX ROUND 1
  (OPENING) + READY FOR AUDIT on each piece (drafts: ops/split/B-SPLIT-COACHLESS-121/mkcomments.py) and the superseded comment on
  #657 (do not close).
- If a gate fails: fix in the piece that owns the file as a new commit, then merge each branch into the next (no force-push); rebuild
  the reference with the same fix so top-tree equality still holds.
