AUDIT GPT-6.1 Sol — growth-project-backend#692 @ 27156167037d5c1be687c597ad349e5a151f5228 — VERDICT: REQUEST CHANGES

AUD-SOL-PUSH-120, agent 120. A/B/C = 0/1/0.

First full T4 review of P1, including all nine changed files and the original #648 audit/fix history; no prior APPROVE is reused because the original Sol verdict was REQUEST CHANGES. ([Original Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/648#issuecomment-5972046897))

### B-692-1 — the lock-screen boundary trusts arbitrary profile/body text

**File:line:** `src/notifications/push/lock-screen-copy.ts:125-145` (also the safe-body whitelist at `:24-33`). The message and booking branches copy the entire supplied body or `otherPartyDisplayName`; trimming/truncating is not a privacy control. ([Exact-head copy helper](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/27156167037d5c1be687c597ad349e5a151f5228/src%2Fnotifications%2Fpush%2Flock-screen-copy.ts))

**Executed counterexample:** synthetic display name `Jamie jamie@example.test diagnosis: diabetes` appears verbatim in both “New message from …” and a one-hour reminder; both privacy assertions fail, while generic health-kind copy passes. ([P1 independent CI probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343801309))

This is reachable, not merely direct-helper misuse: registration accepts a nonempty string name, messaging reads that `User.name`, and the real MessageReceivedEmitter → NotificationsService → delivery-worker probe sends the same email/health text to the provider payload. ([Name input](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/13417e7be58b96b6fccf203f71ec3b1f1ac8bb20/src/auth/auth.dto.ts), [Name reader](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/13417e7be58b96b6fccf203f71ec3b1f1ac8bb20/src/messaging/messaging.service.ts), [Real-path probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344206727))

**Minimal fix rule:** use invariant, non-personal lock-screen templates for messages and booking events rather than trusting inbox text or free-form profile names; retain full details inside the authenticated app and keep delivery, time/urgency policy and tap routing. A name-pattern denylist cannot guarantee that a field contains no health information. Add passing regressions for arbitrary email/health-bearing names and all booking branches; replay the independent P1/P2 probes. The fix belongs in P1; the P2 integration failure is evidence of this same finding, not a second finding.

### What was verified / boundaries

- P1 is inert: no provider is registered until P2; its additive outbox migration has forced RLS, service-role access, explicit anonymous/authenticated denial, FK cascade and a down migration, and the erasure manifest explicitly deletes PushOutbox rows. ([Migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/27156167037d5c1be687c597ad349e5a151f5228/prisma%2Fmigrations%2F20270307000000_push_outbox_quiet_hours%2Fmigration.sql), [Erasure entry](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/27156167037d5c1be687c597ad349e5a151f5228/src%2Faccount-deletion%2Faccount-deletion.manifest.ts))
- Independent P1 CI: **2 expected privacy failures / 21 passed**, including both erasure-manifest and FK-order suites, preference/quiet-hours/DST/transport controls; this run is the candidate plus a test-only probe and throwaway lane workflow, not candidate CI. ([CI lane 37343801309](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343801309))
- Listed eleven required candidate checks are successful at this head, including the main-only gates; the PR is nevertheless behind main and this material counterexample blocks approval. ([Candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37152422938), [P1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692))

No local heavy commands, PR-branch edits, merge, production access, deploy or live-provider/device execution. Operator default: fix B-692-1, restack P2, obtain both exact-head lenses and current-main CI, then qualify Android after FCM configuration; do not claim that mocked provider acceptance proves device delivery. Nothing needed from the owner for this bounded fix.
