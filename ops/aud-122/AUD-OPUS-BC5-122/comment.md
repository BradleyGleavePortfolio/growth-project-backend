AUDIT Claude Opus 5.5 — growth-project-backend#726 @ ff2594db6f506b47dc50510a5c7512119e4609bc — VERDICT: APPROVE

A/B/C = 0/0/2 (agent 122, lens AUD-OPUS-BC5-122; merge-only delta, RUTHLESS SCOPE)

**Scope and evidence**
- Head ff2594db = one merge commit, parents cb5ef90a (audited top) + eb2e9e03 (main). `cb5ef90a^{tree}` = `22166591^{tree}` = 22166591835f (BC3 dual-APPROVED #730 top), so the broadcasts side rests on that approval.
- Re-ran the merge locally with `git merge-tree --write-tree cb5ef90a eb2e9e03`: exactly 6 conflict files. `git diff <conflicted tree 38bd6cd3> ff2594db` touches only those 6 files (+46/-47). Nothing else was edited by hand. app.module.ts and env-validation.ts merged cleanly.
- Composition check per file. `git diff eb2e9e03 ff2594db` has 0 deleted lines (only the comma line in the flags file), so nothing from main was dropped. `git diff cb5ef90a ff2594db` deletes only lines main itself removed (FEATURE_WEARABLES_INGEST_POST/GOOGLE_CLIENT_IDS notes, InviteCode/Dunning model edits), so nothing from broadcasts was dropped.

**The 8 hunks**
1-2. `.github/fly-env-desired-state.json:42-43, 105-106`: both env entries ("unset") and both notes are kept, and the JSON parses.
3. `.github/workflows/ci.yml:476-477` (community-live-tests): both specs are listed. Both passed at this head (`PASS test/invite-codes/coach-code-tools.live.spec.ts` and `PASS test/broadcasts/broadcasts-dispatch.live.spec.ts`, 13/13 suites, 128 tests): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394583207/job/112047402184
4. `docs/runbooks/launch-flags.md:131-132`: both rows, both off.
5. `prisma/schema.prisma:1344-1369` CoachMessage: has the broadcasts `card` and `broadcast_delivery` relations plus main's A3-MSG-CORE columns and the `@@unique`.
6. `prisma/schema.prisma:8346-8361`: the A4 models end with a closing brace, then main's A1-COACHLESS models follow intact. Schema parity, forward-migrations, reversibility and build-and-test are green, so the schema composes.
7. `src/account-deletion/account-deletion.manifest.ts:92-112`: has main's deleted_by_id/pinned_by_id detaches and its 3 CoachThreadState deletes, plus all 6 A4 rows. None were dropped. Coverage and fk-order specs ran in build-and-test (green).
8. `src/messaging/messaging.service.ts:634-683` listThread: card is included only when `coachBroadcastsEnabled()`, reply_to only when `isMessagingCoreV2Enabled()`, both when both are on, and `{}` when both are off. The v2 branch's reply_to select is byte-identical to main's. `serializeThreadPage` keeps `card` through `...rest` when v2 is on and returns rows raw when v2 is off.

**Story (verified by reading the four branches):** at launch both flags are off, so a client opening a thread gets exactly main's query and payload. With broadcasts on, a coach's broadcast copy comes back with its `card` in the thread, with or without v2.

**Required checks at ff2594db:** 20/21 success, deploy-readiness-gate skipped (expected). PR is MERGEABLE.

**Cs**
- C-726-1 (outside launch config: both flags on): delete-for-everyone (`src/messaging/message-actions.service.ts:172-195`) nulls body and voice but leaves the `coach_message_cards` row, so with both flags on a tombstoned card message still returns its `card` in listThread (`messaging.service.ts:648-659`). Fix rule: null `card` in `serializeMessage` when `deleted_at` is set, or delete the card row in the delete transaction. Do this before both flags are on together. Verify with a v2+broadcasts spec: delete a card message, and the thread row should show `card: null`.
- C-726-2: no committed spec pins the card include with FEATURE_COACH_BROADCASTS on (the builder's 4-combo probe was not committed). Missing test for working code, deferred.

No probes were run (the hunks are fully decidable by reading, and CI plus lane run 37394720313 are green). Evidence reused: BC3 dual APPROVE of #730 top 22166591 (tree-identical to cb5ef90a).
