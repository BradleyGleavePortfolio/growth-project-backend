MAIN REFRESH (B-BC4-122, agent 122) — growth-project-backend#726 @ ff2594db6f506b47dc50510a5c7512119e4609bc

One merge commit `ff2594db` = parents `cb5ef90a43974e17abca3715cdf8d1432d004f48` (dual-APPROVE BC3 landing tree, = audited #730 top) + main `eb2e9e038a4cc6e2b8b20fb0d37d251a91162350` (after dunning #687 merged 17:28 PDT). No other commit. Not covered by A5 rule 12 (conflict hunks), so this needs the merge-only delta by both lenses.

**Byte identity.** 26 of the 34 #726 files are byte-identical to `cb5ef90a` (all of `src/broadcasts/**`, `test/broadcasts/**`, the migration and its `down.sql`). The 8 changed files are the 6 conflict files below plus 2 clean auto-merges (`src/app.module.ts`: BroadcastsModule import + registration kept; `src/common/env-validation.ts`: FEATURE_COACH_BROADCASTS rule kept beside main's rules).

**Conflict hunks and resolutions** (all unions; nothing from either side dropped)
| # | File | Main side | #726 side | Resolution |
|---|---|---|---|---|
| 1 | `.github/fly-env-desired-state.json` env | `FEATURE_COACH_CODE_TOOLS: unset` | `FEATURE_COACH_BROADCASTS: unset` | both, main first (comma added); JSON parses |
| 2 | same file, notes | code-tools note | broadcasts note | both |
| 3 | `.github/workflows/ci.yml` community-live-tests spec list | `test/invite-codes/coach-code-tools.live.spec.ts` | `test/broadcasts/broadcasts-dispatch.live.spec.ts` | both specs run |
| 4 | `docs/runbooks/launch-flags.md` table | FEATURE_COACH_CODE_TOOLS row | FEATURE_COACH_BROADCASTS row | both rows |
| 5 | `prisma/schema.prisma` model CoachMessage | A3-MSG-CORE columns (client_message_id, reply_to_id/reply_to/replies, edited_at, deleted_at/by, pinned_at/by) + `@@unique([sender_id, client_message_id])` | relations `card CoachMessageCard?`, `broadcast_delivery CoachBroadcastDelivery?` | both (relations then columns) |
| 6 | `prisma/schema.prisma` end of file | FeaturedCoachConfig, CoachCodeRedemption, CoachlessPromptState, SchedulingJobLease | CoachBroadcast, CoachBroadcastRun, CoachBroadcastDelivery, CoachMessageCard, CoachSavedReply, CoachClientTag | all ten models (closing brace restored for CoachClientTag) |
| 7 | `src/account-deletion/account-deletion.manifest.ts` | CoachMessage deleted_by_id / pinned_by_id detach, CoachThreadState x3 del | CoachBroadcast x2, CoachBroadcastDelivery, CoachSavedReply, CoachClientTag x2 del | all rows, main first |
| 8 | `src/messaging/messaging.service.ts` `listThread` include | `reply_to` include only while FEATURE_MESSAGING_CORE_V2 is on; its test requires no `include` at all with the flag off | `card` include always | `card` while FEATURE_COACH_BROADCASTS is on, `reply_to` while v2 is on, both when both, none when both are off |

Why hunk 8 is gated: main's spec `messaging-core-v2.spec.ts` "flag OFF: the thread read is the legacy query" asserts `not.toHaveProperty('include')`, so an always-on card include fails a main test. With the broadcasts flag on (the only state in which cards can be written, every A4 route answers 503 otherwise) the thread read returns the card exactly as before, alongside main's reply preview when v2 is on. Both specs pass unmodified. No new behaviour beyond that gate; the dispatcher writes every broadcast copy with its text body, so a later flag-off shows the text without the card (kill semantics).

**Checks**
- Local (heavy.sh, one file each, at this tree): messaging-core-v2 38/38, messaging.service 26/26, erasure-manifest-coverage 7/7, manifest-fk-order 10/10, fly-env-manifest 67/67, prisma generate OK, eslint messaging.service OK. A 4-case probe of the flag matrix (not committed) passes.
- CI lane `ci/B-BC4-122-1` (full `tsc --noEmit` + test/broadcasts, messaging, account-deletion, fly-env manifest, module-graph, openapi + the probe): GREEN (Type-check step success, targeted jest success) https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394720313
- PR CI at this head: all 11 required checks green (build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests with both live specs, npm audit, CodeQL, Banned cast tokens, build-sbom, danger, Schema parity); 20 of 21 runs success, deploy-readiness-gate skipped as usual. community-live-tests: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394583207/job/112047402184

Remerge diff (how each conflict was resolved) and the resolver: ops/aud-122/B-BC4-122/ (operator workspace).

Size: 5,274 / 5 vs main (rule-11 landing of five audited pieces; no new lines except the 8 hunk unions).

READY FOR AUDIT
