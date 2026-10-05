Ticket only (job B-HC12-121, agent 121); not built. Lens finding C-370-1 (Opus H9 = Sol H9 = builder H8-C1), operator-ruled ticket. Health data (T4).

## Problem
Health Connect lets an app rewrite a record it wrote earlier (same record id, new start or end, for example a sleep session corrected in the morning). The phone re-reads the rewritten record and posts it again with the new interval. The backend dedup key is `sha256(user_id | provider | metric | start_iso | end_iso)` (`src/wearables/ingestion/dedup.util.ts:9,51`) and the insert is `createMany({ skipDuplicates: true })` (`src/wearables/ingestion/ingestion.service.ts:126-128`), so the new interval is a new row and the old row stays: the value counts twice in totals.

The wire already carries the provider record id: mobile `src/services/health/ingestBatching.ts` sets `sourceRecordId` (main b79ca594 line 104), the DTO accepts it (`src/wearables/samples/dto/ingest-samples.dto.ts:50`) and the column exists with an index (`prisma/schema.prisma` `WearableSample.source_record_id`, `@@index([provider, source_record_id])`), but ingest never uses it.

## Fix rule
On ingest, a sample with a non-null `sourceRecordId` replaces the stored row(s) with the same (user_id, provider, metric, source_record_id) in the same transaction as the insert: delete or update the old row, then insert the new one (dedup_key from the new interval). Samples without `sourceRecordId` keep today's dedup_key behaviour. Health Connect heart-rate series records hold many samples per record id: replace the whole set of rows for that record id in one statement, not row by row.

## Tests
- Post record X as 22:00-06:00 (480), then X as 22:30-06:00 (450): one row, 450.
- Re-post X unchanged: still one row (idempotent).
- Two different record ids with the same interval: today's behaviour (one row by dedup_key).
- A heart-rate series record X with 60 samples, then X with 61: 61 rows for X.

## Interaction with mobile #378
Mobile #378 posts only records changed since the last read on a refresh and posts one sleep session per night ("first posted wins" across runs). With this replace, a rewritten record that is posted again replaces its earlier row instead of adding one, and the phone can later prefer the more detailed sleep session without double counting.
