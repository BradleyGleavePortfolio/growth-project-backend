AUDIT Claude Opus 5.5 — growth-project-backend#675 @ d1c98430047a5972facfdfc5cf4270ab68f9f87a — VERDICT: REQUEST CHANGES

A/B/C = 0/1/2

Lens AUD-OPUS-CM2-116 (agent 116 wave). Full-depth T4 audit (money path: coach package catalog) of all 567 lines at this head, base main `d23fa317` (merge-base = main tip). Required checks: all 11 green at this head; `build-and-test` passes `test/packages-create-idempotency.spec.ts` ([job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148734949/job/111286738286)).

### Evidence and prior findings
- **Piece fidelity:** `git merge-tree --write-tree f60ed603 d23fa317` gives `d4d5d4bc`. The three M2 files at this head equal that tree (`git diff` empty). They are also byte-identical at `fb29fb9e`, where this lens closed B-641-5 ([Opus APPROVE](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5964726454)).
- **B-641-5 (this lens): still closed for the claim, transaction and replay logic.**
  - Claim, package insert and the completed result commit in one interactive transaction. Postgres makes a second same-key insert wait for the first transaction, then fail with P2002 or proceed if the first rolled back.
  - Validation runs before the claim. A P2002 with no committed claim is rethrown.
  - Replay is bounded to `coach_id`. Keys are scoped to the caller, which also matches the table's FORCE RLS policy.
  - The ledger stores a hash and an id only. The deletion manifest covers `WorkoutBuilderIdempotencyKey.user_id` (FK cascade).
  - The malformed-key 400 carries a code, so `PackageValidationFilter` passes it through unchanged.
- **New finding:** B-675-1 below is in the same code but concerns its wire contract. This lens missed it at `fb29fb9e`. I found it now by tracing the mobile consumer through the production error filter.
- Other open items from this lens on #641 (B-641-12 reversal lost update in M1 #674, C-641-13 in M3 #676, C-641-2 carried) are not in this piece.

### B-675-1 — the 422 `IDEMPOTENCY_KEY_REUSED` reaches the client without `package_id`, so the app cannot adopt the package and the coach is stuck in a retry loop
- **Where:**
  - `src/packages/packages.service.ts:303-310` puts `package_id` on the exception. The comment at `:213-214` promises the 422 names "the package that key made, so the app can adopt it".
  - Every error body is rebuilt by the global `HttpExceptionFilter` (`src/main.ts:118`; filter `:52-61` reads only `message`, `error` and `code`; `:93-101` builds the envelope).
  - `buildErrorEnvelope` (`src/filters/not-found-envelope.ts:22-35`) emits only `statusCode`, `code`, `message`, `error`, `timestamp`, `path` and `request_id`. So `package_id` is dropped.
  - The PR's spec checks only `getResponse()` on the exception (`test/packages-create-idempotency.spec.ts` "the same key with different details is 422..."). It never checks the wire body.
- **Consumer:** the mobile create path adopts only through `reusedPackageId` (mobile #345 @ a4e49588, `src/lib/coachSetup/packageCreateIntent.ts:239-243`, `:296`). The setup form uses this path, and so does `CoachPackageEditScreen` (mobile #347 @ ea2c72d1, `:261`).
  - Without the id, the 422 is not definitive (`:228-233`) and is rethrown (`:315-318`).
  - `errors.ts:171-175` then tells the coach "Tap Create package again to finish it with the details you see now."
  - The tap re-sends the stored intent with the same key and body, gets the same 422, and so on forever. The intent is persisted, so leaving the screen does not clear it.
- **Reachable:** any retry whose normalised details hash differently from the claim. In particular, every unresolved intent that straddles the #672 refresh hits it. #672 adds `trial_days: input.trial_days ?? TRIAL_DAYS_NONE` to `createData`, so an identical body hashes differently after that deploy (see C-675-2).
- **Probe (red):** [ci-lane run 37172560549](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172560549), branch `audit/AUD-OPUS-CM2-116/675-reused-envelope`, `test/audit-opcm2-675-reused-envelope.spec.ts`. It uses the real `PackagesService` and the real `HttpExceptionFilter`.
  - Controls pass: `main.ts` registers the filter globally, the exception carries `package_id`, and the wire status is 422 with code `IDEMPOTENCY_KEY_REUSED`.
  - The check fails: wire `body.package_id` expected `"pkg-2"`, received `undefined`.
- **Fix rule:**
  - Deliver `package_id` on the wire for this code. Either use a packages-scoped filter that adds it to the standard envelope, or add a code-keyed allow-list of safe id fields to `HttpExceptionFilter`. Do not pass through arbitrary exception fields.
  - Include the id only when that package belongs to the same effective coach (`coach_id = coachUserId`). Otherwise answer 410 `IDEMPOTENT_PACKAGE_REMOVED`, so a moved sub-coach never gets a pointer into another catalog.
  - Add an HTTP-level test through the production filter (the `test/packages-pricing-http.spec.ts` harness) asserting `body.package_id`. The probe above is a ready failing-before test.

### C (optional)
- **C-675-2 — the request hash moves when the server adds a defaulted column.**
  - `packageCreateHash(this.createData(...))` (`:236-237`) hashes the server-normalised row, defaults included. Any later defaulted column flips the hash of every outstanding key, so a retry that straddles that deploy gets 422 instead of a replay. #672's `trial_days` is exactly such a column.
  - Once B-675-1 is fixed this case degrades to adopt-and-PATCH (benign).
  - **Fix rule:** whichever of #675/#672 lands second should hash the client-supplied create fields with defaults omitted, or canonicalise an absent new field to its default. Add a test "a key claimed before `trial_days` existed replays the same package".
- **C-675-3 — a replay of an archived package is a 201 replay, not 410.**
  - `DELETE /v1/coach/packages/:id` archives the package, and no hard delete exists in `src/`. So the 410 branch (`:314-320`) is reachable only through an account-deletion cascade.
  - A retry after the coach archived the package (on another device) returns the archived row with `Idempotent-Replayed: true`, and the app adopts a package that is off the storefront. The mobile expects 410 to start a fresh create.
  - Same probe run: expected an `HttpException` with status 410, received `{ pkg, replayed }`.
  - **Fix rule:** treat `archived_at != null` as removed (410) in `replayCreate`.

### Shared files
#672 also changes `packages.service.ts` and `packages.controller.ts`. Whichever lands second refreshes; this does not block. The refresh should carry C-675-2.

Approval at the next head requires B-675-1 closed with a failing-before test through the real filter, plus green required checks.

No push to the PR branch, no merge and no dispatch outside the CI lane by this lens.
