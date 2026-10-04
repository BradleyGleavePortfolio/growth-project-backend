## Tier
- **Tier:** T4
- **Why:** Changes how the GDPR data export (personal data of the requester) picks the latest export request and how the archive reads every table. Privacy / PII boundary, so T4 by the max-tier rule.
- **T4 trigger scan:** PII (the export archive contents and which export a user is shown and can download). No auth, RLS, money, migration, credential or CI gate change.
- **T3 trigger scan:** none (no shared primitive, contract, schema, migration, env or dependency change; one service file plus two spec files).
- **Bounded T1:** NO (PII).
- **Canonical builder:** Claude Opus 5.5 (job B-CIQ-117, operator agent 117).
- **Parent owner:** operator agent 117.
- **Acceptance evidence:** failing-before CI-lane run (main's service + the new specs), the same specs green on this head, and all required checks green.
- **Promotion triggers:** none beyond T4. Re-grade if a later change adds a migration (for example a monotonic sequence column) or changes the one-active-export index.

## Fix round table
| Round | Head | Change |
|---|---|---|
| 0 | `ecf8da57` | Initial PR |

## Problem (F-EXPORT-TIE)
1. **Latest request had no tiebreaker.** `getLatestStatus`, `createDownloadLink` and `requestExport` read with `orderBy: { created_at: 'desc' }` (main `data-export.service.ts:319, 399, 464`). `created_at` is `TIMESTAMP(3)` (millisecond precision), so two rows can share it, and Postgres returns ties in any order. Main CI run [37177734569 attempt 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177734569/job/111363785481) failed `test/data-export-storage.spec.ts` "a failed retirement write answers a retryable 503; the retry retires the row and a replacement works": the replacement was stamped in the same millisecond as the retired row, `createDownloadLink` (line 472) read the retired FAILED row back and answered 410 FILE_MISSING for a READY export. In production the same order also fails after a database clock step: a new request stamped before the old row is never the "latest", so the app shows FAILED, the download link answers 410, and `requestExport` answers RATE_LIMITED for the READY export the user cannot reach.
2. **Archive pages had no order at all.** `_streamAll` (every table without `shape.orderBy`: weight logs, food entries, workouts, check-ins, audit log entries and more) and `_streamCoachMessages` paged with `skip`/`take` over a query with no `ORDER BY`. A database may return each OFFSET page in a different order (the plan can change with the offset), so the archive of a user with more than 500 rows in a table could repeat some rows and miss others. That is a silently incomplete GDPR export.

## Change (3 files)
1. `src/data-export/data-export.service.ts`
   - `_findLatestRequest(userId)`: the active row (PENDING / RUNNING / READY) when one exists, else the newest row by `created_at desc, id desc`. Used by `getLatestStatus` and `createDownloadLink`, so the status screen and the download link always describe the same row. `requestExport` reads its active rows with the same total order.
   - Why the active row is the latest request without a monotonic column: no monotonic column exists (`id` is a random UUID). A request row is only created when the user has no active row (`requestExport` reaps or supersedes every active row first; the partial unique index `data_export_request_one_active_per_user` rejects a second one), and no path writes FAILED or EXPIRED back to an active status. So the one active row is always the newest request, even when its `created_at` equals or precedes an older row's. With no active row every request is terminal, and `id desc` only makes an equal-millisecond tie stable (both rows are non-downloadable and offer the same next action). A sequence column was considered and not added: it needs a migration on a production table to decide what the active-row rule already decides from a database-enforced invariant (operator decision; default: no migration).
   - `_streamAll` / `_streamCoachMessages`: keyset pages on the primary key (`id > last id`, `orderBy: [{ id: 'asc' }]`, 500 rows). Every exported model has an `id` primary key (checked against `schema.prisma`). A row inserted or deleted during the export cannot shift a later page. The chronological sections (`created_recipes`, `roman_sessions`, `roman_messages`, `ai_processing_consent_events`) are sorted by `created_at, id` once all pages are read, so their archive order is unchanged. A full page whose last row has no string id (or the same id as the page before) fails the export with the table name instead of looping or writing a partial archive. Coach-message redaction still runs per page.
2. `test/data-export-storage.spec.ts`: the fake database now stamps request rows with a clock that always moves forward (at least 1 ms per row), applies the service's `orderBy`, and returns rows the order leaves tied oldest first (the order a database may pick). New specs: a replacement in the same millisecond as the retired row (ids handed out newest-lowest, so `id desc` alone cannot pass), a replacement stamped 2 s before the retired row, and two terminal rows in the same millisecond read three times.
3. `test/data-export-archive-inventory.spec.ts`: the in-memory store supports `AND` and `id > last`, and can return unordered OFFSET pages in another order. New specs: 1,234 weight logs and 1,100 coach messages (one third from the coach, redacted) are exported exactly once each; 1,001 consent events stay oldest first across pages; a store that ignores the keyset filter fails the export with "Data export paging stopped on weightLog".

## Failing-before / passing-after
| Run | Head | Result |
|---|---|---|
| [CI lane 37180174622](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180174622/job/111370978491) | `b9b71b21` (main `b644198b` + new specs, service unchanged) | RED as intended: 5 failed / 78 passed. Same-millisecond replacement: the status read returns the retired row. Clock step: expected `...000002`, received `...000001`. Two terminal rows: the older row is returned. Paging: 734 of 1,234 weight logs exported. Paging guard: the export resolved instead of failing. |
| build-and-test on this PR | `ecf8da57` | filled in when green |

Local targeted run at `ecf8da57`: `data-export-storage`, `data-export-archive-inventory`, `data-export.service`, `data-export-archive-cleanup`, `account-deletion/optional-tables-export-fence`, `data-export-controller-roles` specs: 6 suites, 133 tests passed.

## Not changed
- No schema, migration, env or dependency change. No copy change. Logs carry the table name only.
- `drainArchiveCleanups` orders its batch by `created_at asc` without a tiebreaker; that is a nightly queue where order inside a millisecond does not change any outcome, so it is left as is.
