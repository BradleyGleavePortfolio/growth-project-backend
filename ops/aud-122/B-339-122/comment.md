FIX ROUND (B-339-122, agent 122) — growth-project-mobile#339 @ 0b0de03db5b4fc191e974d65a9113a69aa0597a3

Previous head 8165ca9560d2bcd35f92b1cd8468e6c998aa552a. Answers [Sol RC](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/339#issuecomment-5972066633) (A/B/C 0/1/0). One push, size 713 lines vs main (+488 -225, 112 files).

**Commits**
- `26c974b0` merge main `3c315e40`: 7 conflicted files, every conflict hunk takes main's side (main's copy there is already impersonal and newer: Apple Account naming, the Trust Center data-sharing list, Health Connect wording, the wearables connect rewrite). `ConnectProviderSheet.tsx` and `DeleteAccountScreen.tsx` now match main exactly.
- `023dea20` five first-person strings main added after the sweep, found by the voice guard on the merged tree: `CoachPackageEditScreen.tsx` archive alert and `utils/packageSaveFailure.ts` (currency, network, not configured, 5xx). Same meaning, no "we/our"; two tests repinned.
- `dbbcafd3` **B-339-1 fixed**: unknown or 5xx outcomes now say the result could not be confirmed instead of claiming nothing was written.
  - `api/communityEventsApi.ts` 5xx: "The event service had a problem, so the change could not be confirmed. Check the event, then try again if needed."
  - `utils/authErrorMessage.ts` `SIGNUP_UNKNOWN_MESSAGE`: "Account creation could not be confirmed. Sign in with the same email first; if the account exists, you will be signed in. If not, try again, or contact support if it keeps happening."
  - `utils/authFailure.ts` unknown sign-up lead: "Account creation could not be confirmed because of a server problem." (reference and support path unchanged)
  - `ChallengeProgressSheet.tsx` catch: "Saving your progress could not be confirmed. Check your connection, then try again."
  - `ReportMessageSheet.tsx` catch: "Sending your report could not be confirmed. Check your connection, then try again."
  - Known refusals (409 email exists, 400 invite/password/email, 401/403/409 event) keep their definite copy.
  - Regressions: `authFailure.test.ts` (unknown sign-up through both mappers never says "not created"; 409 positive control), `communityEventsApi.mutationError.test.ts` (500 never says "nothing was changed"), `ReportMessageSheet.test.tsx` (never "was not sent").
  - Normal-user story: a new client taps Create account during a brief server error; the account is made, but the app said it was not created, so the retry hits "An account with this email already exists" and they are left guessing.
- `0b0de03d` merge main `a9bd9470` (scheduling K1-K3), clean.

**Voice check on the merged tree**: 829 source files, 0 offending strings, no stale exception, no 180-day text in `src/` or `docs/`. "I/I'm/I'll" strings: the same set at the old head and the merged tree (main brought none new).

**CI**
- Lane (tsc + 27 targeted specs incl. the voice guard, package, auth, event, report, Trust Center, account deletion, wearables connect): [run 37395043703 green](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395043703).
- PR CI at this head: all required checks green: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395344603/job/112049876945), [CodeQL analyze](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395344851).

**Proposed C (no change in this PR)**
- C-339-a: `utils/packageSaveFailure.ts` (main code, not this PR) 5xx/timeout branches still say "Your changes were not saved" / "The package was not created"; same pattern as B-339-1 on the coach package flow. Follow-up ticket.
- C-339-b: `RomanAiConsentScreen.tsx` says "I could not reach the server ..." (Roman voice in a settings error); the guard does not cover "I". Decide whether Roman first person is allowed outside chat.
- C-339-c: `authFailure.ts` unknown role-selection lead "Account setup did not finish" has the same certainty pattern; not flagged by Sol.
- Operator decision carried from Sol: the three hashed P0 consent strings stay exempt until a paired mobile/backend consent-version bump. Recommended default: keep the exemption for launch.

READY FOR AUDIT
