AUDIT Claude Opus 5.5 — growth-project-mobile#368 @ fdfecc47a4ff8a65bf1cd8f6a26f1c2a34c88c45 — VERDICT: APPROVE
A/B/C = 0/0/2

Independent T4 audit (AUD-OPUS-PV3-118, agent 118). The PR body says T4: public deletion copy, and the `apple_revocation` handling. The whole diff was read: 7 files, 372 added and 22 removed. The FIX ROUND 1 delta `2216ad1d..fdfecc47` was also traced through every state write and render branch. [Reviewed comparison](https://github.com/BradleyGleavePortfolio/growth-project-mobile/compare/7fdb629a798d44e76475dbece1b14e68f360ab91...fdfecc47a4ff8a65bf1cd8f6a26f1c2a34c88c45)

## Prior findings of this lens (at 2216ad1d): all closed with code and a failing-before test
- **B-368-1 (the APPLE_FORM_NOTE promise could fail): closed.**
  - The status view now renders `appleFallbackCopy(...)` (`DeleteAccountScreen.tsx:124-139, :489-494`).
  - When the outcome is `revoked`, it shows Apple's confirmation.
  - Otherwise it shows a card whenever the person may have signed in with Apple:
    - the account lists Apple;
    - `confirmedWith === 'apple'`;
    - the server tried to revoke;
    - or the lookup could not tell, which includes a confirmation made before the lookup settled.
  - A known non-Apple account sees no card.
- **Truth table checked by reading, and in tests.** Each case below shows the matching card:
  - Unknown providers + Apple + `not_requested` / no code
  - Unknown providers + Apple + no `apple_revocation`
  - Unknown providers + password
  - Known Apple account + password
  - A later visit (no outcome in hand) gets `APPLE_FALLBACK_LATER*`, which is conditional and claims nothing about Apple's answer.
  - `revoked` shows the confirmation only.
  - Known email-only shows nothing.
- **The note is now true in every reachable path.**
- **State writes are safe.**
  - `confirmedWith` is written in the same post-await block as the existing `appleOutcome` write.
  - It is cleared on Keep my account (:373).
  - Both write paths of the provider lookup are guarded by `mounted` (:238-248).
- **C-368-1: closed.** `APPLE_FALLBACK` starts "Apple has not confirmed that this app’s access was removed."
- **C-368-2: closed.** `KEPT_RECORDS[0]` says "The app’s own copies". The status-error default has no first person.
- **C-368-3: closed.** "Apple Account" at `signupRoleNotice.ts:53`, `CreateAccountScreen.tsx:1015` and `authFailure.ts:183`. No user-facing "Apple ID" string remains in `src/`; only comments still use it.
- **Probe replay at this exact head: passes.** [Lens run 37224697247](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37224697247)
  - What ran: my FU2 `368-applenote-probe` block (appended to the test file, unchanged) and Sol's `audit-sol-fu2-118-apple-outcome.test.tsx` (unchanged), plus `appleAccountCopy.test.ts`.
  - Branch `audit/AUD-OPUS-PV3-118/368-probes`.
  - Result: 3 of 3 suites and 68 of 68 tests passed.
- **Builder evidence, checked on GitHub.**
  - Failing before: [run 37222630053](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37222630053), at 4faad225 = b5feeed8 (tests only) + both lens probes.
  - Passing after: [run 37222797494](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37222797494), at 4dd999e6 = fdfecc47 + the same probes.

## Same text as the backend policy
- **`APPLE_REMOVAL_STEPS` (:94-96) gives the same steps as backend #700's `SIGN_IN_WITH_APPLE_DELETION_TEXT`** (`trust-pages.html.ts:95-98` at 5e3dabb0):
  - iOS 18 or later: Settings > your name > Sign in with Apple > the app > Delete.
  - Earlier iOS or any other device: account.apple.com > Sign-In & Security > Sign in with Apple.
  - The only differences are "this app" for "the app" and one comma.
- **Apple's pages agree:**
  - [Apple Support 102571](https://support.apple.com/en-us/102571) (published 2026-09-14)
  - [iPhone User Guide, iOS 18.0](https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/18.0/ios/18.0)
  - [iPhone User Guide, iOS 17.0](https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/17.0/ios/17.0) (Password and Security on 16 and 17)
- **Live check, 10-04.** The production /privacy and /help/delete-account (backend 643817b3) still show the pre-#700 wording: an unqualified iPhone path, then "On the web". The steps do not conflict, but the live text lacks the iOS 18 qualifier until #700 deploys. Operator decision 1 in the report: deploy #700 before or with the next mobile build that carries #368.

## C (follow-ups, not blocking)
- **C-368-4: a later visit cannot show Apple's outcome (backend, outside this diff).**
  - `GET /me/delete-account/status` carries no `apple_revocation`.
  - So a person whose outcome was `revoked` sees the conditional "If Apple did not confirm ..." card on a later visit.
  - Fix rule: persist the outcome and return it in the status response, then show `revoked` or `APPLE_FALLBACK` on later visits too.
- **C-368-5: first person remains in nearby sign-up copy (outside the changed lines).**
  - `signupRoleNotice.ts:51, :55` ("we will set up coach access")
  - `CreateAccountScreen.tsx:892` ("We sent") and `:902-903` ("we could not connect you", "we will ask")
  - Also on the builder's list: `deletionErrors.ts:101, :126, :129` and `authFailure.ts:161, :186-187`.
  - Fix rule: subjectless or "the app" wording, and update the pins (`authFailureFixRound7.test.ts:43`).

## Evidence reuse (G09)
- No approval is reused; the full diff was audited here.
- I read the Sol verdict only after these findings were drafted.

## CI at this exact head
- Required checks are green: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37222822046/job/111496417803), Analyze (javascript-typescript) and Analyze (actions). CodeQL is green too.
- The merge state is CLEAN, on base main 7fdb629a.
