**Tier:** T4 (money: paid PDF/video deliverables for package buyers; turns on the buyer Deliverables screens in store builds).
**Why:** Owner 15:03 10-06: turn on the buyer screen for purchased PDFs/videos in the 10-07 build, and make sure coaches can attach videos and files to packages robustly. On main a coach choosing PDF or Video in Manage content is asked to "Paste the asset ID", and no screen in the app can create or show one, so no coach can sell a PDF or video.
**T4 trigger scan:** money (what a buyer receives for a paid package) - yes; auth/RLS/tenancy - no change (existing coach-scoped `/v1/coach/media` routes, CoachOrOwnerGuard + SubscriptionGuard, attach still checks ownership server-side); PII - none; credentials - none (signed upload URLs come from the backend; no keys in the app); destructive data - none.
**T3 trigger scan:** build flags - `EXPO_PUBLIC_FF_DELIVERABLES` set "true" in eas.json `production`, `clinic` (both iOS and Android 10-07 builds) and `preview`; already declared in config/expected-env.json. No new flags, no new dependencies (expo-document-picker and expo-file-system are already in package.json), no lockfile change.
**Bounded T1:** 5 files, 393 additions / 4 deletions (250 source incl. eas.json 7 + form 25, 147 test).
**Canonical builder:** Claude Opus 5.5 (B-DROPS-125, agent 125).
**Acceptance evidence:** new `src/__tests__/coachMediaPicker.test.tsx` 7/7 pass locally (fails on main: the picker does not exist). Existing ContentAttachForm.test 9/9 and CoachPackageContentsScreen.test 26/26 pass. Scoped tsc and eslint on changed files clean. Full suite + typecheck + lint in this PR's CI.

## B fixed
- **B1 (money/core flow):** a coach opens a package, taps Manage content, chooses PDF or Video, and is asked to paste an asset ID that nothing in the app can produce, so a PDF or video can never be attached or sold. Fixed: the form now shows the coach's own PDF/video files (`GET /v1/coach/media?kind=`) as chips, plus "Upload a PDF" / "Upload a video" (document picker -> `POST /v1/coach/media/{pdf|video}/upload-url` -> binary PUT straight to the signed Supabase / Mux URL -> PDF confirm). A PDF is selected as soon as it is uploaded; a video shows "Processing" and becomes selectable once Mux marks it ready (only `ready` files are selectable, matching the delivery-time check in MediaAssetResolver). The paste field remains as a fallback.
- **B2 (money):** buyers of packages with PDF/video/meal-plan drops have no screen to see what they bought in store builds because `EXPO_PUBLIC_FF_DELIVERABLES` is off in eas.json. Turned on for production, clinic and preview (owner yes 15:03).

## U fixed
- Specific upload errors instead of generic ones: 50 MB PDF limit checked before upload, 503 "Uploads are unavailable right now", 400 "That file could not be accepted", 402/403 subscription, transfer failure "Check the connection and try again". Loading, error-with-retry and empty states for the file list.
- iOS document picker opens Files, not Photos: an iPhone coach sees the hint "A video in Photos: tap Share, then Save to Files, then upload it here." (no new dependency; expo-image-picker is not in package.json).

## Compatibility with today's production backend
- All routes used (`/v1/coach/media`, upload-url, confirm, package-contents attach) are already live (PR-12). Nothing here needs a backend deploy.
- `byte_size` is deliberately never sent: the backend column is BigInt and Nest's JSON response cannot serialise a non-null BigInt, so sending it would make the coach's file list and the confirm response fail (backend latent bug, noted for the operator).
- Buyer opening a PDF/video needs backend #798 (merged, not yet deployed). Until it deploys, a buyer tap shows the existing graceful "File not available" message from mobile #434.

## Overlap
- No open mobile PR touches eas.json, ContentAttachForm.tsx, the contents/ folder or a coach-media client. m#264 touches featureFlags.ts; this PR does not.
