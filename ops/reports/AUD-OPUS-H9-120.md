# AUD-OPUS-H9-120: Claude Opus 5.5 lens, mobile #369 (FIX ROUND 2) and #370 (H8 OPENING), agent 120

- **Job:** JOBS120.md entry "AUD-OPUS-H9-120 / AUD-SOL-H9-120", Opus lens. T4 (health consent, health data).
- **Status:** DONE 11:22 PDT 10-05. Both verdicts posted at exact heads; lane branches deleted; worktrees removed.
- **Claims:** ops/lanes120/claims/mobile-369-a2bfe2fa-opus, ops/lanes120/claims/mobile-370-c7014623-opus (kept).
- **Independence:** the Sol H9 report and notes were not read before both Opus verdicts were posted. The comment listing
  used to check heads showed the first line of Sol's two H9 verdicts (APPROVE); their bodies were not read before posting.
- **Notes/probes:** ops/aud-120/AUD-OPUS-H9-120/ (verdict-369.md, verdict-370.md, posted-*.json, specs369.txt,
  specs370.txt, probes/ with all four probe files, run logs run<id>.log).
- Times from `TZ=America/Los_Angeles date`.

## Verdicts posted
| PR | Exact head | Verdict | A/B/C | Comment | Posted |
|---|---|---|---|---|---|
| #369 H7 FIX ROUND 2 | a2bfe2fa906ff5e3b991613a6838a82456db920c | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-6000464490 | 11:20 PDT |
| #370 H8 OPENING | c7014623520baf23a697f4d646e3d80a423789c5 | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-6000483411 | 11:21 PDT |

Heads re-read via REST immediately before and after each post: unchanged. #369 base agent115/wear-split-6-retire-samsung
@ 1266038c (#364 head); #370 base = #369 branch @ a2bfe2fa. Sizes 1,270 and 1,050 changed lines (under 1,500).
PR CI: #369 run 37345688498 success; #370 run 37349317509 success (Typecheck, lint, test). Analyze absent on stacked bases.

## H1-H7 landing (Opus lens)
**Clear to land as one unit:** #359 e0f3d2a7, #360 fde1875e, #361 574b32a8, #362 261e7d4c, #363 5266d658, #364 1266038c
(all dual APPROVE at these heads; Sol #362 approve 5998888651 is conditional on this composition) and #369 a2bfe2fa
(Opus 6000464490). Main-based required checks (Analyze) must run at landing. H8 (#370) lands after H1-H7.

## #369 delta 3252ec79 -> a2bfe2fa (3 commits, fast-forward)
- Production: `src/services/health/onDeviceState.ts` only. `serialWrite` (:191-198) hands each write `current()`, a check
  on the sign-out epoch captured at call time; `recordLocalAuthorization` calls it after the session read (:229), session
  write (:233), authority read (:237), authority creation (:242); no await between the last check and the grant write (:246).
- B-369-2 (Sol) closed: a Connect held at any await before the grant write rejects `OnDeviceSessionChangedError`, writes no
  grant; a session/authority value already handed to the native module binds nothing and the chain replaces/deletes it. A
  grant write issued before sign-out lands bound to the authority the immediate revocation deletes (Android replaces on a
  failed delete), so it is void after a restart before the chain. Liveness after sign-out holds.
- Callers: connectOnDevice (`onDeviceSync.ts:252`) propagates the stop, so the sheet shows the existing "signed-in account
  changed" copy (`src/screens/client/wearables/onDeviceCopy.ts:113-121`).
- Changed existing tests drop only the old "in-flight grant reached disk" behaviour and keep the end-state assertions.

## #370 full review (10 files)
- syncWindows.ts:25 one-day look-back (was HC 5 min, HK 60 min). HC per-page loop healthConnectSyncService.ts:255-330
  (save :319, failed-resume drop :293). HK day pieces healthKitSyncService.ts:241-345 (pieceEnd :146, settle 2 h :99,
  save :273, tail :333). runSyncPasses: HC continues only on truncation; HK one pass; earlier failure keeps incomplete.
- Backend ee55f814 dedup (sha256 user|provider|metric|start|end, unique, skipDuplicates) makes same-interval re-reads safe.
- No copy change; logging adds record type, page state and error class only.

## Probes (CI lanes; all branches now deleted)
| Lane branch | Execution | Run | Result |
|---|---|---|---|
| 369-probes-1 | a2bfe2fa + 087beb7b | 37352819047 | 77 suites, 861 pass / 5 fail, the 5 by-design only; onDeviceState.opusH9 7/7 pass |
| 370-probes-1 | c7014623 + c8a33b4f | 37352809675 | 81 suites, 881 pass / 8 fail = 5 by-design + 3 HK-probe setup bugs (mine); HC opusH9 3/3, onDeviceState.opusH9 pass |
| 370-probes-2 | + ea7ce9eb (setup fix) | 37353349279 | 25/26: DST case needs TZ at process start |
| 370-probes-3 | + b08daecf (child jest TZ) | 37353998474 | HK opusH9 3/3 pass |
| 370-probes-4 | + e66aeec0 (H9-HK-4) | 37354506930 | HK opusH9 4/4 pass (H9-HK-4 DOCUMENTS C-370-3) |

By-design failures (5): `audit364.samsungRetirement` original SAMSUNG_HEALTH case; `opus119f` DOCUMENTS C-362-14 and
C-362-15; "CLOSED C-362-12" in `opus119f` and `.flipped` (fail only on `Promise.all([writing, ...])`; the write now
rejects as stopped; H9-6 is the replay at the new contract and passes).

## Follow-ups (C)
- **C-369-4** (carried) `src/services/health/onDeviceState.ts:129-139`: iOS failed Keychain delete is silent. Fix rule:
  document that the session replacement voids the grant on iOS; optionally read back and fall back to the replacement write.
- **C-369-5** (carried, outside diff) `src/services/health/onDeviceSync.ts:252`,
  `src/screens/client/wearables/onDeviceCopy.ts:129-133,207-210`: a failed local grant write is not its own step, so the
  copy says connected but history unfinished. Fix rule: own step with "could not be connected on this phone" copy.
- **Opus C-370-1** (= Sol C-370-1, = builder H8-C1; operator-ruled ticket) `syncWindows.ts:25` + backend `dedup.util.ts`:
  rewritten Health Connect records are re-read with a new interval and add a row. Fix rule: backend replace by
  (user, provider, sourceRecordId); the wire carries it (`ingestBatching.ts:104`).
- **Opus C-370-2** (refresh cost; Opus only; not Sol's C-370-2) `syncWindows.ts:23-24`,
  `healthConnectNormalizer.ts:191-205`, `ingestBatching.ts:31,43`, backend `wearables-throttle.ts:33`: each Health open
  re-posts a day of every type; a 5-second heart-rate writer is about 70 requests per refresh, over 60 per minute. Fix rule:
  in the look-back part post only records changed since the last run (`metadata.lastModifiedTime` or H8-C4 tokens); fix the
  cost note.
- **Opus C-370-3** (sleep partial; Opus only; outside diff) `healthKitNormalizer.ts:468-485`, `healthKitClient.ts:226,359`:
  a long segment spanning a piece's 36 h look-back start is not read, and the night's tail is posted as a second session
  (probe: 330 + 180 min for one night). Fix rule: post each sleep session from exactly one piece, the first in which it is
  whole (end in [piece start - 2 h, piece end - 2 h)).
- Agreed, not counted: Sol C-369-2, C-369-3, C-362-5; builder H8-C2 (= Sol C-370-2), H8-C3 (= Sol C-370-3), H8-C4.
- ID note: Sol's C-370-2/3 (settle, clock clamp) and Opus C-370-2/3 (refresh cost, sleep partial) are different findings.

## Operator decisions (recommended defaults)
1. Land H1-H7 (#359-#364, #369 @ a2bfe2fa) as one unit with main-based checks at landing. Default: yes.
2. One-day look-back and 2 h Apple Health settle: keep. Default: yes.
3. Backend replace for rewritten Health Connect records (C-370-1): follow-up ticket, ideally before the clinic Android build.
   Default: ticket.
4. Opus C-370-2 and C-370-3: tickets; C-370-3 before the clinic build if sleep totals feed coaching. Default: ticket.

## HANDOFF
- **State:** done. Opus APPROVE #369 @ a2bfe2fa (0/0/2) and #370 @ c7014623 (0/0/3). Opus has nothing open on H1-H8.
- **Clean-up:** remote branches audit/AUD-OPUS-H9-120/{369-probes-1,370-probes-1..4} deleted (0 refs left); worktrees
  /home/user/workspace/wt/AUD-OPUS-H9-120-1 and -2 removed and pruned. Probe sources kept in
  ops/aud-120/AUD-OPUS-H9-120/probes/. Claim dirs kept.
- **Next:** operator lands H1-H7, then H8; tickets for the C list above.
