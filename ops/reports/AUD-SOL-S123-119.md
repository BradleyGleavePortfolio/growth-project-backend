# AUD-SOL-S123-119 — payment sheet P1/P2/P3

Started 2026-10-04 14:00:24 PDT (`TZ=America/Los_Angeles date`).
Independent GPT-6.1 Sol T4 lens; no candidate writes or heavy local execution.

## Current scope

- #342 `e3226f3b50a1f609aea7805600ec124324cd12aa`, 2,207 changed lines.
- #343 `691e0cf02a48db3e2d62f7c502673d9f1ef62215`, 2,935 changed lines.
- #344 `7e17d142d45cfcf6d922b6e78f79881be2428041`, 2,866 changed lines.
- All three grandfathered and under 3,000; observed through GitHub API.
- Claims taken for all three exact heads; detached worktrees created.
- Prior Sol dispositions, GitHub AUDIT/FIX ROUND threads and builder reports read. P1/P2 round-3 runtime deltas and full P3 runtime reviewed.
- B-342-1 residual refusal truth repaired by `e3226f3`; B-343-1 native rejection fence repaired by `691e0cf`. Builder failing-before logs independently inspected, not merely accepted.
- P3 B-344-1/4 original recovery/support counterexamples repaired by `aff733b`; original B-344-2/3 counterexamples pass, but extended stale-active consent and cancel-receipt/newer-read cases are under test.
- [P3 independent replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234402193): 8 suites, 99/99 passed including prior nine panel probes, new regression suite, native fences and all P3 subscription/recur3/screens/contrast suites.
- [P1 initial replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234411781): 44 assertions passed; selected-card theme probe was placed in the wrong harness directory and belongs to P2. Correct P1 core-only replay launched [here](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234634400).
- [P2 initial replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234408086): 82 passed, two historical false-unpaid wording pins failed exactly as builder declared. Updated only those pins to current neutral truth plus explicit no-unpaid assertions; all other recovery assertions unchanged. P2 replay and theme at [this lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234640700).
- Independent P3 authority/consent lane completed with the two residual B failures recorded below. [Execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).

## Confirmed P3 must-fix residuals

- **B-344-2 remains open (extended stale-active case):** `src/components/purchase/YourPlansPanel.tsx:218-237,304-311,363-375` permits End my plan from a cached active card after a failed refresh, then unconditionally promises paid-period access. If the current server state has entered dunning, its cancel route ends access now and voids the unpaid invoice. The prior past_due-specific dialog repaired the original case but not this stale-state consent case. Require truthful conditional consent for active/trialing as well, covering server-side delinquency, or disallow stale action until a verified read and retain race-safe conditional consent. [Executed probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).
- **B-344-3 remains open (extended newer-read case):** `src/components/purchase/YourPlansPanel.tsx:142-148,182-185,316-333` stores the old cancellation outcome string separately and prefers it over every newer plan read. Cancel scheduled → immediate reload fails → another session keeps the plan → Try again returns authoritative active/next charge: stale warning disappears and End my plan returns, but the line still says “Your plan is ended … nothing more is charged.” Store receipt provenance/structured outcome and reconcile it against each authoritative successful read; preserve receipts during failure, but never let them replace contradictory current financial state. [Executed probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).
- Authority lane: 2 failed / 23 passed / 25 total. The two controls pass and all nine old Sol panel probes plus 12 builder recovery tests still pass; new failures are candidate assertions, not infrastructure.

## Posted verdicts (updated 2026-10-04 14:15:45 PDT)

- #342 `e3226f3b50a1f609aea7805600ec124324cd12aa`: **APPROVE, A/B/C 0/0/6**, immediate head read before posting; ordinary CI + Analyze green. [Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5984430347).
- #344 `7e17d142d45cfcf6d922b6e78f79881be2428041`: **REQUEST CHANGES, A/B/C 0/2/3**, immediate head read before posting; ordinary CI green, Analyze absent on stacked base; residual B-344-2/3 above. [Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984430303).
- #343 `691e0cf02a48db3e2d62f7c502673d9f1ef62215`: **APPROVE, A/B/C 0/0/6**, immediate head read before posting at 2026-10-04 14:15:22 PDT; ordinary CI green, main-only Analyze still a composed-tree gate. [Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984457482).
- P2 initial 82 passes/2 historical wording pins; second 84 passes/1 historical absence-of-support pin. That third pin is also superseded by B-342-1's required uncertainty support. Positive support presence now pinned (not weakened); final targeted replay **3 suites, 36/36 passed**, including all openPlanAction, native rejection and theme probes. [Final targeted replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235076652).
- Correct P1 replay: **7 suites, 72/72 passed**. [Exact-runtime execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234634400).

## Follow-ups (C)

Freeze applies; no candidate C changes made.

### P1 carried (six)

- C-342-1 `src/lib/planTerms.ts:90-93`: zero recurring price legacy combo; require recurringAmount > 0.
- C-342-2 `src/api/clientPaymentsApi.ts:347-353`: trial exposure; land P1–P3 together.
- C-342-4 `src/lib/packagePayment.ts:1008-1020`: trial usage/in-progress replies need trial-specific next actions, key retained.
- C-342-5 `src/lib/packagePayment.ts:516-517`: free-trial setup should not be called a payment.
- C-342-7 (outside diff) `src/screens/coach/payments/CoachPackageEditScreen.tsx:110,133,299`: currency-aware load/parse round trip; zero/three decimal + ISK/UGX controls.
- C-342-8 `src/lib/packagePayment.ts:459-460,795-799`: neutral no-answer wording and unknown-exception diagnosis instead of inferring reachability.
- Inventory evidence: [prior P1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5983977653).

### P2 carried (six)

- C-343-1 `src/hooks/usePackagePurchase.ts:509-560,601-693`: important suite placement in P3; replay each lower-piece round.
- C-343-2 `src/hooks/usePackagePurchase.ts:378-405`: device-test 3DS redirect and wire handleURLCallback if necessary.
- C-343-5 `src/hooks/usePackagePurchase.ts:1117-1151`: epoch-own the in-flight guard to allow a new-account tap while an old await is held.
- C-343-6 `src/components/PackageSelectionSheet.tsx:235-258,324-339`: done/status state after PAYMENT_ALREADY_COMPLETE instead of live pay CTA.
- C-343-7 `src/components/PackageSelectionSheet.tsx:247-252,317-322`, `src/screens/client/Day1WinScreen.tsx:190-194,229-233`, `src/navigation/RootNavigator.tsx:908-912`: wire Membership destination after onboarding.
- C-343-8 (S1-owned) `src/lib/packagePayment.ts:492-493`: replace support's promised outcome with “so the team can check it.”
- Inventory evidence: [prior P2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984020426).

### P3 Sol inventory (three; C-344-3 closed on same B lines)

- C-344-1 `src/screens/client/ClientPackagesScreen.tsx:257-272`: final lockout composition retains the native Update card screen. [Prior P3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982674874).
- C-344-12 `src/lib/planActions.ts:98-99,161-162,231,237-238`: no HTTP status proves no answer, not offline/unreachable; neutral wording and sanitized unknown-error reporting, preserving refresh/support. [Builder's exact implementation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984026424).
- C-344-13 `src/lib/planActions.ts:186-195`: SUBSCRIPTION_SETUP_UNAVAILABLE is known preflight refusal for resume but mapped as unconfirmed; own truthful capability/unchanged guidance, preserving support. [Builder's acknowledged follow-up](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984026424).
- Also ticket other-lens C-344-5/6/8/9/10/11: authoritative share terms; CTA accessibility label; amount/date at Keep; first-person/card privacy copy; module-load trial date; share-token analytics. They are not added to the Sol count. [Prior Opus inventory](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982759668).

## Cross-lane integration decision — not a new blocker assigned to mobile

The new dispute-pause backend ends entitlement while retaining subscription status, but recurring `subscription-plan.ts:353-362` currently maps a formerly active/trialing row with `entitlement_active=false` to confirming. P3 then says “Confirming this plan with Stripe. It shows here within a minute.” The dispute-pause /billing contract has reason=dispute_paused, access_ended=true, billing_paused=true, restart_by=coach, but the subscription list/view lacks that distinction. Route the authoritative state fix to recurring/dunning and propagate the agreed view through mobile normalization/rendering. Do not claim dispute-paused plans confirm within a minute or invite automatic client restart; copy must say access ended, billing paused, coach decides on restarting. Default: resolve this cross-stack contract before integrated release, without incorrectly counting another PR's owned finding against P3. [Recurring owner PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679), [dispute-pause owner PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705).

## Evidence preservation and cleanup

- Saved every verdict body, outbound JSON, GitHub receipt/re-read, prepost check snapshot, failing-before log, own CI log, source test/patch and branch bundle under `ops/aud-119/AUD-SOL-S123-119/`. Posted comment bodies re-read and byte-compared to saved verdict bodies. [P1 receipt](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5984430347), [P2 receipt](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984457482), [P3 receipt](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984430303).
- `restack-proof.txt` confirms clean merge-tree equality for `40b8573` and `7009196`; new P3 product files remain byte-identical to FR3 after FR4. [Builder restack record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984292690).
- `probes-final.bundle` preserves all seven remote wrapper tips; bundle verification passed before cleanup. `probe{342,343,344}-final.patch` plus standalone planAuthority/native/recovery/openPlanAction specs preserve the test additions and three documented superseded-pin adaptations. [P1 run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234634400), [P2 final run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235076652), [P3 failing run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).
- Cleanup completed 2026-10-04 14:15:45 PDT (from `TZ=America/Los_Angeles date`): own seven `audit/AUD-SOL-S123-119/*` remote refs deleted, no matching local refs remain, own three worktrees removed; no evidence/candidate files were lost. Receipt: `cleanup.log`; bundle and patches remain. All own CI runs completed; no running lane left. [Completed final P2 lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235076652), [completed P3 lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).

## HANDOFF

Completed. One Sol verdict posted per assigned exact head after immediate head re-read:

| PR | Audited full head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #342 | `e3226f3b50a1f609aea7805600ec124324cd12aa` | APPROVE | 0/0/6 | [P1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5984430347) |
| mobile #343 | `691e0cf02a48db3e2d62f7c502673d9f1ef62215` | APPROVE | 0/0/6 | [P2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984457482) |
| mobile #344 | `7e17d142d45cfcf6d922b6e78f79881be2428041` | REQUEST CHANGES | 0/2/3 | [P3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984430303) |

Required ordinary CI green at all three audited heads; P1 Analyze green, P2/P3 main-only Analyze missing on stacked bases and still required on the composed main-based candidate. Own CI: P1 72/72, P2 final subset 36/36 (other replay assertions pass apart from superseded historical pins), P3 integrated 99/99, adversarial P3 2 failed/23 passed. Synthetic native/transport mocks are not live Stripe/device acceptance. [P1 ordinary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232747197), [P1 Analyze](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232747242), [P2 ordinary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232961197), [P3 ordinary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233295816), [P1 probes](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234634400), [P2 probes](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235076652), [P3 controls](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234402193), [P3 counterexamples](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).

**Operator next step / recommended default:** hold integrated landing; fresh P3 builder repairs residual B-344-2 stale-active cancellation consent and B-344-3 receipt authority, replays `planAuthority.test.tsx` plus all old controls, then fresh dual exact-head P3 review. Keep unified refusal wording, truthful current-production coach fallback and currency fix; accept size-driven P3 test placement; ticket the 6/6/3 Sol Cs plus other-lens inventory instead of broadening this round. Land P1–P3 only as one after final-main Analyze, recurring deployment, dunning D4 #690 and native card-update composition. Route the dispute-paused subscription-view contract to recurring/dunning before integrated release; never call a paused plan a within-one-minute confirmation or automatic client restart. [P3 verdict/fix rules](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984430303), [recurring contract owner](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679), [dispute-pause owner](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705).
