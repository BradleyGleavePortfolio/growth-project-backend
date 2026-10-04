# AUD-OPUS-H46E-119: Claude Opus 5.5 lens, Health Connect #362 FIX ROUND 4, #363 tests, #364 restack (T4: health data, SHORT delta)

- **Operator:** agent 119.
- **Run time:** 14:48-14:58 PDT 10-04. All times come from `TZ=America/Los_Angeles date`.
- **Claims (14:48):** ops/lanes119/claims/mobile-362-df44285d-opus, mobile-363-51a8dc33-opus and mobile-364-c084f8df-opus.
- **Notes:** ops/aud-119/AUD-OPUS-H46E-119/. It holds:
  - 362-delta.diff
  - verdict-{362,363,364}.md
  - posted-*.txt
  - run37237814702.log and run37237825184.log
  - probes/onDeviceState.opus119e.test.ts

## Verdicts posted
Each head was re-read just before posting (14:57) and was unchanged.

| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #362 (H4) | df44285d8b60a421277114601efa475744c5fac1 | APPROVE | 0/0/2 (C-362-12 rated, C-362-13 new) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5984831539 |
| mobile #363 (H5) | 51a8dc330ca100df82ee64e2725842b1ff9b93c6 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5984831702 |
| mobile #364 (H6) | c084f8dfc40a3c7c473584603bec38c109afd5bf | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5984831909 |

**PR CI.** "Typecheck, lint, test" is green at every head:

| PR | Run |
|---|---|
| #362 | 37237093309 |
| #363 | 37237106711 |
| #364 | 37237106706 |

Analyze runs only on PRs based on main.

## Facts verified
- **#362 delta (73dbefbc..df44285d).** One commit and one file: onDeviceState.ts, +30/-7. Every line was read.
- **The serial queue is correct.**
  - It cannot deadlock: no queued op awaits the tail.
  - A rejected op does not stall the queue: the tail settles to undefined either way, and the rejection still goes to its caller.
  - No write is lost: the sequence bump and the queueing happen in the same tick, and the filter and the removal queueing run with no await between them.
- **Unbounded wait (observation only).** A native op that never settles would stall all later writes and grant reads. AsyncStorage always settles its promises, so this is accepted.
- **#363.**
  - The own diff is 8 files, +1,626, tests only.
  - 4b36b32b adds Sol's sol119 probe unchanged plus serialQueue (5 cases, all read).
  - The merge 51a8dc33 is pure (its tree matches `git merge-tree`).
- **#364.**
  - The diff b261f218..c084f8df is byte-identical to f62f1bbe..51a8dc33.
  - The merge is pure.
  - The own-diff patch-id is e50c714e at both heads.
  - onDeviceState.ts is identical to #362.

## Probes (CI lane)
- **New probe: onDeviceState.opus119e (7 tests).** It covers:
  - a rejected grant write and the work queued behind it;
  - a rejected progress write followed by the next grant;
  - two overlapping Disconnects plus a Connect mid-removal (maxInFlight 1, the Connect survives);
  - read-after-write;
  - DOCUMENTS C-362-12 plus its control;
  - DOCUMENTS C-362-13.
- **Run 37237814702 at #362 (exec b08ab28b).** 12 suites pass, 129/129 tests. Two suites failed to load: hcPrivacyTemplate.opus119 and healthConnectRationale.opus118 need plugins/withHealthConnectPermissionDelegate, which only exists in H6. This is expected; both pass at the #364 top.
- **Run 37237825184 at the #364 top (exec f287414f).** 18/18 suites and 162/162 tests pass. This covers every earlier Opus probe, Sol's sol119 and the builder's serialQueue.

## Follow-ups (C)
- **C-362-12 (rated C, pre-existing).** Location: src/services/authActions.ts:116, with the sweep at :244 and :398.
  - Problem: the sign-out sweep runs outside the queue. A grant write in flight during the sweep survives it, for the same userId only.
  - Fix rule: export `settleOnDeviceStorage()` from onDeviceState and await it in signOut before `collectPrefixedKeys`.
  - Test: hold a setItem, then call signOut. No `wearables_on_device:` key may remain.
- **C-362-13 (new).** Location: src/services/health/onDeviceState.ts:136-138.
  - Problem: when a grant write is rejected, `authWrittenAt` is still credited. A Disconnect that started earlier then keeps the old grant and its progress.
  - Fix rule: on rejection, restore the previous `authWrittenAt` value if it still equals this write's seq, then rethrow.
  - Test: flip the DOCUMENTS C-362-13 expectation to null.
- **Carried open:** C-362-3 remainder, C-362-4, C-362-5, C-362-7, C-362-8, C-362-9, C-362-10, C-363-1, C-364-1..5, H3 INGEST_DISABLED_COPY.
- **Closed:** C-362-11 (by df44285d, with tests in #363).

## Operator decisions (recommended defaults)
1. **C-362-12 severity.** Ticket it as a C (default). It stays within one account, the window is narrow and comes after the fence, and the person had already consented.
2. **C-362-13.** Ticket it as a C (default).
3. **#363 SIZE ASSESSMENT.** Keep (default). It is 1,626 lines, test-only and grandfathered.

## HANDOFF
- **Verdicts.** Opus APPROVE at all three current heads: #362 df44285d, #363 51a8dc33, #364 c084f8df.
- **Next step.** Sol's H46E verdicts (not read by me) decide whether H1-H6 land as one, with Analyze at the main-based landing. If any head moves, a fresh Opus lens posts a delta from these heads and replays three probe folders:
  - ops/aud-119/AUD-OPUS-H46E-119/probes/
  - ops/aud-119/AUD-OPUS-H46D-119/probes/
  - ops/aud-119/AUD-OPUS-H46-119/probes/
  It also replays ops/aud-118/AUD-OPUS-H6-118/*.test.* and ops/aud-118/AUD-OPUS-H45-118/probes/ at the #364 top.
- **Cleanup.**
  - Done: audit/AUD-OPUS-H46E-119/{362,364}-probes deleted at 14:58, worktrees wt/AUD-OPUS-H46E-119-{1,2} removed, claims left in place.
  - Not done, by design: no push to a PR branch, no merge, no build or dispatch.
