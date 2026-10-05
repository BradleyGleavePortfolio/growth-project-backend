# AUD-OPUS-CM2-116 (lens Claude Opus 5.5, agent 116 wave) — report

Job: full-depth T4 audit of backend #677 (coach Money M4, CoachMoneyService unit spec) and backend #675 (coach Money M2,
idempotent package create, base main); one verdict per PR at the claimed heads; then end.
Claims: ops/lanes116/claims/backend-677-4aaee4ed-opus, backend-675-d1c98430-opus (02:48 UTC 10-04).
Notes: ops/aud-116/AUD-OPUS-CM2-116/ (prior #641 comments, src diff, CI logs, probe source).
Disk at start: 67 percent. No heavy local work (lens rule); one CI-lane probe run.

## Heads (verified 02:48 UTC 10-04 / 19:48 PDT 10-03)
- #677 @ 4aaee4ed601bb0afb3f00828e28ace286a80512e (base agent115/money-split-3-coach-money-api = #676 564f33bf); 11 checks green
  (CodeQL/danger/banned casts/SBOM do not run on a stacked base). build-and-test job 111277955164: "PASS test/coach-money.service.spec.ts".
- #675 @ d1c98430047a5972facfdfc5cf4270ab68f9f87a (base main d23fa317, merge-base = main tip); 16 checks green, all 11 required.
  build-and-test job 111286738286: "PASS test/packages-create-idempotency.spec.ts".

## Piece fidelity
- `git merge-tree --write-tree f60ed603 d23fa317` = d4d5d4bc (the refreshed #641 tree).
- `git diff 4aaee4ed d4d5d4bc` = exactly the three M2 files (packages.controller.ts, packages.service.ts, packages-create-idempotency.spec.ts).
- `git diff d1c98430 d4d5d4bc -- <M2 files>` = empty. So M2 + M4 together equal the refreshed #641 tree, as the bodies claim.
- M2 files and test/coach-money.service.spec.ts are byte-identical at fb29fb9e (Opus APPROVE 5964726454), 02cd3f88 and f60ed603.
  src/coach-money/* is byte-identical at fb29fb9e and 4aaee4ed.

## Prior findings of this lens on #641 (decided for code in my two PRs)
- B-641-5 (package create idempotency, Opus): closed at fb29fb9e; code unchanged; still closed for the claim/transaction/replay logic.
  New B-675-1 below is on the wire contract of the same code (missed by this lens at fb29fb9e; found now by tracing the mobile consumer).
- B-641-12 (concurrent refunds on one transfer lose one local reversal): code is in M1 #674 (transfer-orchestrator recordReversal,
  split-ledger applyReversal). Not in #675/#677. FIX ROUND 5 does not list it; at #674 head 9a512028 neither file has FOR UPDATE,
  LEAST( or an atomic increment. AUD-OPUS-CM1-116 owns that decision. It does not block #677 (guide rule 9), but #677 lands as one
  with #674/#676 (rule 11), so the stack cannot land until #674 closes it.
- C-641-13 (payout failure_message free text): coach-connect.service.ts, M3 #676. Not mine.
- C-641-2 (integration with #627/#628): carried; the PayeeRecovery seam that #677 tests (payeeRecoveryReader: payee_user_id, status
  'open', currency, amount_cents, collected_cents) matches the PayeeRecovery model at fees F6 #686 (7be7d396) field for field.

## backend #675 @ d1c98430 — REQUEST CHANGES 0/1/2
Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/675#issuecomment-5975993860 (posted 10-04 UTC).
Probe source kept at ops/aud-116/AUD-OPUS-CM2-116/audit-opcm2-675-reused-envelope.spec.ts (branch deleted; run stays).
Read every line: controller create (header + passthrough Res), service createIdempotent / replayCreate / createData / hash, the
366-line spec; traced the global HttpExceptionFilter + buildErrorEnvelope, PackageValidationFilter, WorkoutBuilderIdempotencyKey
schema/migrations (unique index, FK cascade, FORCE RLS policy keyed to the caller), account-deletion manifest (user_id -> delete),
RlsContextInterceptor, CORS allowedHeaders, the mobile consumers (#345 a4e49588 packageCreateIntent.ts / errors.ts, #347 ea2c72d1
CoachPackageEditScreen.tsx), and #672's createData change.
Holds: one interactive transaction for claim + package + completed result (Postgres unique-wait gives exactly-once under concurrency);
validation before claim; P2002 without a committed claim rethrown; replay bounded to the tenant; keys scoped to the caller (RLS policy
matches); 400 for a malformed key passes PackageValidationFilter untouched (it has a code); no body text stored (hash + id only);
deletion manifest covers the claim rows.

- B-675-1: the 422 IDEMPOTENCY_KEY_REUSED wire body has no package_id. packages.service.ts:303-310 puts package_id on the exception
  and :213-214 documents "naming the package that key made, so the app can adopt it"; HttpExceptionFilter (main.ts:118, filter
  :52-61, :93-101) rebuilds the body via buildErrorEnvelope (not-found-envelope.ts:22-35), which keeps only statusCode, code,
  message, error, timestamp, path, request_id. Mobile createPackageOnce adopts only via reusedPackageId (mobile #345
  packageCreateIntent.ts:239-243, :296); without it the 422 is non-definitive (:228-233), rethrown (:315), and errors.ts:171-175 tells
  the coach "Tap Create package again" -> same key, same body, same 422, forever. Reachable: any retry whose normalised details hash
  differently, including every unresolved intent that straddles the #672 refresh (createData gains trial_days: 0, so the hash of an
  identical body changes). Probe: red, https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172560549
  (real service + real HttpExceptionFilter: status 422 and code pass, package_id Received undefined). The PR's spec only checks
  getResponse() on the exception, never the wire.
  Fix rule: deliver package_id on the wire for this code (a packages-scoped filter that adds it to the envelope, or an allow-listed
  safe-field pass-through in HttpExceptionFilter keyed by code), include it only when that package belongs to the same effective
  coach (else answer 410 IDEMPOTENT_PACKAGE_REMOVED), and add an HTTP-level test through the production filter
  (test/packages-pricing-http.spec.ts harness) asserting body.package_id; the probe above is a ready failing-before test.
- C-675-2: request_hash is over createData (server-normalised row incl. defaults), so any later defaulted column (#672 trial_days)
  flips the hash of every outstanding key. Fix rule for whichever of #675/#672 lands second: hash the client-supplied create fields
  with defaults omitted (or treat a missing new field as its default), plus a test "a key claimed before trial_days existed replays".
- C-675-3: a replay of a package the coach archived (DELETE :id archives; no hard delete exists in src) returns 201 + the archived
  row, not 410; mobile expects 410 to start fresh. Same probe run (Received {pkg, replayed}). Fix rule: archived_at != null -> 410.

## backend #677 @ 4aaee4ed — APPROVE 0/0/1
Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/677#issuecomment-5975993938
Test-only piece (one 1,244-line spec, no runtime/migration/dependency/gate change). Read every assertion and fixture. Evidence reuse:
the spec blob and the code under test are byte-identical to fb29fb9e where this lens APPROVED #641 with this file in the tree; I still
read the whole file at this head. Piece boundary: imports resolve from M3 (#676) and main (coach-money.service exports,
coach-connect.service deriveConnectState + 6-arg CoachConnectService, connect-onboarding-return.controller, public.decorator); nothing
from M2; CI passes it at this head. Assertions are real arithmetic on the exported folds (price - fee - 2 percent = net, reversal
allocation sums exactly, window totals equal all-time folds, CSV net_to_you sums to the summary net, currency never summed), plus
where-clause tenancy checks on every mocked query; no tautologies found.
- C-677-1: MRR status set is pinned only by a 'canceled' exclusion; pin MRR_SUBSCRIPTION_STATUSES (active, trialing, past_due in;
  payment_failed, expired out) so the trials stack cannot change it silently.

## Operator notes (outside my PRs; do not block)
- B-641-12 status at #674 (above): AUD-OPUS-CM1-116 decides; the stack #674 -> #676 -> #677 lands as one.
- coach-money.service.ts:639 (M3 #676) counts 'trialing' subscriptions in MRR at full price. Once trials ship (#671-#673) a coach with
  trial clients sees MRR as if they paid. Recommended default: exclude trialing from MRR and show trials as a separate count.
- #675/#672 shared files: the second to land refreshes (do not block). The refresh must keep C-675-2 in mind.

## HANDOFF
- backend #675 @ d1c98430047a5972facfdfc5cf4270ab68f9f87a: Opus REQUEST CHANGES 0/1/2 (B-675-1 wire package_id; C-675-2 hash
  stability vs #672 trial_days; C-675-3 archived replay -> 410). Sol APPROVE 0/0/0 at the same head. Next: a builder closes B-675-1
  (and the cheap C-675-3) with a failing-before test through the real HttpExceptionFilter (the probe above, CI-lane run
  37172560549, is ready to reuse), posts FIX ROUND + READY FOR AUDIT; then a fresh Opus lens audits that head as a delta from
  d1c98430. #675 lands on its own (base main); #672 and #675: the second to land refreshes and should carry C-675-2.
- backend #677 @ 4aaee4ed601bb0afb3f00828e28ace286a80512e: Opus APPROVE 0/0/1 (C-677-1 pin MRR statuses). Sol APPROVE at the same head.
  Next: B-CM1-116 restacks #677 after fixing #674/#676; a fresh lens posts a short delta verdict (spec blob unchanged = merge-only).
  Lands as one with #674 -> #676 (rule 11), which still needs B-641-12 decided at #674.
- Operator decisions: (1) MRR counts trialing subscriptions at full price (coach-money.service.ts:639, M3 #676); recommended
  default: exclude trialing from MRR and show trial count separately, decided before trials ship. (2) B-641-12 status at #674
  (no FOR UPDATE / atomic increment at 9a512028) for AUD-OPUS-CM1-116 / B-CM1-116.
- Cleanup done: audit branch deleted, both worktrees removed. Claims left in place (backend-675-d1c98430-opus,
  backend-677-4aaee4ed-opus).
