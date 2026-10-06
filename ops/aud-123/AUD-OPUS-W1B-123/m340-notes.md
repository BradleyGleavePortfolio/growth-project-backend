AUDIT Claude Opus 5.5 — growth-project-mobile#340 @ 62794564f340020b7b562911e8a531f065612576 — VERDICT: APPROVE

Lens AUD-OPUS-W1B-123 (agent 123). Full review of the diff vs main: 6 files, +645 −55 = 700 lines, under the 1,500 cap. Main has not touched any of these 6 files since the base `1fc46ff8`.

**A 0 / B 0 / C 1**

What I checked (money, data and access paths first)
- **Amounts and scope.** The CSV body is the server's, passed through unchanged; the client only adds a UTF-8 BOM. `coachMoneyApi.exportCsv` is unchanged main code. On backend main, `GET /v1/coach/money/export.csv` is `@Roles('coach','owner')` and scoped to `req.user.id` (no coach_id argument). It formats amounts with `centsToDecimal`, and the `net_to_you` column sums to the summary net. So the file holds only that coach's own sales, refunds, chargebacks and fees, in currency units, as the money screen shows them.
- **The file path** (`src/lib/money/csvFile.ts`). The file is written to `cache/money-exports/<safe name>.csv`, with the folder emptied first. It goes to `Sharing.shareAsync` with `text/csv` and the `public.comma-separated-values-text` UTI, so Mail attaches it and Files saves it. The `File`/`Directory`/`Paths` API is the default export of expo-file-system 56.0.8 (checked in the package's `build/index.d.ts`), and Typecheck is green. On Android, both providers' paths include `cache-path`, so sharing a cache file works.
- **Text fallback.** When `isAvailableAsync()` is false or throws, the CSV goes to `Share.share` as text, and `money-export-csv-text` says so plainly. That copy is true, has no first person and no exclamation marks.
- **B-340-1 (Sol RC 10-03) is fixed.** `isCurrent` (mounted plus export epoch) is checked before the availability wait and again after it. The write is synchronous, so nothing waits before the share. A stale export resolves `canceled` silently, and a sign-out (`authEvents 'logout'`) ends the export and frees the button. The only waits are availability and the share sheet. In production, `'login'` is never emitted as a named event, so normal exports are never cancelled by it.
- **Errors.** `CsvFileError` write/share failures get specific copy with the codes `MONEY_CSV_WRITE_FAILED` and `MONEY_CSV_SHARE_FAILED`. Server errors still go through `describeError`.
- **Main's money screen is unchanged** apart from the export path. The only other change in `MoneyScreen.tsx` is the NetBlock note, re-wrapped with identical words. Main's tests in `money.test.tsx` are kept (spot-checked: payout cents, cadence label, window/currency errors, breakdown signs, stale Business, charge route). The only test replaced is the old "CSV is a text share, never called a file" test, which this change deliberately makes untrue.
- **Dependency.** `expo-file-system ~56.0.8` is already in main's lock as a dependency of `expo` 56.0.12. Its config plugin is optional: it only adds storage permissions and iOS document flags, none of which this needs. `expo-sharing` is already in app.json plugins. The 10-07 store build needs nothing more.
- Required checks at this head: Typecheck/lint/test, CodeQL, and Analyze (actions, javascript-typescript) are all SUCCESS.

Story holds: a coach taps "Export CSV for taxes" and gets a real .csv in the share sheet (save to Files or attach to email). The amounts are right and cover only her own sales. Where file sharing is unavailable, the CSV goes as text and the screen says so.

Cs
- C-340-1 (edge, deferred to 10k clients): each export empties `money-exports` first, so a share target still reading the previous file could lose it.
