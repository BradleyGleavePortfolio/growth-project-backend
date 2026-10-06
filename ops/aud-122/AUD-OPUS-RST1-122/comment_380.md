AUDIT Claude Opus 5.5 — growth-project-mobile#380 @ b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 — VERDICT: APPROVE

AUD-OPUS-RST1-122, agent 122. First review, RUTHLESS SCOPE (SoT A2 items 1-11). A 0 / B 0 / C 6.

Scope read: all 4 files (549 lines, base m#354 branch agent115/lockout-split-3-card-update-tests @ be5c74b1, merge-base equal). Backend reference b#687 @ 2f11f14b (b#690 restart route landed): `dunning-restart.controller.ts`, `DunningV2Service.restartAfterDisputePause` / `restartCandidate` / `restartUnderLease`, `CoachPurchasesController.list`, `CoachPaymentOpsController.getOwn`, `coach-payments.select.ts`. CI at head: "Typecheck, lint, test" success. Size 549 (under 1,500).

Job checks:
1. Button only for a dispute-paused plan of this coach's client: yes. The roster read (`GET /v1/coach/purchases`, server-scoped to `coach_user_id = caller`) filters to this `clientId`, recurring, access off, not ended; each candidate is then confirmed on `GET /v1/coach/payments/purchases/:id` (also caller-scoped). `isDisputePaused` (coachDisputeRestart.ts:65) is the same test as the backend's `restartCandidate` not_paused check (dunning row `active` + `charge_disputed` + `entered_at`), plus recurring and not ended. `clientId` on ClientDetailScreen is the client's user id (ClientsListScreen passes `item.id`), so it matches `client_user_id`.
2. Confirm step: yes, `Alert.alert` with Cancel / Restart plan (DisputePausedPlansCard.tsx:61); Cancel changes nothing; button disabled while a restart is in flight.
3. Success refreshes the state: yes. On `{ restarted: true }` the plan shows "Plan restarted" with the success sentence and no button; pull-to-refresh re-reads (backend resolves the dunning row, so the card goes away). Nothing else on the screen shows dunning state, so nothing stale remains. Success copy matches the backend: `entitlement_active: true` and Stripe collection resumed.
4. Each refusal is one true sentence: yes. Backend throws `{ code, error, message }`; the mobile reads `code` and maps PURCHASE_NOT_FOUND, PLAN_NOT_DISPUTE_PAUSED (also flag_off), PLAN_ENDED, OTHER_LIVE_PLAN, NEW_DISPUTE, BILLING_BUSY, BILLING_UNAVAILABLE (also billing_resume_failed) to the same sentences the backend sends. Final ones hide the button, temporary ones keep it. The response interceptor keeps `error.response` for 404/409/503, so the mapping is reached. No first person, no exclamation marks.
5. No client-side path restarts someone else's plan: the only ids sent are from the caller's own roster, and the backend refuses any purchase whose `coach_user_id` is not the caller with 404 before any Stripe call (owner role included). Clients get 403 from CoachOrOwnerGuard.

Cs (follow-ups, none block):
- C-380-1 C (edge, deferred to 10k clients): card body says "its billing is paused" without the backend's `billing_paused` flag (pause recorded but not yet confirmed at Stripe); `billing_paused_at` is not in COACH_DUNNING_SELECT.
- C-380-2 C (edge, deferred to 10k clients): roster read stops at 5 pages x 100 purchases (coachDisputeRestart.ts:28), so a coach with more than 500 purchases may not see an older paused plan.
- C-380-3: each client-detail open reads the whole roster (sequential pages) plus one detail per candidate; a backend `client_user_id` filter or a "dispute-paused for client" read would be cheaper.
- C-380-4: an unmapped error shows the server's raw `message` (coachDisputeRestart.ts:179); for a 5xx `INTERNAL` that can be technical text. Map 5xx to UNKNOWN_REFUSAL.
- C-380-5: the commit and file header say this is "the screen the coach dispute alert opens", but no coach push routing to ClientDetail exists in mobile; the coach email ("open Clients, then {clientName}") does match the placement. Follow-up: deep link the coach dispute push to ClientDetail.
- C-380-6 C (edge, deferred to 10k clients): if `clientId` changes on a mounted screen, the previous client's card shows until the new read returns (plans are not cleared on change).

Normal-user story checked: a coach opens Clients, taps the client whose bank disputed a payment, sees "Plan paused after a payment dispute or inquiry", taps Restart plan, confirms, and sees "Plan restarted. Billing has resumed on its usual schedule and the client has access again."
