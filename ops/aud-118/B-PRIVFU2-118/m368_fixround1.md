FIX ROUND 1 (B-PRIVFU2-118, agent 118) — growth-project-mobile#368 @ fdfecc47a4ff8a65bf1cd8f6a26f1c2a34c88c45

This round closes both lenses' request-changes reviews at `2216ad1d`: Sol 0/1/0 and Opus 0/1/3. It fixes B-368-1 and the Cs the job entry names: C-368-1, C-368-2 and C-368-3 (`utils/authFailure.ts:183` was added to C-368-3). The base is still `main` `7fdb629a`, so no merge was needed.

Commits on top of `2216ad1d`:
- `b5feeed8`: tests only (failing-before).
- `fdfecc47`: the fix. It also corrects two assertions in the new tests. One expected a comma where the test had a full stop; the other matched pronouns case-insensitively, so it read the `'en-US'` locale as "us". Both assertions failed before the fix for the intended reason as well.

## Findings -> change -> commit -> test

| Finding | Change | Commit | Test (failing before, passing after) |
|---|---|---|---|
| B-368-1 (Sol, Opus): `APPLE_FORM_NOTE` promises an Apple card after confirming, but none appeared when `getSignInProviders()` returned null and the outcome was `not_requested` or missing | `DeleteAccountScreen.tsx`: `appleFallbackCopy()` decides which card shows. Apple's confirmation shows only for `revoked`. Otherwise a fallback shows when the account lists Apple, the person confirmed with Apple on this visit (new `confirmedWith` state), the server tried to revoke, or the provider lookup could not tell (new `providersChecked` state). A confirmation made before the lookup finished counts as "could not tell". A known non-Apple account still sees no card. `confirmedWith` resets on Keep my account. The lookup's `.catch` is now guarded against a closed screen. | `fdfecc47` | `DeleteAccountScreen.test.tsx`, block `B-368-1 / C-368-1`: providers unknown with Apple and `not_requested` and no code; Apple with no `apple_revocation`; password confirmation; controls for revoked, `not_configured`, a known email-only account, and a known Apple account confirmed by password |
| C-368-1 (Opus): the fallback should start with what Apple has not confirmed | Right after confirming, the fallback starts "Apple has not confirmed that this app’s access was removed." (`APPLE_FALLBACK`). If the lookup could not tell, it starts "If you signed in with Apple, Apple has not confirmed …" (`APPLE_FALLBACK_IF_APPLE`). The status endpoint carries no outcome, so a later visit says "If Apple did not confirm … when you confirmed the deletion …" (`APPLE_FALLBACK_LATER` and `_IF_APPLE`). Every fallback ends with `APPLE_REMOVAL_STEPS`, the same steps as the backend's `SIGN_IN_WITH_APPLE_DELETION_TEXT` (#611 and #700). | `fdfecc47` | `APPLE_FALLBACK` pinned word for word; two later-visit cases; every variant ends with the steps and has no first person, "Apple ID" or exclamation mark |
| C-368-2 (Opus): first person at `:80` and `:138` | `KEPT_RECORDS[0]` now reads "The app’s own copies keep only amounts, dates and payment references, with no name or contact details." That is the same claim as the backend help page's retained-records line. The status error default now reads "The account deletion status could not be checked. Check your connection, then try again." | `fdfecc47` | `KEPT_RECORDS[0]` is pinned, and a source scan finds no `we`, `our` or `us` in any string literal of the screen |
| C-368-3 (Opus): "Apple ID" and first person in sign-in copy | `lib/signupRoleNotice.ts:53`: "This Apple Account or Google account already had an account, so you were signed in to it. …". `screens/auth/CreateAccountScreen.tsx:1015`: "… the app could not confirm …" and "… the same email, Apple Account or Google account first …". `utils/authFailure.ts:183`: "The email on your Apple Account is not verified. …" | `fdfecc47` | new `src/lib/__tests__/appleAccountCopy.test.ts` |

## Lens probes replayed (verbatim, at the fix head)

| Probe | At `2216ad1d` | At fix `fdfecc47` |
|---|---|---|
| Sol `audit-sol-fu2-118-apple-outcome.test.tsx`: providers unknown, Apple, `not_requested` (the note promise and an `apple-fallback` card) | fail | pass |
| Sol: providers unknown, Apple, outcome undefined | fail | pass |
| Opus `368-applenote-probe.patch`: confirmed with Apple, no code, `not_requested`, an Apple card is shown | fail | pass |
| Opus: confirmed with Apple, response without `apple_revocation`, an Apple card is shown | fail | pass |
| Opus control: code sent, `not_configured`, the fallback is shown | pass | pass |

- **Failing before:** CI-lane run [37222630053](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37222630053) at test-only commit `b5feeed8`, with the Sol probe file and the Opus patch applied verbatim. 3 suites failed; 16 tests failed and 52 passed.
- **Passing after:** CI-lane run [37222797494](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37222797494) at fix `fdfecc47` with the same probes, plus `signupRoleNotice`, `authFailureFixRound7`, `CreateAccountScreen` and `RoleSelectionRetry`. 7 suites passed; 173 tests passed.
- **Required checks at this head:** all 3 are green. [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37222822046/job/111496417803) passed 453 suites and 6,335 tests. The other two are CodeQL and Analyze (actions, javascript-typescript).

## Money list (one line each)
- Webhook order and redelivery: N/A.
- Concurrency: N/A. Nothing new is sent to the server, and the deletion request is unchanged.
- Terminal states: N/A. The deletion states and the status endpoint handling are unchanged; only which Apple card appears in `confirmed` changed.
- List pagination: N/A.
- Currency: N/A.
- Copy truth: every fallback says only what the screen knows (the outcome in hand, or no outcome on a later visit). It is conditional when the provider is unknown. The Apple steps are the same as the backend policy text. Apple's confirmation still appears only for `revoked`.

## Pre-push checklist
- Logs: no new log calls.
- Await and state-write identity recheck: `confirmedWith` is written in the same block as the existing `appleOutcome` write after `requestDeletion`, and no new await was added. Both write paths of the provider lookup are guarded by `mounted`.
- Unmount races: the lookup's `.catch` was missing the `mounted` guard; it now has it. React 18 does not report a write after unmount, so no test can observe the race. A console-based test was tried and removed as unobservable.
- Copy rules: no first person, emoji, exclamation marks or generic errors in the changed strings. "Apple Account" throughout, and the clinic partner is not named.
- Failing-before test per finding: yes, see above.
- Size: 394 changed lines (372 added, 22 removed), well under the size bands.

READY FOR AUDIT
