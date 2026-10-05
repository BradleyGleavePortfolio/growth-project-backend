Health Connect follow-up before the clinic Android build (job B-HC12-121, agent 121). Mobile, base main b79ca594 (H1-H8 merged). T4: health data.

## C-370-2: refresh burst over the backend's 60 per minute
Each Health open re-read a day of every type behind its progress (H8 late data) and posted all of it: about 70 ingest requests for a watch that writes heart rate every 5 seconds (backend `WEARABLES_INGEST_PER_MIN` = 60).
- `healthConnect/lookBack.ts` + `healthConnectSyncService.ts`: on a fresh read behind saved progress, a record is skipped when the last completed read of its type already posted it: `metadata.lastModifiedTime` at least 15 minutes before the saved progress and the record wholly inside that read (start at or after this read's start, end before the progress). Resumed pages, first imports, records without a modification time and records changed after the last read are always posted.
- `ingestBatching.ts`: every request goes through a pacer (at most 50 per 60 s). `onDeviceSync.ts` passes one process-wide pacer to every Connect, resume and refresh run. A 429 holds every request on the pacer for its Retry-After (seconds or HTTP date, bounded by the 60 s ingest bucket; the backend sends 3600 for every throttler but the ingest route has only the per-user 60 s bucket, and the 429 copy says "Wait a minute"), retries the batch up to 3 attempts, and the last 429 of a stopped run still holds the next run. Progress stays saved per page (Health Connect) and per day piece (Apple Health), so a stopped run resumes after the last saved one.
- `syncWindows.ts`: cost note corrected.

## C-370-3: a night counted twice
- Apple Health (`healthKitSyncService.ts`, `healthKitNormalizer.ts`): a sleep session is posted only from the import piece in which it ends, end in [piece start - 2 h, piece end - 2 h). Consecutive pieces and consecutive runs give back-to-back ranges, so each night is posted once and whole; a tail cut by a piece's 36 h sleep look-back is not posted as a second night (Opus H9-HK-4: 330 + 180 now counts once).
- Health Connect (`lookBack.ts`): overlapping SleepSession records form one night. If the last read already posted one of them, the night posts nothing more; otherwise the session with the most stages, then the longest, is posted.

## Tests (new, 17 cases)
- `src/services/health/__tests__/ingestPacing.hc12.test.ts` (pacer, Retry-After, shared hold)
- `src/services/health/healthConnect/__tests__/healthConnectSyncService.hc12.test.ts` (look-back filter, sleep nights, 429 resume)
- `src/services/health/healthkit/__tests__/healthKitSyncService.hc12.test.ts` (sleep end rule across pieces and runs, run pacer)

Size: 1,055 changed lines (389 non-test source), under 1,500.

Not in scope (ticket): backend replace for rewritten Health Connect records (C-370-1).
