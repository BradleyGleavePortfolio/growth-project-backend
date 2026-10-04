# B-CIQ-117 — CI quality follow-ups (builder, Claude Opus 5.5, operator agent 117)

Started 2026-10-04 05:19 UTC (10-03 22:19 PDT). Base: backend main `b644198b90bb9ab1dc62a78794e12cf09f8ace7c` (#694 and #695 merged).
Worktrees: /home/user/workspace/wt/B-CIQ-117-1 (PR 1), /home/user/workspace/wt/B-CIQ-117-2 (PR 2). Notes: ops/aud-117/B-CIQ-117/, ops/aud-117/ciq-*.

## PR 1 — backend #698 (F-EXPORT-TIE)
- Branch `b-ciq-117/export-order-tiebreak`, head `ecf8da57e7d3a8636189e028e54e8dd23399c825` (tests `b9b71b21`, fix `ecf8da57`). Tier T4 (PII export).
- Root cause (confirmed from main run 37177734569 attempt 1, job 111363785481, log ops/aud-117/ciq-main-37177734569-bt.log): `createDownloadLink`
  (data-export.service.ts:472) read the retired FAILED row because the replacement had the same created_at millisecond and the
  order was `created_at desc` only; the fake DB stamped `new Date()` and sorted ties in insertion order.
- Fix: `_findLatestRequest` = active row (PENDING/RUNNING/READY; at most one per user by the partial unique index; always the newest
  request) else `created_at desc, id desc`. Used by getLatestStatus + createDownloadLink; requestExport's active read uses the same
  total order. Decision: no monotonic column exists (id = random UUID); no migration added (operator decision, default no).
- Same-class finding fixed in the same file: `_streamAll` / `_streamCoachMessages` paged with skip/take and NO ORDER BY (archive of a
  user with >500 rows in a table could repeat/miss rows). Now keyset on id (`id > last`, orderBy id asc), chronological sections
  sorted in memory after reading, page-repeat guard fails the export with the table name.
- Fake clock: data-export-storage.spec.ts fakeDb stamps with an advancing clock by default (>= 1 ms per row), honours orderBy, ties
  oldest first; options `clock` and `ids: 'descending'` for the forced-tie specs.
- Failing-before: CI lane run 37180174622 (job 111370978491) at 41f616fc = b9b71b21 + lane commit: 5 failed / 78 passed (3 tie specs,
  paging 734 of 1,234 rows, paging guard resolved).
- Local after: 6 data-export suites, 133 tests pass.

## PR 2 — backend #699 (C-695-1, C-695-2)
- Branch `b-ciq-117/sbom-fail-closed`, head `40ce17578ca8b70d80a5ff8d22237ca1239062bd` (spec `d3fe41b3`, fix `40ce1757`). Tier T4 (CI gate).
- Fix: lockfile must be valid JSON with a `packages` object and >= 1 production entry; SBOM components must be a list; every
  substitution checked with `|| fail "<reason>"`, no `|| true`; has_name = bash pattern match (no fd, no fork).
- Failing-before: CI lane run 37180305649 at 1ac6918f = d3fe41b3 + lane commit (status below). Local before: 7 failed / 3 passed.
- Local after: fail-closed + determinism + delivery-artifact + release-evidence-gate: 4 suites, 174 tests pass.

## CI status
(updated below)

## HANDOFF
(updated at the end)
