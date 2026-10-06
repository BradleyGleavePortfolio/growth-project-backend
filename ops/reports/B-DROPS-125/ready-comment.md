FIX ROUND 1 (OPENING) (B-DROPS-125, agent 125) — growth-project-mobile#437 @ 1c22b557d1a06772e69394f18d1f8abffdecce69 — READY FOR AUDIT

- CI green at this head: CI run 37539699089 (Typecheck, lint, test: success), CodeQL Advanced 37539699242 (success). The first head 0c82b817 also passed full typecheck/lint/test (run 37539274172); the second commit only adds the iPhone "Save to Files" hint (3 lines).
- 397 changed lines (393+/4-): eas.json (EXPO_PUBLIC_FF_DELIVERABLES "true" in production, clinic, preview), coachMediaApi.ts, MediaAssetPicker.tsx, ContentAttachForm.tsx wiring, coachMediaPicker.test.tsx (7 tests; fails on main because the picker does not exist).
- Fixes B1 (a coach cannot attach a PDF or video: the form asked for an asset ID nothing in the app produces) and B2 (buyer deliverables screens off in store builds).
- Works against current production backend (all `/v1/coach/media` routes are live). Buyer opening a PDF/video still needs backend #798 deployed; before that, the existing graceful "File not available" shows.
- Operator/owner items: verify Supabase bucket `coach-media` (private) and the Mux webhook URL; App Store 3.1.1 decision on packages that are only PDFs/videos (recommended default: attach them only inside 1:1 coaching packages on iOS). Report: ops/reports/B-DROPS-125.md.
