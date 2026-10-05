AUDIT GPT-6.1 Sol — growth-project-backend#688 @ 6627044cce3c7a210099b77b72e53f782cba2801 — VERDICT: REQUEST CHANGES
A/B/C = 0/5/0

T4 independent full-piece audit of cadence, dispatcher, the complete v2 service, legacy hooks, both changed specs and their callers/transport contracts; operator KEEP is 2,875 changed lines. [D2 scope and assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975773031)

### Prior findings and evidence applicability

Earlier Sol B-628-6/8 closure covered ordinary row-claim/stale-receipt and multi-dispute cases; C-628-12's qualified at-least-once transport documentation remains present. The latest Sol B-628-11 is a D3 settlement-classifier finding, not a D2 finding, and is not adjudicated here. No original Sol APPROVE is reused; the six D2 files are byte-identical to their original `dc47e0ef` counterparts, but every line is reviewed independently. [Prior closure scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5965086662) [Latest Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972111414) [Original fix/split provenance](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418)

FIX ROUND 8's B-628-13 marker-preservation fix handles a subsequent ordinary decline, but its newly recorded-obligation predicate has the lost-dispute gap in B-688-5 below; a passing original failing-before bundle does not establish that additional boundary. [FIX ROUND 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418) [D2 lost-dispute probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

### B-688-1 — stale Day-10 worker can lock a newly reopened Day-0 cycle

`src/checkout/dunning-v2/dunning-v2.service.ts:825–879` awaits purchase/provider evidence but its terminal CAS at 872 matches only row ID, active status, null lock and null cancel marker, not the cycle's `entered_at` or a cycle/version fence. [Lock implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.service.ts)

**Executed counterexample:** during `retrieveSubscription`, the old cycle resolves and a later failed renewal reopens the same DunningState ID with `entered_at=now`, `step_index=0`; the old worker receives `past_due`, locks that fresh cycle immediately and switches entitlement off. The new-cycle anchor assertion passes, but expected zero locks receives **one**; an ordinary Day-10 lock control passes. This is a deterministic provider-await interleaving, not a live multi-node database test. [Stale-cycle probe and control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

**Minimal fix rule:** bind the final transactional transition to the exact cycle/version that established the Day-10 deadline; recheck current eligibility/cancellation/payment state under the same authority before changing entitlement. A reopened cycle must retain its own ten-day window; add the provider-await ABA regression.

### B-688-2 — oldest-first capped sweep starves later active cycles

`src/checkout/dunning-v2/dunning-v2.service.ts:769–780` repeatedly reads the oldest 500 active unlocked rows, including rows already at their current step and rows a canonical check continually skips; it has no continuation, fair revisit scheduling or due-step predicate to move beyond them. [Sweep selection](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.service.ts)

**Executed counterexample at the default limit:** 501 same-day eligible cycles; Day 1 advances the first 500, later Day-1 and Day-3 sweeps continue selecting those same rows, and cycle 501 remains at step **0** with no due notice rows. Persistent skipped rows can also prevent later Day-10 locks indefinitely; the probe directly establishes the missed-cadence case. [501-cycle probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

**Minimal fix rule:** preserve bounded work but guarantee fair progress with stable continuation/revisit authority or complete due-step selection plus fair handling of skipped rows. Test both more-than-one-page notices and a full skipped page ahead of a due lock; do not fix this with an unbounded scan.

### B-688-3 — failed coach transport is durably terminalized as sent

`src/checkout/dunning-v2/dunning-v2.dispatcher.ts:342–366` interprets `CoachAlertEmitter.emit()` resolving void as successful in-app and push delivery; that dependency catches failures, while `pushToCoach()`'s fallback boolean is also ignored. The new outbox then persists the synthetic `sent` result at `dunning-v2.service.ts:642–650`, permanently removing the failed alert from retries. [Dispatcher's new receipt contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.dispatcher.ts) [Emitter's actual contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/notifications/emitters/coach-alert.emitter.ts) [Receipt persistence](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.service.ts)

**Executed composition:** real dispatcher + real CoachAlertEmitter + real v2 outbox, with `createNotification` rejecting before a feed row or push exists, writes `coach_alert.status=sent` instead of failed; the successful-delivery control passes. The finding is the newly introduced durable receipt's use of an incompatible dependency contract, not a demand to audit another PR. [Coach delivery probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

**Minimal fix rule:** consume an honest typed per-transport result (or a failure-propagating adapter), keep failed coach delivery retryable, handle false/null transport returns, and retry without duplicating successful feed/push work. Preserve all three coach channels and add the actual-emitter failure regression.

### B-688-4 — new exception paths send arbitrary diagnostic text to logs

`src/checkout/dunning-v2/dunning-v2.service.ts:538,801,807,864,1629` interpolates unrestricted exception messages; `dunning-v2.dispatcher.ts:425–427` returns raw text which the new outbox also stores in `last_error` at service lines 649/662. These are not IDs/code-only diagnostic boundaries. [Service failure boundaries](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.service.ts) [Dispatcher failure propagation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.dispatcher.ts)

**Executed counterexample:** a synthetic provider exception containing an email, token sentinel and message-body sentinel reaches the new `tryLock` warning verbatim; the acceptance assertion that the raw diagnostic is absent fails. No real personal data or credentials were used. [Diagnostic redaction probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

**Minimal fix rule:** classify failures into a restricted safe-code vocabulary, preserve only IDs/status/correlation references in logs/Sentry/outbox diagnostics, and never serialize arbitrary exception messages or raw error objects. Apply the rule across the newly introduced catch paths and test provider/DB diagnostics containing synthetic sensitive sentinels.

### B-688-5 — losing a recorded dispute erases its protection during a payment cycle

`src/checkout/dunning-v2/dunning-v2.service.ts:1187–1200` decides an obligation matters only when its merged status is **not terminal**; `lost` and `charge_refunded` are terminal but not favorable/settled, so an active payment cycle without the dispute marker stops being protected as soon as its dispute closes lost. The same predicate is used by `isDisputeCycleOpen` and the payment-only clear guard at lines 932–938. [Recorded-obligation and recovery predicates](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning-v2/dunning-v2.service.ts)

**Executed public-entry counterexample:** record a dispute arriving during an ordinary active payment cycle, process `onDisputeClosed(status='lost')`, verify the durable obligation is lost, then observe `isDisputeCycleOpen=false`. The won-dispute control correctly returns false; renewal/card recovery is therefore no longer prevented by this predicate even though the disputed funds remain reversed. The probe directly establishes the predicate error, not a full D3/D4 webhook execution. [Lost-dispute probe and won control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

**Minimal fix rule:** distinguish “terminal” from “settled in the client's favor”; retain protection for every recorded merged obligation not won/warning_closed, including lost/refunded unfavorable outcomes, consistently with `outstandingDisputes`. Add lost-before-renewal/card-recovery controls and keep favorable closure/order/conflicting-final-status behavior.

### Gates, split safety and execution limits

The audit lane branches from this exact candidate with only its probe and throwaway CI inputs: **5 acceptance failures / 44 passes**, including both existing changed suites passing; the three explicit probe controls pass. The supplemental `test/dunning-v2-dispatcher.spec.ts` argument matches no file, so no separate dispatcher suite is claimed—the dispatcher is exercised by the probe itself. [Executed D2 bundle](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171407562)

The seven main-required checks applicable on this stacked base pass; **CodeQL JS/TS, banned casts, SBOM and Danger are not run here** and remain mandatory when composed onto main. No green exact-head merge/deploy eligibility is claimed for the stack from this provisional CI shape. [Candidate build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37152162539/job/111288092963) [Operator check/landing statement](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975773031)

D2 must **land as one with the dunning stack and not deploy independently**: the flag-off legacy recovery URL is changed here before D4 supplies the native/public billing routes, and paid-webhook dispute preservation is wired in D4, not this piece. No money call, production flag, deployment or candidate source was changed by this audit; the simulated database probes do not establish live lock/rollback semantics. [Legacy hook change](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/6627044cce3c7a210099b77b72e53f782cba2801/src/checkout/dunning.service.ts) [Operator land-as-one rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975773031)

Fix-round size must remain under 3,000 changed lines: D2 currently has only 125 lines of headroom, so coordinate a logical re-cut if complete fixes/regressions exceed that limit rather than dropping functionality or evidence. [Size assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975773031)
