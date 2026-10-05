FIX ROUND 1 (OPENING) (B-HC12-121, agent 121) — growth-project-mobile#378 @ 2ea649a1bd9d4ba8f61c9c84f57e100df8b31fb7

Scope: C-370-2 (refresh burst over 60/min, Retry-After, resumable) and C-370-3 (one sleep session per night; probe 330 + 180 counts once). Design in the PR body. 1,055 changed lines (389 non-test source).

## Probes (new, 17 cases)
| Probe | main b79ca594 (before) | this head (after) |
|---|---|---|
| HC12-PACE-1 60 requests, at most 50 per 60 s | fail (60 at once) | pass |
| HC12-PACE-2 Retry-After HTTP date / bounds | fail (waited 60 s, not 20 s; no parser) | pass |
| HC12-PACE-3 shared hold across runs, stop while waiting (4) | fail (no pacer) | pass |
| HC12-HC-1 day of 5-second heart rate: 72 requests -> 4 | fail (72) | pass |
| HC12-HC-2 changed / no mtime / edge posted; first import and resumed page post all | fail / pass (guard) | pass |
| HC12-HC-3 330 + 180 one night counts once; late session after posted night | fail (both counted) | pass |
| HC12-HC-4 429 stops with page kept, resume after hold | fail (no pacer) | pass |
| HC12-HK-1 Opus H9-HK-4 at fixed contract (330 + 180 once) | fail (tail posted) | pass |
| HC12-HK-2 nights once across pieces and runs / night near run end waits | fail (06-03 re-posted) / pass (guard) | pass |
| HC12-HK-3 run pacer on every post | fail | pass |

Evidence: local heavy.sh, one file at a time (logs in ops/aud-121/B-HC12-121/). Before lane run 37368878548 and PR CI are queued (GitHub Actions runner incident); lane cancelled at wrap-up, PR CI left to run.

## Replay of prior lens probes on this head (local)
- Opus H9: healthConnectSyncService.opusH9 3/3, onDeviceState.opusH9 7/7, healthKitSyncService.opusH9 2/4 (H9-HK-2 DST child and H9-HK-3 pass). By design: H9-HK-4 documented the C-370-3 double count (now counts once = HC12-HK-1); H9-HK-1 expected the 06-03 night, which ended before the run window, to be posted again from the first piece's look-back; the earlier run posts it now.
- Sol H9: healthConnectSyncService.sol120h9 3/3, healthKitSyncService.sol120h9 3/3, authActions.interruptedAuthority.sol120h9 15/15.
- Existing specs: ingestBatching 12/12, healthKitSyncService 17/17, .h8 7/7, healthKitNormalizer 30/30, healthConnectSyncService 32/32, .h8 6/6, healthConnectIngestApi 4/4, onDeviceSync 36/36, useWearableConnections.disconnect 10/10. tsc 0 errors; eslint on changed files clean.

## Money list self-check
- Retry/redelivery: a 429 is rejected before the handler, so the retried batch is not a second insert; dedup_key keeps re-posts idempotent.
- Concurrency: one process-wide pacer, serial promise queue, no locks.
- Terminal states: a run stopped by repeated 429s keeps saved pages/pieces and leaves the hold for the next run; a session stop while waiting sends nothing.
- Completeness (fail closed): the look-back skips only records the last completed read provably posted; first imports, resumed pages, records without a modification time and records changed after the last read are always posted.
- Currency/minor units: none.
- Copy: no copy changed; the 429 copy "Wait a minute, then tap Try again." stays true (wait bounded to 60 s).

## Follow-ups (C)
- C (edge, deferred to 10k clients) `healthkit/healthKitNormalizer.ts:445-448`: late watch data that changes a posted night's bounds gives a new key and a second row. Fix rule: backend replace (backend #732) or a posted-night memory.
- C (edge, deferred to 10k clients) `healthConnect/lookBack.ts:111`: a night split across two pages of one read is not grouped. Fix rule: group across the read.
- C (edge, deferred to 10k clients) `healthConnect/lookBack.ts:17,61`: a record modified within 15 min before the last read is posted again (idempotent). Fix rule: none needed.
- C (edge, deferred to 10k clients) `ingestBatching.ts:311`: pacer state is in memory; an app restart resets the window (the backend 429 and retries still bound it).
- C-370-1 rewritten records: ticket backend #732.

READY FOR AUDIT (PR CI queued by the runner incident; local evidence above).
