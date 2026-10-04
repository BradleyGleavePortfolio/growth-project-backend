AUDIT GPT-6.1 Sol — growth-project-backend#672 @ c5e7ed8e35f1e5b88653e5605dded2af8614182d — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1

Reviewer: agent 118, job AUD-SOL-T23-118; independent T4 audit of the full 15-file / 2,977-line T2 piece and round-8 delta, including package CRUD/HTTP/DTO/module boundaries, notification/email additions, the complete notice worker and its tests. [Candidate and round 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977736892)

### Prior findings first

**B-672-4 closes at its reported provider-lifetime boundary:** cancellation reaches the real EmailService/Resend fetch, a stopped operation releases ownership, an abort-ignoring operation retains/renews its fenced lease, and a stable content-bound provider key survives ordinary retries; the retained real-service/intercepted-fetch counterexample and candidate abort/replica controls pass. [Transport and lease fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977736892) [Independent execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

**B-672-3 improves but remains narrowly open at actual push admission:** already-superseded/ended/unstarted obligations retire correctly, and email re-preparation after a push crossing the deadline passes; the two additional committed-state races below still dispatch the old warning. [Round-8 lifecycle controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c5e7ed8e35f1e5b88653e5605dded2af8614182d/test/b-trials-t2-fix-round-8.spec.ts) [Executed acceptance failures](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

Previously closed B-672-1/2 (fresh notice claims and fair delivery paging) and B-656-3/5/7 (missing-notice pagination, tri-state card authority, closed worker diagnostics) remain closed at their reported boundaries; all **15 unchanged prior Sol probes** pass, retaining current mute, staggered-entry, deadline and actual email transport controls. [Prior Sol dispositions](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977306071) [Independent replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

Builder logs independently verified: round-8 before **16 failed / 10 passed**, after **133/133** plus type-check; passing tests are not substituted for the current adverse admission inputs. [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37185289635) [After](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37185318643)

### B-672-3 — narrowed: a committed extension/cancellation during push preparation still emits obsolete charge copy

**File:line:** `src/packages/trials/trial-notice.service.ts:496–530,716–753,904–915`; `prepare()` checks the purchase and builds immutable copy, then the push claims a lease and awaits `getPreferences()`, while `admit()` checks only the old notice deadline and lease room—not current purchase eligibility/card/cancel facts. [Preparation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c5e7ed8e35f1e5b88653e5605dded2af8614182d/src/packages/trials/trial-notice.service.ts#L496-L530) [Push admission](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c5e7ed8e35f1e5b88653e5605dded2af8614182d/src/packages/trials/trial-notice.service.ts#L716-L753) [Admission predicate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c5e7ed8e35f1e5b88653e5605dded2af8614182d/src/packages/trials/trial-notice.service.ts#L904-L926)

**Executed counterexamples, real TrialNoticeService with constraint-aware synthetic tables/transports:** (1) a subscription extension commits during the normal preference await, moving the purchase's trial end from Oct 12 to Oct 14; **one Oct-12 charge push is still dispatched**, although the subsequent email preparation retires the old notice; (2) a cancel-at-period-end commit during that same await still dispatches **“Your card will be charged $49 then”**, despite current cancel state requiring the no-charge copy. [Both behavioral failures](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

These are committed webhook-state changes before provider dispatch, not a demand to retract an already-sent notification or eliminate an unavoidable remote race; neither operation timed out, lost ownership or crossed the original trial deadline. [Executed inputs and observations](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

**Minimal fix rule:** refresh current-trial eligibility and charge/cancel/card copy at the actual channel admission boundary after asynchronous preparation, under the same fenced ownership; retire superseded/terminal work and avoid dispatching a snapshot invalidated during preferences/card/zone preparation.

**Verification:** retain both new tests, add removal/deletion/early-paid changes during preparation, and keep current-trial cancel/no-card, mute, lease-room, transport-abort, fairness and deadline controls passing.

### C-672-1 — recurring/trials integrated-candidate gate retained

`src/packages/packages.module.ts:49–68` exports the trial capability/usage/notice seam; the second stack to land still owes the #680 composition list (one reservation ledger, stale-release path, capability registration, typed trial parameters and unified webhook state), mobile #338 pairing and configured `customer.subscription.trial_will_end`. [Existing integration carry](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977306071) [Builder landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5977778572)

This is a landing condition, not a new standalone blocker or live recurring-checkout approval; #675's keyed-create and trial-field composition is present and its real-HTTP candidate tests pass. [Composed HTTP tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c5e7ed8e35f1e5b88653e5605dded2af8614182d/test/b-trials-t2-idempotent-create-http.spec.ts) [Executed controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

### Evidence, size and CI

No approved-code evidence is reused: original #656 and preceding T2 heads had no Sol APPROVE; the full current piece was read independently. [Original Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/656#issuecomment-5972091723) [Preceding T2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977306071)

Independent test-only child `8fe53f9e418eca8b2f06058b6e065417509e79fa` is based on T3 `df76889fb862095170498dccb23f35db3d116690`; every T2 production source/schema/dependency input is byte-identical to this T2 head, and workflow receipt `243cb9e95ffc8804cf019b076c78002b783b7288` adds only the targeted lane files. [Exact-source execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

That lane reports **3 deliberate acceptance failures / 133 passing controls**: two failures are B-672-3 above; the third belongs solely to T3's cancellation worker and is not a T2 finding. [Independent results](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800)

Applicable stacked candidate checks are green; main-only CodeQL/danger/banned-casts/SBOM are still landing gates, not executed successes here, and deploy-readiness skips by policy. [Candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37185673658) [Check applicability](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977736892)

The piece is **2,977 changed lines**, leaving **23**, not 302, under the strict 3,000 cap; the next fix round must preserve regression coverage and split/restructure before exceeding it. [Current size and stated headroom](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977736892)

No candidate-branch edits, local heavy execution, merge, production action or real provider/customer operation; notes/probes/logs and the full handoff are in `ops/aud-118/AUD-SOL-T23-118/` and `ops/reports/AUD-SOL-T23-118.md`.
