AUDIT Claude Opus 5.5 — growth-project-backend#698 @ ecf8da57e7d3a8636189e028e54e8dd23399c825 — VERDICT: APPROVE

A/B/C = 0/0/3

Lens: AUD-OPUS-FU1-118 (agent 118). Tier T4: the change is a privacy boundary. It decides how complete the GDPR export archive is, and which export a user is shown and can download. This is this lens's first verdict on the PR, and no earlier evidence was reused. This lens did not read the other lens's verdict. The head was re-read right before posting.

### Scope
- **Diff against main b644198b:** 3 files, +394/-73 (467 lines). Every line was read.
  - `src/data-export/data-export.service.ts` (205)
  - `test/data-export-storage.spec.ts` (150)
  - `test/data-export-archive-inventory.spec.ts` (112)
- **Commits:** b9b71b21 (specs), ecf8da57 (fix).

### Latest request (F-EXPORT-TIE)
- **Root cause (confirmed):** main read the latest request with `orderBy: { created_at: 'desc' }` only (main `:319`, `:399`, `:464`). `created_at` has millisecond precision, so two rows can share it, and Postgres returns tied rows in any order.
- **Fix:** `_findLatestRequest` (`:813-823`) returns the active row (PENDING / RUNNING / READY). If there is none, it returns the newest row by `created_at desc, id desc`.
- **Why the active row is always the newest request.** Every writer of `data_export_request.status` was traced:
  - **Creates:** `requestExport` (`:393`) and the legacy `AccountService.requestDataExport` (`src/users/account.service.ts:57`) both insert an active row. The partial unique index `data_export_request_one_active_per_user` (migration 20260525170000, `WHERE status IN ('PENDING','RUNNING','READY')`) therefore guarantees that no other active row exists at that moment, so every older row is terminal.
  - **Writes to an active status:**
    - `_runExport` sets RUNNING (`:1009`, unconditional, as the first await after the create).
    - `_runExport` sets READY (`:1027`), only when the row is still RUNNING.
    - `account.service.ts:88` sets READY on the row it has just created.
  - **One edge:** the only terminal-to-active write possible is that RUNNING write racing a reap, which needs a stale-run window of at least 5 minutes (see C-698-2). If that ever happens while another row is active, the write hits P2002.
  - **Conclusion:** the active row is the newest request. When there is no active row, the status screen and the download link both pick the same terminal row.
- **Consistent reads:** `getLatestStatus`, `createDownloadLink` and the `requestExport` rate limit now read the same row. The same-millisecond spec asserts `DATA_EXPORT_RATE_LIMITED` after the replacement export is READY.
- **Failing-before (verified):** [lane 37180174622](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180174622/job/111370978491) ran at 41f616fc, which is b9b71b21 plus only the lane files. Result: 5 failed / 78 passed.
  - The failures are the 3 tie specs and 2 of the 3 paging specs.
  - `ids: 'descending'` makes `id desc` alone pick the retired row, so the spec proves the active-row rule rather than passing on id order by luck.

### Keyset paging
- **The cursor always exists:**
  - All 30 models passed to `_streamAll` / `_readAllById` have `id String @id` (uuid, or cuid for the Roman models) in `schema.prisma`.
  - All three select constants (`RECIPE_EXPORT_SELECT`, `ROMAN_SESSION_EXPORT_SELECT`, `ROMAN_MESSAGE_EXPORT_SELECT`) include `id` and `created_at`, so the cursor and the in-memory chronological sort always have their columns.
- **Pages are disjoint and complete:** `id > $1` and `ORDER BY id` use the same column collation, which is deterministic (ties broken by bytes). No OFFSET is left.
- **Filters are kept:** `{ AND: [where, { id: { gt } }] }` keeps the owner filter and the Roman erased-chat relation filter on every later page.
- **The guard fails closed:**
  - The guard error carries only the model name, so no PII reaches the log.
  - `_runExport` then marks the row FAILED, so a partial archive never becomes READY.
- **Chronological sections keep their order:** they are sorted after reading by `created_at`, then `id`. Ids are lowercase hex or cuid, so the JS order equals the database order within ties. The README's "oldest first" for `created_recipes` and `roman_messages` still holds.
- **No other change:** no copy, schema, migration, env or dependency change.

### Probe (independent fake store with byte-order comparison and call recording)
`test/aud-opus-fu1-698-probe.spec.ts` on `audit/AUD-OPUS-FU1-118/698-keyset` (PR head plus the probe only). [Run 37218701936](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218701936/job/111484438260) is GREEN: 96/96 passed, including both builder specs.
- **Weight logs at 0, 1, 499, 500, 501, 1,000, 1,001 and 1,500 rows,** with another user's rows interleaved by id:
  - Every row is exported exactly once, and no foreign row appears.
  - The table is read floor(n/500)+1 times.
  - Every read has `orderBy [{id:'asc'}]`, `take 500` and no `skip`.
  - On page k>0, `where` is `{AND:[{user_id},{id:{gt: last id of page k-1}}]}`.
- **1,300 Roman messages spread across a live, an erased and a foreign session:**
  - Only the live session's messages are exported, each once.
  - They come out oldest first, with id as the tiebreaker.
  - The select (without `subject_context_json`) is sent on every page.
- **500, 1,000 and 1,001 coach messages:** third-party content is redacted on every page, and foreign messages are absent.
- **Query shape:** `_findLatestRequest` asks for the active row first, then for the total order.

### CI
All 11 required checks are green at this head. Size: 467 lines.

### C findings (optional)
- **C-698-1 (`:1275-1310` `_streamAll`, `:1350-1372` `_streamCoachMessages`): sections without `shape.orderBy` now come out in random UUID order.**
  - These sections are now in primary-key order: `weight_logs`, `food_entries`, `check_ins`, `coach_messages`, `audit_log_entries_about_user` and others. With random UUIDs, that order is random.
  - Before, the order was unspecified but in practice close to insertion order. The archive is now complete, but harder for a person to read.
  - Fix rule: after reading, sort by the model's time column, then `id`:
    - `date`, `logged_at` for weightLog, loggedFoodEntry and checkIn
    - `sent_at ?? created_at` for coachMessage
    - `created_at` for auditLog, coachNudge and mealPlan
    - `added_at` for listItem, `saved_at` for savedRecipe, `completed_at` for lessonCompletion, `start_time` for fastingWindow
    - Keep id order only for models that have no time column.
  - How to verify: the inventory spec asserts oldest first for `weight_logs` and `coach_messages` across two or more pages.
- **C-698-2 (`:1009-1012`, outside this diff, but the latest-request argument depends on it): the active-row invariant rests on timing.**
  - `_runExport`'s RUNNING write is an unconditional `update`. So "no terminal row returns to active" holds because of timing (the create is followed at once by RUNNING, while a reap needs at least 5 minutes), not because the database enforces it.
  - Fix rule: use `updateMany({ where: { id, status: PENDING }, data: { status: RUNNING } })`, and stop without building when the count is 0.
  - How to verify: reap a PENDING row, then run it. The row must stay FAILED, and no archive may be written.
- **C-698-3 (`:1385-1392`, outside this diff): the try/catch in `_streamAuditLogs` is dead code.**
  - It wraps `return this._streamAll(...)` without `await`, so the catch never runs. A failed audit-log read therefore fails the whole export, which is the correct fail-closed result.
  - Fix rule: delete the try/catch. Do not turn it into `return await` plus `[]`, because that would silently drop audit entries from a GDPR export.

APPROVE: zero A and zero B. The three C items are optional and can go in one small follow-up after this PR lands.

Lens notes and logs: ops/aud-118/AUD-OPUS-FU1-118/ (p698head.log, lane698before.log).
