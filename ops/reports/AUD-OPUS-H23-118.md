# AUD-OPUS-H23-118 — Claude Opus 5.5 lens, mobile #360 (H2) and #361 (H3)

Started 10:05 PDT 10-04 (from `date`). Claims: lanes118/claims/mobile-360-fde1875e-opus, mobile-361-574b32a8-opus.
Notes/logs: ops/aud-118/AUD-OPUS-H23-118/ (c360.json, c361.json, run-37179701360.log, run-37179972056.log, verdict-*.md).
Read-only worktree: wt/AUD-OPUS-H23-118-361 (detached at 574b32a8). No probe branch, no CI dispatch, no heavy local work.
Disk 69 percent at start.

## Facts verified 10:05-10:40 PDT
- #360 head fde1875edc1bd5d14ac8fda4f2e68ee8b7c5ebf5, base agent115/wear-split-1-ingest-foundation = #359 e0f3d2a7 (unchanged).
  24 files +1,844/-968 = 2,812. CLEAN. Typecheck, lint, test SUCCESS run 37179701360 (449 suites / 6,355 tests).
- #361 head 574b32a8ab9f2c36986c160de257340fa71cfe52, base = #360 branch fde1875. 10 files +1,782/-11 = 1,793. CLEAN.
  Typecheck, lint, test SUCCESS run 37179972056 (451 suites / 6,418 tests). Analyze runs only on main-based PRs.
- Mobile main 7fdb629a (#315). `git merge-tree` 574b32a8 + main = clean; no stack file overlaps main's changes since 367e6c48.

## Prior findings (this lens)
- #360 @ 4a508d8b: Opus APPROVE 0/0/2 (C-360-1 late samples, C-360-2 all-or-nothing import; ruled follow-up before the
  clinic Android build). Operator item 5 (closed error class in the HC read catch) = same seam as Sol B-360-1.
- #361: no Opus verdict ever posted on the split piece. Code byte-identical to #317 d0407b62 (Opus APPROVE chain
  58c2d53f..82137c31, merge-only APPROVE d0407b62): all 10 blobs equal (verified with git rev-parse per path).

## #360 delta 4a508d8b..fde1875 (4 files, +169/-2), read in full
- Catch is fence-first (`throwIfStopped` synchronous), closed class from a Map of the 8 library read codes
  (verified against react-native-health-connect 3.5.3 ExceptionsUtils.kt), never copies message/name/code.
- Grant read fence check; HealthKit permission catch returns 'stopped' when the attempt ended.
- Old sheet on this tree calls `connectOnDeviceProvider(target)` with ALWAYS_CURRENT: no behaviour change at this tree.
- No other logger/Sentry/analytics call in the piece carries text: only counts, record type, booleans, closed class.

## #361 (full piece read)
- Inert: no app importer of onDeviceSync, onDeviceCopy, disconnectCopy, DisconnectConfirmDialog; wearableAiInsights default false.
  Sign-out sweep + stopOnDeviceHealthWork arrive with the wiring in #362 (both at 439937c9).
- Restack 85b2439b -> 574b32a8 is a pure merge: merge-tree(85b2439b, fde1875) = cec8f30a = head tree; delta patch-id =
  #360 fix patch-id (6a54d1b7).

## Findings drafted
- C-360-3 post-await attempt/fence checks not uniform (onDeviceConnect.ts:114-115, 163-164; healthConnectSyncService.ts:206,213).
- C-361-1 DisconnectConfirmDialog backdrop Pressable groups the dialog for VoiceOver (Pressable accessible defaults true,
  RN 0.85 Pressable.js:252): Disconnect unreachable on iOS VoiceOver. Same pattern on main ConnectProviderSheet.tsx:203-210 and
  MessageActionSheet.tsx:92-93. Device-only proof.
- C-361-2 (outside diff) reportUnexpected (src/lib/consultation/report.ts:17-22) sends the reference as extra `request_id`,
  not the searchable `reference` tag (sentry.ts:149-152, B-326-4); onDeviceCopy/disconnectCopy promise "mention the reference".

## Verdicts (posted 10:17 PDT 10-04; heads and checks re-read immediately before posting)
- #360 @ fde1875edc1bd5d14ac8fda4f2e68ee8b7c5ebf5: APPROVE, A/B/C = 0/0/3 (C-360-1, C-360-2 carried; C-360-3 new).
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5982484127
  Body source: ops/aud-118/AUD-OPUS-H23-118/verdict-360.md
- #361 @ 574b32a8ab9f2c36986c160de257340fa71cfe52: APPROVE, A/B/C = 0/0/2 (C-361-1, C-361-2 outside diff).
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982484292
  Body source: ops/aud-118/AUD-OPUS-H23-118/verdict-361.md
- Sol posted APPROVE on both heads at 10:12 PDT (5982441210, 5982441393). I saw only their first lines, during the pre-post
  head re-read and after both bodies were drafted. Neither body was read or copied.

## Follow-ups (C)
- C-360-1 (carried, ruled follow-up before the clinic Android build): healthConnectSyncService.ts:65,152-157 (5 min overlap),
  healthKitSyncService.ts:82,166-176 (60 min). Fix: widen to a look-back (e.g. 36 h) or HC changes token; settle delay for
  cumulative buckets. Test: record ending before T-overlap, written after T, is read next run.
- C-360-2 (carried): healthKitSyncService.ts:192-265 progress saved only after all batches. Fix: day-sized windows, save per
  window. Test: failure on batch k keeps progress of earlier windows.
- C-360-3 (new): onDeviceConnect.ts:114-115,163-164 resolve paths lack isCurrent(); healthConnectSyncService.ts:206,213 setup
  rejections after a stop propagate as non-stop errors. Fix: `if (!isCurrent()) return 'stopped'` after both awaits; catch around
  setup awaits runs fence.throwIfStopped() before rethrow. Test: stop during each await -> stopped / OnDeviceSessionChangedError.
- C-361-1 (device gate, cross-cutting): DisconnectConfirmDialog.tsx:44-50 backdrop Pressable (accessible default true,
  RN Pressable.js:252) wraps the card; VoiceOver cannot reach Disconnect/title/body. Same on main ConnectProviderSheet.tsx:203-210,
  MessageActionSheet.tsx:92-93. Fix: backdrop as absoluteFill sibling with accessible={false}; card a View with
  accessibilityViewIsModal; onAccessibilityEscape. Test: structure test + VoiceOver/TalkBack in the device pass.
- C-361-2 (outside diff, main): src/lib/consultation/report.ts:17-22 sends requestId as extra `request_id`, not the searchable
  `reference` tag (sentry.ts:149-152, B-326-4), so client-minted references quoted to support cannot be found. Fix: pass
  `reference: info.requestId` to captureError. Test: captureError context carries reference.

## Operator decisions (recommended defaults)
1. C-360-1/2/3: one T4 follow-up PR on main after #359-#364 land, before the clinic Android build (default), plus a late-write
   case in the device pass.
2. C-361-1: a small cross-cutting a11y PR (three components) before the clinic build, and VoiceOver/TalkBack steps in the
   device pass (default). Not folded into the frozen stack: fixing only the dialog would cost a 4-piece restack and leave the
   same defect in main's Connect sheet.
3. C-361-2: one-line fix on main in any copy/telemetry PR (default: ticket now).
4. Outside these pieces: useWearableConnections.ts:120 raw error log is in #362 (439937c9), for the #362 lenses.
5. Land as one (rule 11), then FEATURE_WEARABLES_INGEST_POST in the C-317-6 order.

## HANDOFF
- mobile #360 @ fde1875edc1bd5d14ac8fda4f2e68ee8b7c5ebf5: Opus APPROVE 0/0/3 (5982484127); Sol APPROVE (5982441210).
  Typecheck, lint, test green (run 37179701360); Analyze runs when the stack lands on main. Next: operator lands the stack.
- mobile #361 @ 574b32a8ab9f2c36986c160de257340fa71cfe52: Opus APPROVE 0/0/2 (5982484292); Sol APPROVE (5982441393).
  Typecheck, lint, test green (run 37179972056). Next: same.
- If either head moves, a fresh Opus lens runs a delta from these heads using this report and the verdict bodies.
- Cleanup done: worktree wt/AUD-OPUS-H23-118-361 removed; no ci/ or audit/ branch was created. Claims stay as records.
