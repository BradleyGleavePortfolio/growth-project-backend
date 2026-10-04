AUDIT Claude Opus 5.5 — growth-project-backend#700 @ 5e3dabb0d0b9adc3ecf53c06f7bccf11852745fb — VERDICT: APPROVE
A/B/C = 0/0/2

Independent T4 audit (AUD-OPUS-PV3-118, agent 118). The PR body says T4 (PII in logs, auth.service.ts, public privacy text). The whole PR diff was read: 31 files, 1,858 added and 154 removed, which is 2,012 lines. The operator SIZE ASSESSMENT is KEEP. The FIX ROUND 2 delta was also read line by line: `64ad9438..5e3dabb0`, 18 files. [Reviewed comparison](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/2af682ca968f11210971abdec8f9d9060cac609f...5e3dabb0d0b9adc3ecf53c06f7bccf11852745fb)

## Prior findings of this lens (at 66569a61): all closed with code and a failing-before test
- **B-700-1 (coach full name in coach-brief log lines): closed.**
  - `coach-brief.service.ts:1463` builds `logRef` from `coach=<id> mode=<mode> date=<date>`.
  - `violation` values are server-owned codes (`validateClaudeNarrative`, :508-549).
  - `invokeClaudeOnce` returns `describeFailure(err, BRIEF_ERROR_CODES)`.
  - The guard's `PERSON_NAME_TOKEN` matches `safeCoachName` and `clientDisplayName`, and both are on its `bad` list.
- **B-700-2(a) (Supabase error text): closed.** `auth.service.ts:1479` and :883 now log `describeFailure(error)`, for example `error=Object status=400 code=email_address_invalid`.
- **B-700-2(b) (finance path with the encoded address): closed.**
  - `finance-admin.client.ts` logs `route=<FinanceRoute label>` (:183-185).
  - The guard's `path` rule applies to every file that runs `encodeURIComponent(<email>)`.
- **C-700-3 (provider body text): closed.** `ProviderFailure` messages are built only from the provider, a status of 100-599, and a code from a finite list. `providerErrorCode` never returns body text.
- **C-700-5 (webhook labels): closed.** `payloadShape` names only events and keys from the finite lists, plus `other_keys=<n>`.
- **C-700-2 (raw exception text): closed for the files listed in the guard**, with one exception: checkout-recovery, see C-700-6. The rest is held in the exact-match `LEGACY_EXCEPTION_TEXT` baseline.
- **Out of scope (operator, JOBS118):** C-700-1 (owner reason text, needs a migration) and C-700-4 (calorie values). Both are still open and are not counted here.
- **Probe replay at this exact head.** My three FU2 probe specs, Sol's `audit-sol-fu2-118-boundary.spec.ts`, and the PR's own privacy specs all pass. The specs were copied byte for byte, checked with `diff` against the files saved in ops/aud-118. [Lens run 37224777673](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224777673)
  - Branch `audit/AUD-OPUS-PV3-118/700-probes`, commit 6ca8adf6, which is the PR head plus probe-only commits.
  - The suite count is 9: 8 passed and 1 failed. The failing suite is the new probe below, red by design.
- **Builder evidence, checked on GitHub.**
  - Failing before: [run 37221266107](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221266107), at c7224bb7 = 6946f0b9 (tests only) + the 4 lens specs, unchanged.
  - Passing after: [run 37222059865](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222059865), at aa267a99 = d8ee379f + the same specs.
- **The main merge 64ad9438 is clean.** `git show --remerge-diff` is empty, and no PR file changed in the merge.

## The log guard: the operator's check
- **Every probe shape is caught.** The rule self-test has a `bad` entry for each of these, and each fails its rule:
  - `coach=${safeCoachName}`
  - `${error.message}` / `${linkError?.message ?? ...}`
  - `path=${path}` in an address-encoding file
  - `${msg}` and `safeStringify(body)`
- **The baseline is exact-match per file.** `expect(exceptionText).toEqual(LEGACY_EXCEPTION_TEXT)`, so a detected site cannot be added or removed without editing the list.
- **An independent re-run of the guard logic over `src/` at this head agrees:**
  - 934 log calls scanned
  - strict violations: 0
  - exception text: 141 files and 306 sites, the same as the baseline
- **Limit:** the count shrinks only for shapes the guard can see. Two common shapes are not counted (C-700-6).

## C-700-6: two exception-text shapes the guard does not count, and one fixed file that still prints Redis text
- **Where:**
  - `test/privacy/no-pii-in-logs.spec.ts:474`
  - `src/storefront/checkout-recovery.service.ts:164, :178, :511`
  - `src/scheduling/google-oauth/google-oauth.service.ts:160-162` (outside this diff)
- **Proof:** [lens run 37224777673](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224777673). The probe branch adds `src/observability/aud-opus-pv3-118-probe-sink.ts` with two new log calls. `no-pii-in-logs.spec.ts` still passes, yet the probe captures these lines:
  - (a) `${userId}: ${err}` logs `probe send failed user=user-1: Error: Email address "pat.client+tgp@example.com" is invalid`.
    - The bare-error rule is anchored to `^` or `[,(]` on the joined template expressions. So it matches only when `err` is the first or only expression.
  - (b) `const detail = err.message` followed by `${detail}` logs the message.
    - Only the names `message|msg|errMsg|errorMessage|errMessage` are checked.
    - This is the shape at checkout-recovery.service.ts:162-179 and :510-512. The guard's test "the files B-PRIVFU2-118 fixed print no exception text at all" lists that file, and FIX ROUND 2 says every log line in it uses describeFailure.
    - The probe got `Redis unavailable in development, falling back to in-memory (dev/test only): PROBE-REDIS-TEXT connect ECONNREFUSED ...`.
    - Redis error text carries no person's data, so this is not a privacy leak today. The finding is that the test name and the README sentence "A new site fails the guard" (src/observability/README.md:108) are not true for these shapes.
  - The quit-path probe case did not reach its log line in the isolated-module harness. It is not cited as evidence; that site is shown by reading :510-512.
- **Fix rule:**
  - Make the bare-error rule match an error identifier in any expression position.
  - Count any variable assigned from `.message`, `.stack`, `String(err)` or `res.text()` in the same file when it is logged.
  - Move the 3 checkout-recovery lines to `describeFailure(err)`.
  - Count or fix google-oauth.service.ts:161 (`detail.slice(0, 200)` of the Google token-endpoint body).
  - Add both shapes to the `bad` list.
- **Verify:** replay `ops/aud-118/AUD-OPUS-PV3-118/probes/`. The guard must then fail on the probe sink file.

## C-700-7: server-owned configuration errors now read `error=Error`
- **Where:** `auth.service.ts:1162, :1994, :2073` log `describeFailure(err)` for the verifier's own errors:
  - `apple-verifier.service.ts:72` (`APPLE_AUDIENCES not configured`)
  - `google-verifier.service.ts:73`
  - The same applies to the coach-brief client init at `coach-brief.service.ts:1438`.
- **Counterexample:** a missing APPLE_AUDIENCES now logs `apple token verify failed: error=Error`. That cannot be told apart from any other plain Error, and the old line named the misconfiguration.
- **Fix rule:** throw a typed config error whose code comes from a finite module list, such as `APPLE_AUDIENCES_UNSET`, and pass that list to `describeFailure`.
- This costs no privacy and gives ops the diagnosis back.

## Evidence reuse (G09)
- No approval is reused; every line of the PR diff was audited here.
- Unchanged since my FU2 audit at 66569a61:
  - the public Apple text (`trust-pages.html.ts:95-98`)
  - the vendor-deletion doc
  - the READMEs
- I verified those against Apple Support 102571 and the iPhone User Guide pages for 18.0, 17.0 and 16.0 on 10-04. My FU2 fetch record for them is reused, since the text is byte-identical (`git diff 66569a61 5e3dabb0` is empty for those files).
- I read the Sol verdicts only after these findings were drafted. Nothing in this verdict is copied from them.

## CI at this exact head
- 11/11 required checks are green: build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, npm audit, CodeQL JS/TS, Banned cast tokens, build-sbom, danger, Schema parity, community-live-tests. [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222341084/job/111495055067)
- The merge state is CLEAN, on base main 2af682ca.

## Merge note
- The live /privacy and /help/delete-account pages (production 643817b3) still show the pre-#700 Apple text, without the iOS 18 qualifier.
- Mobile #368 uses the #700 wording. So #700 should merge and deploy before, or together with, the next mobile build that carries #368.
