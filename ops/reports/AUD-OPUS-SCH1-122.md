# AUD-OPUS-SCH1-122 — Claude Opus 5.5 lens, scheduling mobile m#365-#367 (agent 122)

Started 16:33 PDT 2026-10-05, verdicts posted 16:43 PDT. First full review, T4, RUTHLESS SCOPE. Backend reference: growth-project-backend
origin/main 5cde6253 (scheduling b#712-#720 + #653 = production deploy 4). Claims: ops/lanes122/claims/mobile-36{5,6,7}-<head8>-opus.
Notes: ops/aud-122/AUD-OPUS-SCH1-122/notes.md (comment bodies c365.md, c366.md, c367.md alongside). The Sol work was not read.

| PR | Head | Size | Verdict | A/B/C | Comment |
|---|---|---|---|---|---|
| m#365 | cceeb33a71982d44da40e75714332f59844e45fc | 2,025 (grandfathered, opened 10-03 21:34Z) | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6005654915 |
| m#366 | fa7744cc237418a90239279541450ce2a8dc5959 | 1,680 (grandfathered) | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6005655423 |
| m#367 | 6418e759813065dc353720533dfd5c9b5a51ceb3 | 2,294 (grandfathered) | REQUEST CHANGES | 0/1/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6005655881 |

## B
- B-367-1: the client Calendar shows an expired request as "Status unavailable. Refresh Calendar or message your coach."
  - The backend returns status 'expired' (scheduling-session.view.ts:98), and the client upcoming list does not filter by status.
  - Mobile SchedulingSessionStatus (schedulingApi.ts:50-57) has no 'expired', and statusLabel (calendarUi.tsx:11-29) falls through to its default.
  - The text shows at CalendarHomeScreen.tsx:157 and CalendarSessionScreen.tsx:171, including after a tap on the "Session request closed" push.
  - Story: a client requests a time that needs approval, the coach does not answer within 48 hours, and Calendar says "Status unavailable" instead of saying the request closed.
  - Fix in m#367: add 'expired' plus a plain label, and optionally a "Pick another time" action.
  - Verify: a unit test showing statusLabel('expired') is not the default, plus a screen test that renders an expired session.

## Cs (follow-up tickets)
- C-365-1: REQUEST_EXPIRED has no mapped copy, so the generic 409 copy shows.
- C-366-1: the tutorial line at tutorialSteps.ts:363, "Pick a time that suits you and it is set.", is not true for approval types. The next screen corrects it.
- C-367-2: CalendarBookScreen.tsx:66, "<coach> will see it in Calendar". The coach sees it in Booking inbox > Upcoming sessions.
- C (edge, deferred to 10k clients): a lapsed request that has not been swept is hidden from the coach inbox by the client-side status guard.

## Operator items
1. Coach booking options (minimum notice, booking window, buffers, daily maximum; owner A6.2) exist in neither backend main nor
   this stack. This is not a B here because it is outside the diff. Recommended default: open a separate backend + mobile item, and do not block this train.
2. Land m#365-#367 as one (A5 rule 11).
   - K1 turns EXPO_PUBLIC_FF_CLIENT_CALENDAR on in the production and clinic EAS profiles.
   - K2 adds tutorial steps that target tab:CalendarTab, and only K3 registers that tab.
   - Merge back to back with no EAS build in between.
3. CI: Typecheck, lint, test is green at all three heads, and CodeQL is green on K1. These runs are from 10-03 on base 367e6c48, and main is now 2c88eae.
   The bottom piece needs a main refresh and green required checks before merge.

## Re-review guide (for the next Opus lens)
- Only B-367-1 and the changed lines.
- Check that the expired label is plain copy (no first person, no exclamation marks) and that the default branch is no longer reached for 'expired'.
- If the fix widens SchedulingSessionStatus in m#365 instead of m#367, both K1 and K2 move and need a restack. A merge-only delta check applies to #366.

## HANDOFF
- State: all three verdicts are posted at the exact heads above, and no worktree remains (wt/AUD-OPUS-SCH1-122-367 was removed).
- No audit/* or ci/* branches were created, and no lane runs were started. Nothing is in flight.
- Next: the builder fixes B-367-1 on m#367. An Opus lens then delta re-reviews m#367 at the new head (20 min box), using this report.
- m#365 and m#366 Opus APPROVEs stand unless their heads move.
