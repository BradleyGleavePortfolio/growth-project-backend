AUDIT Claude Opus 5.5 — growth-project-mobile#352 @ ac244d22e107e93209a5e1d206d2951d3392fe38 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/5

Lens AUD-OPUS-L12-119 (agent 119). Tier T4 (billing lockout, money copy, auth-generation ownership). Size 2,341 (grandfathered at 12:33, under the 3,000 ceiling).

**Evidence reuse (G09).** This lens approved #352 at `58b80914` (0/0/6, [5977022730](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5977022730)). The main merge `fe2fa580` is clean: its tree `52f98331` equals `git merge-tree --write-tree 58b80914 7fdb629a`. So the unchanged lines rest on that approval. Every line of fix `ac244d22` (9 files, +613/-46) was audited fresh at T4: `dunningLockoutStore.ts`, `api.ts`, `authActions.ts`, `dunningApi.ts`, `dunningErrorCopy.ts`, `updateCard.ts` and both tests. The copy was judged against the new binding ruling R-DISPUTE-PAUSE (owner 12:01 PDT 10-04; _COMMON_119 item 12), not against the old compressed dispute cycle.

**Main.** `cc4ceeed` (#368) touches none of this PR's 14 files, so an update-branch qualifies for the rule 12 MERGE-ONLY TREE CHECK.

**Probe run.** CI lane [run 37229725928](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229725928), branch `audit/AUD-OPUS-L12-119/352-dispute-pause` from this head, probe spec only.
- `aud119OpusL12_352.probe.test.ts`: 4 PROBE fail as predicted; the CONTROL passes.
- `dunningL1Contract.test.ts` and `api.lockedDunning.test.ts` pass: 19 of 23 tests pass in total.

## Prior Opus findings (at 58b80914)
| ID | Status at ac244d22 |
|---|---|
| C-352-1 reference conventions | Open (follow-up) |
| C-352-2 land #352 -> #354 as one | Open (process) |
| C-352-3 RATE_LIMITED "Wait a minute" vs Retry-After 3600 | Open (follow-up) |
| C-352-4 403 message false for a dispute lock | **Closed.** `LOCKED_DUNNING_MESSAGE` (`api.ts:105-106`) is neutral for both lock kinds; pinned by the `api.lockedDunning.test.ts` "C-352-4" test (passes in 37229725928) |
| C-352-5 outcome drops dispute facts | **Closed for the facts.** `confirmDisputes` (`dunningApi.ts:323-337`) merges `plans[].dispute_open` with the quote's disputes and never drops a flag. The wording is now B-352-7 |
| C-352-6 #342 duplicate theme/SDK loader | Open (outside this diff) |

## Fix-round code checked and sound
- **Generation ownership (B-352-1, Sol's finding).**
  - The interceptor stamps the generation before the token await (`api.ts:118-121`).
  - `reportLocked` drops a signal from a retired generation; unstamped counts as 0, so it fails closed after the first boundary (`dunningLockoutStore.ts:66-72`).
  - `retire()` runs on `authEvents` 'logout' (sign-out, refresh failure, biometric lock) and in `resetUserScopedStores`.
  - A 401 retry goes back through the request interceptor and is re-stamped.
- **`machineCode()`.** Only SCREAMING_SNAKE counts as a code. Production's `{error:'Not Found'}` 404 reads as BILLING_ROUTE_NOT_AVAILABLE and is not reported. A bare 503 on confirm reads as RESULT_NOT_CONFIRMED. Both are truthful against today's production `3e9a9a75`.
- **`isCurrent` checkpoints in `runNativeCardUpdate` / `confirmWithBank`.** They run before and after every request and native step. A retired owner never sends confirm. The comment correctly claims nothing about requests already sent.
- **Disputed totals.** Summed per currency only; integer minor units; never summed across currencies.

## Findings
**B-352-7: dispute copy contradicts R-DISPUTE-PAUSE.**
- **Where:** `src/entitlements/dunning/dunningErrorCopy.ts:456-460` (`disputeNotSettledLine`, appended to every card-update outcome at `:477-478,531`, and to `saved` at `:496-498`) and `:588-592` (`cancelOutcomeCopy(r, { dispute: true })`).
- **What the copy says:**
  - "Your bank reversed an earlier payment of $150.00. Saving a card does not settle that. Email <support email> to sort it out."
  - The end-plan outcome adds "Ending the plan does not settle the payment your bank reversed. Email <support email> to sort it out."
- **What the ruling requires:** copy about a dispute on a recurring plan says exactly three things: access has ended, billing is paused, the coach decides on restarting. Nothing restores automatically.
- **Why the current copy fails:** it says none of the three. It sends the client to support "to sort it out", which implies that support can settle the dispute and bring access back. Under the ruling only the coach restarts access.
- **Counterexample:** in run 37229725928 these 4 PROBEs fail:
  - the line has no coach-restart rule and contains "sort it out";
  - the line does not say billing is paused or access has ended;
  - the end-plan dispute outcome has the same problem;
  - a dispute-only card save has the same problem.
- **Fix rule:** one shared dispute sentence in L1, used by every dispute surface (L2 imports it):
  - Text: "Your bank reversed a payment of X to <coach>. Your access has ended and billing for this plan is paused. <Coach> decides whether to restart it."
  - Next step: message the coach. Support only for questions, never as the way to restore access.
  - No "sort it out", no "settle", no restore wording.
- **Verify:** the probe spec above (4 PROBE) plus the builder's own failing-before test.

**C-352-8 (new): the 'login' listener never fires.** `dunningLockoutStore.ts:111-114` registers `authEvents.on('login')`, but nothing in `src/` emits the named 'login' event (every sign-in path calls `authEvents.emit()`). The comment at `:17-19` claims a sign-in boundary. The real boundary is 'logout', `resetUserScopedStores` and the provider unmount in L2, all present. So this is a comment error, not a hole. Fix rule: correct the comment, or emit 'login' on sign-in.

**Carried, open:** C-352-1, C-352-2, C-352-3, C-352-6. With C-352-8 that makes C = 5.

## Money list (lens check)
- **Webhooks:** none on mobile.
- **Concurrency:** generation-fenced; no client locks.
- **Terminal states:** disputed copy is wrong under the new ruling (B-352-7); canceled, voluntary and deleted-account handling unchanged and correct.
- **Lists:** the quote fails closed.
- **Currency:** minor units, per currency.
- **Copy truth:** B-352-7.

CI at this head: Typecheck, lint, test; Analyze (javascript-typescript); Analyze (actions): all pass. Merge state BEHIND main `cc4ceeed` (no file overlap).
