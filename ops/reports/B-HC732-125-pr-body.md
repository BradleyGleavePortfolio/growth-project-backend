Tier: T4
Why: health-data write path; a rewritten Health Connect record is stored twice today and inflates the client's sleep (and other) totals.
T4 trigger scan: health data (WearableSample rows are deleted and re-inserted inside the ingest transaction). No auth, RLS, money, credentials or PII-exposure change.
T3 trigger scan: none (no schema, migration, flag, dependency or mobile change).
Bounded T1: NO (T4 data path).
Canonical builder: Claude Opus 5.5 (B-HC732-125, agent 125)
Parent owner: operator agent 125
Acceptance evidence: `test/wearables/ingestion-source-record-replace.spec.ts` (7 tests, in-memory WearableSample table with unique dedup_key, createMany skipDuplicates and a deleteMany that evaluates the real where shape). 3 of the 7 fail on main (480 -> 450 replace, other-records isolation, one delete per request), all 7 pass on this head. PR CI runs the full suite and tsc.
Promotion triggers: any change to the identity key, to the null-source-id path, or a migration.

Fixes #732

## B fixed

- **B-VERIFY-732 (health data corruption):** an Android client whose sleep app corrects last night's session (22:00-06:00 becomes 22:30-06:00) sees 930 minutes of sleep instead of 450, because the corrected record posts again with the same source record id, gets a new interval hash and is inserted next to the old row.

## What changed

`src/wearables/ingestion/ingestion.service.ts`
- New exported helper `buildSourceRecordReplaceWhere(samples)`: groups the incoming samples by identity `(user_id, provider, metric, source_record_id)` with a non-empty source id, takes the time span each identity covers, and returns ONE `OR` filter.
- Inside the existing transaction, before `createMany`: one `wearableSample.deleteMany({ where })` (only when at least one sample has a source id), then the unchanged `createMany(skipDuplicates)` inserts the complete incoming set. Series samples are grouped first, so a heart-rate record is replaced as a whole and keeps its full incoming series.
- Null / absent source ids: no delete, interval-hash dedup exactly as before. `computeDedupKey` unchanged.

**One deliberate narrowing of the routed fix (please check):** the delete is bounded to stored rows of that identity that overlap, or lie inside, the span of the incoming samples. Reason: the phone splits a sync into requests of at most 250 samples (`MAX_SAMPLES_PER_REQUEST`, mobile `src/services/health/ingestBatching.ts:31`), so on any day with more than 250 heart-rate points one heart-rate record straddles two consecutive requests. An unbounded identity delete would make the second request wipe the first request's samples of that record (heart-rate data loss on an ordinary sync). With the span bound, a corrected interval record always overlaps its old row and is replaced; the earlier half of a split series lies outside the later request's span and is kept. Rows that only touch the span edge are kept (strict overlap). Covered by the "split across two requests" test.

`src/wearables/ingestion/ingestion.service.spec.ts`: adds the `wearableSample.deleteMany` mock (3 lines) so the colocated spec matches the new call. This file is outside the jest roots, so CI does not run it; the regression lives in `test/wearables/`.

## Tests (`test/wearables/ingestion-source-record-replace.spec.ts`)
- 480 -> 450: one row, total 450.
- Unchanged re-post of the same record (3x): one row.
- Same-id heart-rate series 60 then 61 samples: 61 rows; one delete statement per request.
- Heart-rate record split 250 + 50 across two requests: 300 rows; re-syncing the split stays 300.
- Other record ids, other metrics and other users with the same id are untouched.
- Null source id: no delete; same interval stays one row, a new interval is a new row (today's behaviour).
- Two different record ids with the same interval: one row by dedup_key (today's behaviour).

## Scope notes
- No migration (`source_record_id` and `@@index([provider, source_record_id])` already exist), no mobile change, no flag, no dependency, no lockfile.
- Response shape `{ inserted, skipped }` unchanged; a re-post of an unchanged record with a source id now reports `inserted: 1` (row replaced) instead of `skipped: 1`. Mobile only sums these for logging.
- Applies to every provider that sends a source record id (Health Connect, HealthKit UUIDs, cloud connectors); for them a re-sent record with an updated value now replaces the stale value instead of being skipped.
- C (edge, deferred to 10k clients): a record rewritten to a completely non-overlapping interval, or a series trimmed at its tail, keeps the old non-overlapping rows; two concurrent ingests of the same record.
- No open PR touches `src/wearables/ingestion/` (b#799 touches `src/wearables/connections/` only).
