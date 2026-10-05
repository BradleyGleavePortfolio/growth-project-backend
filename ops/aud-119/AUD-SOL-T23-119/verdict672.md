AUDIT GPT-6.1 Sol — growth-project-backend#672 @ 2690c07c1f418f3ec2a79ba93a2ffa9748698a48 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/1

Reviewer: AUD-SOL-T23-119, agent 119. Independent T4 review of T2 source, package CRUD/DTO/controller/module composition, notice/email transports, tests and the complete round-9 delta; no approved-code evidence reused because this lens never approved original #656 or a preceding T2 head. [Previous Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982319373), [Original Sol](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/656#issuecomment-5972091723).

### Prior findings first

The previous **B-672-3 extension/cancel-during-preferences counterexamples now pass**: admission rebuilds the copy after claim/preferences, and the purchase is read after the other preparation reads; all **17 unchanged prior Sol probes pass**, including both of those races. [Round-9 implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982762148), [Independent replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228826610).

Previously closed B-672-1/2/4 and B-656-3/5/7 remain closed at their reported lease-clock, paging, actual email abort/lifetime, reconciliation, tri-state unknown-card and closed-worker-diagnostic boundaries; the unchanged prior probes and candidate controls pass, but B-672-3 remains narrowly open on the customer-card preparation input below. [Prior dispositions](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982319373), [Independent controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228826610).

Builder round-9 failing-before evidence is real: 7 T2 admission regressions failed on the preceding T3/T2 source; the current T2 passing-after run reports 93/93 and the T3 run reports 183/183, without proving the additional input below. [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221109080), [T2 after](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221167230), [T3 after](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221153162).

### B-672-3 — narrowed: the only customer card can be removed during final preparation, yet the push still promises a charge

**File:line:** `src/packages/trials/trial-notice.service.ts:487–501,718–728,891–900`: `prepare()` caches `customerCard`, then awaits the purchase read, and derives the sent copy from that cached card result without a coherent current purchase/customer-card snapshot. [Preparation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2690c07c1f418f3ec2a79ba93a2ffa9748698a48/src/packages/trials/trial-notice.service.ts#L487-L521), [Admission/send](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2690c07c1f418f3ec2a79ba93a2ffa9748698a48/src/packages/trials/trial-notice.service.ts#L703-L739).

**Executed counterexample:** a started, unended trial has `card_on_file=false` and one customer default card; after admission reads that customer card, its removal commits during the final purchase read, before dispatch; actual TrialNoticeService still sends **“Your card will be charged $49 then”**, although no subscription or customer card remains. [Behavioral failure](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228826610).

This is a committed local billing-state change during asynchronous preparation, not a demand to retract a message already dispatched; moving purchase truth last fixed the prior purchase races but moved the stale-state opportunity to customer-card truth. [Executed input](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/817b92b8).

**Minimal fix rule:** derive current trial eligibility and both card authorities from a coherent admission snapshot, or detect/retry an invalidated preparation; do not merely swap two sequential reads and leave the other authority stale. Preserve fenced ownership, unknown-state deferral, mute, end-date and lease-room guards.

**Verification:** retain all 17 prior probes and the new `customer-card truth across final preparation` test; cover customer-card addition/removal and purchase cancellation/extension around preparation on both push and email. New tests belong in T3 under the existing size decision.

### C-672-1 — integrated recurring/trials qualification retained

`src/packages/packages.module.ts:49–68` still exposes the integration seam: the combined #680/trials candidate must prove one reservation/release authority, capability registration, typed Stripe trial parameters, unified webhook truth, never-billed-trial exclusion from MRR/churn, mobile #338 pairing and configured `customer.subscription.trial_will_end`; this is not standalone approval of live native recurring checkout. [Existing integration carry](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982762294), [Prior Sol gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982336690).

### Evidence / size / CI

Independent test-only child `817b92b8` is based directly on T3 `5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d`; its T2 production, schema and dependency inputs are byte-identical to this T2 head, and receipt `0f3f082d883baaab723e4d9e333c557cf1191d47` adds only lane files. [Execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228826610).

Eight selected suites report **4 deliberate behavioral failures / 142 passing controls**: one failure is the T2 customer-card race above; three belong only to T3 cancellation and are not counted on this PR; no compilation or fixture failure is counted as a finding. [Independent results](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228826610).

Applicable exact-head stacked checks pass; deploy-readiness-gate is skipped, and main-only CodeQL/danger/banned-casts/SBOM remain landing gates rather than executed successes here. Size **2,961** leaves **39** lines under the hard cap; the operator already posted KEEP, with added tests assigned to T3. [Candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221525917), [SIZE ASSESSMENT](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982776121).

Other-lens optional follow-ups remain tracked in the report rather than relabeled or double-counted; no candidate-source edits, heavy local execution, real provider operation, merge or production action.
