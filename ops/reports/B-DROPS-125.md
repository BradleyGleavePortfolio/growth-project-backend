# B-DROPS-125 — sell PDFs and videos on day 1 (Claude Opus 5.5, auditor-builder, T4 money)

Started 15:03 PDT 10-06 (hard stop 15:40). Code read on current main: backend a233a020 (includes b#798), mobile d16d5c1 (includes m#434).
Read: _COMMON_125, own JOBS125 entry, B-DELIV-125.md, AUDIT-18-125.md, /tmp/flysecrets.txt (names only).

**Coach-flow verdict: was NOT robust on main (a coach cannot attach a PDF or video at all); FIXED in mobile #437 (pending CI/audit).**

## Step table (coach flow end to end, flags as on 10-07)
| # | Step | State on main | Evidence / after m#437 |
|---|------|---------------|------------------------|
| 1 | Coach: Settings -> Packages -> package -> "Manage content" | works, no mobile flag gates it | CoachPackageEditScreen.tsx:972-990 -> CoachPackageContents (CoachNavigator.tsx:579-583) |
| 2 | Add content -> choose PDF / Video | works (options always shown) | ContentAttachForm.tsx:55-62 |
| 3 | Pick or upload the PDF / video | **BROKEN/MISSING**: only a "Paste the asset ID" text field (ContentAttachForm.tsx:368-386 on main); no mobile code calls `/v1/coach/media` at all, so no coach can create or find an id | **fixed in m#437**: MediaAssetPicker lists ready files, uploads new ones |
| 4 | Backend upload: PDF | works | POST /v1/coach/media/pdf/upload-url -> Supabase signed upload URL, bucket `coach-media` (SUPABASE_MEDIA_BUCKET unset -> default; SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY present); POST :id/pdf/confirm -> ready. Bucket listed as existing in docs/privacy/vendor-deletion-and-backups.md:54 (not verified live: Supabase is off limits) |
| 5 | Backend upload: video | works | POST /v1/coach/media/video/upload-url -> Mux direct upload, signed playback; Mux webhook /v1/webhooks/coach-media/mux drives uploading -> processing -> ready (coach-media-mux-webhook.controller.ts:219-227). MUX_TOKEN_ID/SECRET, MUX_WEBHOOK_SECRET, MUX_SIGNING_KEY_ID/PRIVATE all present on Fly |
| 6 | Attach to package + schedule drop | works | package-contents.service.ts:1178-1194 checks coach owns a non-archived asset of that kind; cadence options in form |
| 7 | Client buys -> drop delivered | works | MediaAssetResolver refuses non-ready assets (media-asset.resolver.ts:104-108) and creates ClientAssetGrant (:132). Picker only lets coaches select `ready` files, so no attach of a still-processing video via the UI |
| 8 | Buyer sees the drop | **OFF in store builds** (EXPO_PUBLIC_FF_DELIVERABLES unset in eas.json) | **fixed in m#437**: "true" in production, clinic, preview |
| 9 | Buyer opens it | works after backend deploy | b#798 GET /v1/client/media/:id/signed-url (merged, NOT deployed; prod is ec12a4b3) + m#434 openPurchasedMedia (WebBrowser). Before the deploy: graceful "File not available" |

## B list
- B1 (money/core, FIXED m#437): a coach opens Manage content, picks PDF or Video, and is asked to paste an asset ID that nothing in the app produces, so a PDF or video can never be attached or sold.
- B2 (money, FIXED m#437): a buyer of a package with PDF/video/meal-plan drops has no screen showing what was bought in the store build because EXPO_PUBLIC_FF_DELIVERABLES is off in eas.json.

## U list
- U2 (FIXED m#437): the iOS document picker opens Files, not Photos, so an iPhone coach tapping Upload a video sees no camera-roll videos; a hint now says to Share -> Save to Files first (expo-image-picker is not a dependency; a Photos picker is a post-launch follow-up).
- U1 (FIXED m#437): upload failures get specific copy (50 MB PDF cap checked before upload, 503 unavailable, 400 file not accepted, 402/403 subscription, transfer failure) and the file list has loading / error-with-retry / empty states.

## C one-liners
- C (latent backend, not reachable from the app after m#437): CoachMediaAsset.byte_size is BigInt and there is no BigInt JSON serializer, so `GET /v1/coach/media`, `GET :id`, confirm and patch 500 once any row has a non-null byte_size. m#437 never sends byte_size. Smallest fix: map `byte_size` to `Number(...)` in CoachMediaController responses (src/coach-media/coach-media.controller.ts:63-145).
- C (edge, deferred to 10k clients): a video attached by pasting an id while still processing would fail grant at delivery; the picker prevents this.

## Covered by open PRs
- None. Open mobile PRs: only m#264 touches featureFlags.ts (not touched here). Open backend PRs: b#593 touches meal-plan resolver only; nothing touches coach-media.

## PRs opened
- mobile #437 `agent125/b-drops-125-flag` head 1c22b557d1a06772e69394f18d1f8abffdecce69 (2 commits; second adds the iPhone video hint), 397 lines (393+/4-; 250 src incl. eas.json 7, 147 test). Title NOT marked DO NOT MERGE (coach flow judged robust with this PR). CI all green at head: CI run 37539699089 (Typecheck, lint, test), CodeQL 37539699242; first head 0c82b817 also green (run 37539274172). READY comment https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437#issuecomment-6026570642
- No backend PR (no backend change needed for the flow).
- Local evidence: coachMediaPicker.test.tsx 7/7 pass (fails on main: module missing); ContentAttachForm.test 9/9, CoachPackageContentsScreen.test 26/26 pass; scoped tsc (/tmp/tsconfig.bdrops125.json) and eslint on the changed files clean.

## Not fixed (needs operator / owner)
1. Deploy ordering: buyer PDF/video open needs b#798 deployed (merged on main, prod ec12a4b3 lacks it). Default: include in the next backend deploy before/with the 10-07 store build.
2. Verify (read-only, owner/operator): Supabase Storage bucket `coach-media` exists and is private; Mux dashboard webhook points at https://api.trygrowthproject.com/api/v1/webhooks/coach-media/mux. Without the webhook, uploaded videos stay "Processing" forever (PDFs unaffected).
3. OWNER DECISION (App Store 3.1.1 risk): iOS keeps package checkout under 3.1.3(d) as real-time 1:1 coaching (purchaseSurfaces.ts). A package that contains ONLY PDFs/videos and no 1:1 coaching is digital content Apple expects through IAP. Recommended default: coaches attach PDFs/videos as part of 1:1 coaching packages only; do not sell standalone PDF/video packages on iOS at launch.
4. Device smoke test on the TestFlight build: upload a small PDF and a short video from a coach account; the binary PUT path (expo-file-system/legacy uploadAsync to the signed Supabase / Mux URL) is unit-tested with mocks only.

## HANDOFF
- Done 15:26 PDT. Mobile PR #437 open at head 1c22b557d1a06772e69394f18d1f8abffdecce69, CI green, READY FOR AUDIT posted (texts in ops/reports/B-DROPS-125/). Route the T4 dual-lens audit through the operator; it is independent of other open PRs.
- Worktrees verified clean (0 dirty, 0 unpushed) and retained under the workspace-retention instruction: /home/user/workspace/wt/B-DROPS-125-mobile, /home/user/workspace/wt/B-DROPS-125-backend (read only, no changes; local branch agent125/b-drops-125-coach never pushed). Temp scoped tsconfig at /tmp/tsconfig.bdrops125.json. No heavy locks held.
- No ci/* branches. Nothing merged, deployed or touched in production.
