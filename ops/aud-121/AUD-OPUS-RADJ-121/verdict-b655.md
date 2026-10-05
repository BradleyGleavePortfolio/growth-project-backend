AUDIT Claude Opus 5.5 — growth-project-backend#655 @ bf9120c1178c28b54256d41afed05a25578353f3 — VERDICT: REQUEST CHANGES

AUD-OPUS-RADJ-121, agent 121. First full review, T4 (new tables + RLS + migration, writes to client workout snapshots, box-2 gated
wearable/training reads, new env flag). Grandfathered PR (opened 2026-10-03 00:21 UTC): 2,058 / 3,000 lines. Independent of the Sol
lens (its notes were not read). Graded under the owner's 13:29 edge-case freeze (A2): edge cases are C, deferred to 10k clients.

A/B/C = 0/3/13

Evidence: PR CI run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37081735821 (tsc red). Behaviour
probes: test/roman-adjust/aud-opus-radj-121.probe.spec.ts on this head + origin/main 5da537d6 merged (commit 86f98d48, branch
audit/AUD-OPUS-RADJ-121/655-1). The lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37367380193
sat queued 26 min in the Actions incident (109 runs queued, 1 running), so per operator item 11 that single spec ran through
/home/user/workspace/ops/heavy.sh: 13 tests, 9 failed as designed (the findings below), 4 controls passed. The lane was then cancelled
to free the one-lane slot. Static checks below quote the spec logic they replicate.

What holds (no finding):
- Consent (box 2): the scan reads wearable samples and completions only for clients in `clientsWithAiConsent` (service.ts:192-195);
  list re-checks and closes withdrawn rows (service.ts:157-162); approve/edit re-check `hasClientAiConsent` before writing
  (service.ts:360-363); the reader fails closed. Probe control: an unconsented client's wearable data is never read. No provider
  call anywhere (deterministic rule and sentence), so no AI egress or coach-pool debit applies.
- What the coach sees: Roman's sentence, signal values, the set change, first name, plan and exercise names. No memory, playbook,
  prompts, reasoning or client chat text (probe control on the view's keys).
- Idempotency: approve, approve again, edit, dismiss, undo, undo again -> one write, one restore, coded ADJUSTMENT_ALREADY_DECIDED
  refusals (probe control). The `updateMany ... status='pending'` claim sits in the same transaction as the snapshot write.
- Audit: fixed action names proposed/approved/edited/dismissed/undone/expired/withdrawn/apply_refused, no health label; a decision's
  detail carries set counts only (probe control). UPDATE on the event table is rejected by trigger (migration.sql:109).
- Writes touch only the assignment snapshot (never the plan template); the fingerprint check refuses a workout edited since the
  suggestion; reps, loads and rest are untouched.
- Kill switch: the guard 404s every route while FEATURE_ROMAN_ADJUST_ENABLED is off; registered default off. The flag stays off.
- Migration 20270227000000 is additive with down.sql and commutes with the already-applied 20270301000000 (x2) and 20270311000000 (none
  touch ClientWorkoutAssignment or the new names). origin/main merges without conflict.

B-655-1 — CI is red, so the PR cannot land as is (three causes, all reproducible).
(a) build-and-test fails at tsc: test/roman-adjust/roman-adjust.service.spec.ts(95,9) TS7022 and (152,27) TS7024 (the self-referencing
in-memory `prisma` double), run 37081735821 above. Jest never ran in PR CI.
(b) test/ai-consent/ai-consent-wiring.spec.ts:80-99 (at the base and on main) walks src for `from '...\/ai-consent\/'` outside
src/ai-consent and expects exactly ai-egress.module.ts, ai-egress.service.ts and app.module.ts. At this head the walk also finds
src/roman-adjust/roman-adjust.module.ts:9 and src/roman-adjust/roman-adjust.service.ts:21-22, so it fails (R2b: consent reads go
through AiEgressService).
(c) After merging main (the PR is behind), test/account-deletion/erasure-manifest-coverage.spec.ts:104-121 fails: its ID_LIKE pattern
flags WorkoutAdjustmentProposal.coach_id, .client_id and WorkoutAdjustmentEvent.actor_id, and src/account-deletion/
account-deletion.manifest.ts has no decision for them. (Client data itself is already removed in practice: the manifest deletes
ClientWorkoutAssignment rows and both new tables cascade from them.)
Fix rule: (a) type the double (`const prisma: any = {...}` or an interface). (b) read box 2 through AiEgressService
(consentedClients for the batch, the single-client check for decisions) and import AiEgressModule, not AiConsentModule. (c) add
manifest entries: Proposal.client_id delete; Proposal.coach_id and decided_by_id retain with the FROZEN_PLAN reason used for
ClientWorkoutAssignment.assigned_by_coach_id (or delete); Event.actor_id retain (id only; the append-only trigger rejects UPDATE).
Verify: tsc clean, ai-consent-wiring, erasure-manifest-coverage, manifest-fk-order and test/roman-adjust green in PR CI.

B-655-2 — false coach-facing claim, normal use. ADJUSTMENT_WORKOUT_CHANGED says "Open the workout to review it, then refresh for a new
suggestion" (constants.ts:41-45; mirrored in mobile romanAdjustCopy.ts:28-29). After the refusal the row is set to expired and keeps
the (assignment_id, rule_key) unique slot (migration.sql:60, service.ts:248-252), so no new suggestion is ever made for that workout.
Normal path: the coach edits the workout in the builder, later taps Approve on the card. Probe (titled "B-655-4" in the run): the
refusal fires, a forced refresh, 0 pending suggestions (expected 1).
Fix rule: one sentence that is true, e.g. "This workout was edited after Roman made the suggestion, so it was not applied. Open the
workout to adjust it directly." (same in the mobile fallback), or let the scan re-propose when the only row is expired.
Verify: the probe passes either by the new copy or a new pending row.

B-655-3 — false coach-facing claim, normal use: the day in Roman's sentence is frozen at scan time (service.ts:259-265 stores
whenWord(...) inside roman_text; rules.ts:368-378). A suggestion made Friday evening for Saturday's workout still reads "I suggest
trimming tomorrow's Lower Body A" when the coach opens it Saturday morning; the card shows no other date (mobile
RomanAdjustmentCard.tsx:189-191). Probe (titled "B-655-5"): listing at 2026-10-03 08:00 PT still returns "tomorrow's".
Fix rule: build the sentence in view() at read time from the stored signals, change and plan name, using the request clock and the
client's time zone (keep the stored text for the audit), or name the weekday instead of today/tomorrow. Verify with the probe.

Follow-ups (C, not blocking):
- C-655-1 C (edge, deferred to 10k clients). Tenancy is bound at scan time and never re-checked: own() compares only p.coach_id
  (service.ts:484-498), list filters coach_id (service.ts:145-152). Probe: after a client's coach_id changes, the old coach still lists
  her HRV/RHR evidence and can approve. Main has no flow that moves an active coach's client at launch (coach-code attach needs
  coach_id null; detach happens on coach deletion), so edge. Fix later: check canCoachActOnClient / SubCoachScope at list and decision.
- C-655-2 Sub-coach scope: the roster is `User.coach_id = caller` (service.ts:186-190), so sub-coaches with an open SubCoachAssignment
  get no suggestions; the head coach sees them (allowed). Operator decision below.
- C-655-3 constants.ts:13 kill switch is case-insensitive ('TRUE' turns it on) while the PR body and .env.example say "only the exact
  value true". Fix: `=== 'true'`, or the docs. Probe C-655-a.
- C-655-4 C (edge, deferred to 10k clients). service.ts:329-480: a database error during a decision escapes as a bare 500 (list maps
  it to ADJUSTMENTS_UNAVAILABLE). Probe C-655-b.
- C-655-5 rules.ts:315-334: an Edit may raise sets (steppers up to 20), volume_pct -17 and the card reads "-17% less volume". Fix:
  refuse an edit above sets_before, or word increases. Probe C-655-c.
- C-655-6 C (edge, deferred to 10k clients). service.ts:186-190 `take: 200` without orderBy: coaches above 200 clients get an
  arbitrary subset scanned.
- C-655-7 workout-builder.service.ts:1460-1466: the scan (a GET) writes a snapshot for a legacy assignment before any decision,
  freezing it against later plan edits. Fix: read live plan rows in the scan; snapshot only on apply.
- C-655-8 rules.ts:175, 226-232: HealthKit/Health Connect send SLEEP_TOTAL_MIN per session (mobile SLEEP_SESSION_GAP_MS = 2 h,
  healthConnectNormalizer:275), so max() per wake day under-counts a split night; the PR body says "< 6 h on >= 2 of 3 nights", the
  code averages. Align.
- C-655-9 PR body says the trigger blocks UPDATE/DELETE; migration.sql:105-110 blocks UPDATE only. Doc fix.
- C-655-10 started_at is written only at completion on main (completeAssignment), so a workout in progress cannot be refused; copy
  "started or finished" stays true. Doc only.
- C-655-11 env-validation.ts ENV_RULES entry has no closed `values` set: the later operator flag PR must add values ['true','false']
  and a fly-env manifest entry.
- C-655-12 service.ts:494-498 a suggestion the system expired or withdrew is answered "already been handled, possibly from another
  device". Fix: NOT_FOUND or a specific sentence.
- C-655-13 C (edge, deferred to 10k clients). service.ts:233-296: the GET runs the scan inline (per-client findUnique + transaction,
  up to 200 clients x 32 days of samples).

Operator decisions: (1) sub-coach suggestions (C-655-2): default defer, head coach only at launch. (2) Roman's sentence says "I
suggest ... Shall I apply it?": default allowed as persona voice (main's Roman voice lines use "I"), app chrome stays impersonal.
(3) Migration name 20270227000000 sorts before applied migrations but commutes: default keep (A6.2 precedent).
