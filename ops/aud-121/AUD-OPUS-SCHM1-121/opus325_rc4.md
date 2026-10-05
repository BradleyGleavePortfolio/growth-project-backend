AUDIT Claude Opus 5.5 — growth-project-mobile#325 @ 268ed81b1b69c58f92eb2e93716b58fef18aa368 — VERDICT: REQUEST CHANGES

T4 delta from my APPROVE at `36f05bba` ([5960647810](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/325#issuecomment-5960647810)). I read the S-SCHED-5 main-merge record ([5963289830](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/325#issuecomment-5963289830)) and Sol's RC at this head ([5964510511](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/325#issuecomment-5964510511)). **A0 / B1 / C0.** I independently confirm Sol's B-325-4 and use the same ID, so one round closes both lenses.

### Merge `268ed81b` (36f05bba + main f34b5b99, #324): not pure; resolution reviewed
`git merge-tree --write-tree` gives `30e8f4fa`, with conflicts in `lib/consultation/copy.ts` and `screens/settings/deletionErrors.ts`. Both take main's side; at the head, those two files equal `f34b5b99`.

The extra semantic edits against the merge tree (9 files, +40/−34) are:
- `src/config/support.ts` is deleted, with no change to the literal value.
- `schedulingErrors.ts`, its test, `CalendarHomeScreen` and the literal-pin test are repointed to `src/constants/support.ts`.
- The Calendar "no coach" Contact support now uses the shared `useSupportEmail('Calendar help')` + `SupportEmailFallback` instead of its own `Linking.openURL`.
- The new mounted test drives failed draft → address → Copy → Try again.

There is no scheduling wire, transition or permission change, and no package, lock or eas.json edit. C-325-7 is closed.

### B-325-4 (confirmed): PR-owned scheduling error copy speaks as "we"
- **Evidence:** `src/calendar/schedulingErrors.ts` has five first-person literals, all added by this PR (an added-lines grep of the PR's own non-test `src` diff finds exactly these five and nothing else):
  - `:118` "Your login expired before we could …";
  - `:149-150` "The connection dropped before we could …", for coach and client;
  - `:164-165` "We could not …", in the unknown-error fallback.
- **Reach:** `calendarErrorMessage`, used by Calendar home, booking and detail, and by the coach scheduling screens, returns these lines.
- **Rule broken:** the brief forbids we/us in client-facing error copy. `schedulingErrors.test.ts:45` pins the first-person text.
- **Minimal fix:**
  - Rephrase without first person, keeping each action, the reference + `SUPPORT_EMAIL` on unknown errors, and the "may have gone through" caution. For example:
    - "Your login expired before the booking could be sent. Log in again, then check …"
    - "The connection dropped before this could finish. …"
    - "This could not be completed. …"
  - Replace the pinned test, and add a table-driven guard over every coded, HTTP, network and unknown message × client/coach that asserts no we/us/our, no exclamation marks and no emojis.

### Prior findings
- B-325-1/2/3 remain closed: the Call handling bounds, the expired-request Decline path and the ruled support address (now from the canonical module).
- C-325-2/3/5/6 remain closed; C-325-4 stays under its ruling.

### Integration
The PR is behind main `1f8981dd`. `git merge-tree` with main (`22aa7073`) is clean, and so is the merge with #326 `4ae5210d` and with #317 `cfa99ce3`. The final head needs a delta after the next main merge.

### Evidence
Required checks at `268ed81b` (Typecheck/lint/test, Analyze ×2, CodeQL) are SUCCESS; they do not enforce the copy rule.

Backend #634 deploy, the reminder activation gate and device acceptance remain operator gates. No push, merge, dispatch or production action by this auditor.

