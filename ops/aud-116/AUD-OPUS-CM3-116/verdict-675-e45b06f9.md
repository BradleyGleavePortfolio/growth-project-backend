AUDIT Claude Opus 5.5 — growth-project-backend#675 @ e45b06f9c797e2b1fc4bded653c826e9b78bda98 — VERDICT: APPROVE

A/B/C = 0/0/1

Lens AUD-OPUS-CM3-116 (agent 116 wave). Scope: T4 (money-adjacent create path, tenancy). This is a delta audit of `d1c98430..e45b06f9`, where this lens's last verdict was REQUEST CHANGES 0/1/2 ([comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/675#issuecomment-5975993860)). The delta is two commits and six files: the new `src/packages/package-idempotency.filter.ts`, `packages.controller.ts` (one `@UseFilters` line plus the import), `packages.service.ts` (fingerprint plus `replayCreate`) and three specs. I read every line.

**Evidence reuse (G09).** Nothing else changed since `d1c98430`: the claim/transaction/replay skeleton, validation-before-claim, key scoping, RLS and the deletion manifest. This lens audited all of that line by line at `d1c98430` and found it holding, so that evidence carries forward. The branch is BEHIND main `a5b605d1` (#664 multer, #652 UGC). No file overlaps, and `git merge-tree` is clean, so a later update-branch is a merge-only delta.

### Prior findings (this lens)

**B-675-1 — CLOSED**
- **Fix:** `package-idempotency.filter.ts:40-66`, `packages.controller.ts:50`, `packages.service.ts:348-367`. The 422 `IDEMPOTENCY_KEY_REUSED` wire body now carries `package_id`. It is built through the shared `buildErrorEnvelope` with the same status, code, message, error and request_id derivation as `HttpExceptionFilter`.
- **Builder's failing-before run:** [37173329482](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173329482).
- **My probe:** [run 37175221476](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175221476), `audit-opcm3-675-wire.spec.ts`. It runs the real controller and service over HTTP with BOTH global filters registered as in `main.ts` (HttpExceptionFilter + ThrottlerExceptionFilter) and the production ValidationPipe. The same 21-request battery runs twice:
  - once against the head wiring;
  - once against the pre-PR wiring (class metadata rewritten to `[PackageValidationFilter]` before compile).
- **Routes covered by the battery:** every coach package route — 401, DTO 400s, 400 IDEMPOTENCY_KEY_INVALID, the 400 price floor and free-recurring checks, 201, 201 replay, 409 IN_PROGRESS, 410 removed, 404 on detail/patch/publish/unpublish/archive/subscribers, PATCH 400s, a 500 from a thrown DB error and a 500 from an ORM error inside the create transaction.
- **Battery result:**
  - Every status and body is identical, timestamp aside.
  - The only exception is the 422, which equals the pre-PR body plus exactly `package_id`, with `request_id` kept.
  - No body contains the injected internal text.
- **Filter order is safe.** Nest reverses the class filters, so for a 422 the order is [PackageIdempotencyFilter, PackageValidationFilter, Throttler, Http]. The route's only 422 is this code. Every other 422 is delegated to a `new HttpExceptionFilter()`, which is byte-equivalent to the global one (no constructor dependencies).
- **Mobile #345 @ a4e49588:** [run 37175081559](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175081559) passes `createPackageOnce` the exact wire bodies, 7/7.
  - 422 with `package_id`: adopts the package, PATCHes it once with the current details, and the next tap sends nothing.
  - 410: a same-tap fresh start under a NEW key, producing exactly one new package.
  - 409: rethrown, the same key stays on disk, and the copy says "still being saved".
  - 400 IDEMPOTENCY_KEY_INVALID: the intent is cleared.
  - Control: the pre-fix 422 without `package_id` still re-sends the same key forever. That is the loop this finding was about, and it is now unreachable (Prisma `@default(uuid())` ids always pass the filter's UUID check).

**C-675-3 — CLOSED**
- **Fix:** `packages.service.ts:351-358`. `archived_at != null` now returns 410 `IDEMPOTENT_PACKAGE_REMOVED` with no id, for both same and different details.
- **Mobile:** this is the code mobile keys its fresh start on (probe above).

**C-675-2 — CLOSED**
- **Fix:** `packages.service.ts:120-131, 271-276`. The fingerprint drops optional columns that are at the default produced by the same builder and always keeps coach_id, name and amount_cents.
- **Injectivity:** every `createData` row has the same key set, and the defaults row depends only on identity keys, so distinct rows never share a fingerprint.
- **Proof on the real merge:** [run 37175231157](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175231157). I merged this head with trials #672 @ e06b5b13. The only conflict is two import lines in `packages.controller.ts`; I kept both. `packages.service.ts` auto-merges and keeps the fingerprint line. The ledger was seeded with the literal hashes this head stores (asserted by `audit-opcm3-675-wire.spec.ts` in run 37175221476). Results:
  - A recurring and a one-time body under keys claimed before #672 replay with 201 and `Idempotent-Replayed`, with no second row.
  - An app that now sends `trial_days: 0` or `null` still replays.
  - `trial_days: 7` returns 422 naming the package on the wire, so the app can adopt it.
  - A key claimed after the merge stores the same hash.
  - #672's `b-trials-package-rules.spec.ts` and this PR's three specs pass on the merged tree (63/63).

### Asked checks
- **No cross-coach id leak:** probe test 2 (run 37175221476).
  - Another coach using the same key gets its own package.
  - A sub-coach under coach A has its own key space and is never named A's package.
  - A sub-coach who moved to coach B gets 410 for both bodies with no id. After moving back, it is named only its own catalog's package.
  - Every UUID in every body belongs to the caller's current catalog.
- **The route-scoped filter changes no other error body:** see the battery above.
- **Old keys replay after #672 adds trial_days:** see C-675-2.
- **Mobile #345 behaviour per code:** see B-675-1.

### New finding
- **C-675-4 (optional, copy):** two server messages are inaccurate. Mobile never shows either one (the 410 starts fresh silently; the 422 is adopted silently).
  - `packages.service.ts:356` says "has since been removed" for a sub-coach whose package still exists in their former head coach's catalog.
  - `:364` puts the field name "(package_id)" into prose.
  - **Fix rule:** use "is no longer in this catalog" for the not-found case and drop the parenthesis.

### Operator notes (non-blocking)
- **#672 refresh:** whichever lands second resolves only the import lines and keeps the `requestHash` fingerprint line. This was proven on the merge above.
- **After #678 lands:** this filter keeps working, because other 422s go through the allow-listed HttpExceptionFilter. Folding `IDEMPOTENCY_KEY_REUSED: { package_id: uuid }` into `ERROR_DETAIL_ALLOWLIST` is optional cleanup.

Probe sources: `ops/aud-116/AUD-OPUS-CM3-116/` (audit branches deleted, runs kept).
