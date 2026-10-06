Tier: T2
Why: Repairs exercise browsing/details and adapts lesson content/progress to the existing backend contract without changing access or payment semantics.
T4 trigger scan: none in this diff; no auth, tenancy, signed-URL minting, billing, or destructive writes changed.
T3 trigger scan: none; uses existing endpoints, native playback, lesson completion API, and local cache.
Bounded T1: NO — requires tracing two existing read contracts and their screen states.
Canonical builder: GPT-6.1 Sol
Parent owner: operator agent 125
Acceptance evidence: exerciseCatalog.test.tsx and educationLaunch.test.tsx cover real backend field shapes, current-server requests, legacy exercise IDs, denied-access preservation, media failure fallback, retry, server completion progress, and refused-save copy.
Promotion triggers: any change to catalog/lesson visibility or paid-media access must be routed to T4.

## Launch defects
- B1: An ordinary client opens Exercise Library and its `limit=20` string fails the current server's integer validation, leaving the library unavailable; omit the optional limit and use the unchanged backend default of 20.
- U1: A client taps ordinary category/muscle/bodyweight filters and gets no seeded exercises; use the actual curated seed values.
- U2: A client opens a coach's lesson and sees no description/media, or loses the visible completion count on a new installation; map `description`, `video_url`, `article_url`, `order_index`, and scoped `completions`.
- U3: A client encounters a failed library/detail/lesson read and sees technical errors, a false empty state, or no retry; show specific copy and retry controls.
- U4: A client taps exercise info during an assigned workout and its legacy exercise ID 404s in the new catalog; on catalog 404 only, use the existing legacy detail route, retaining demonstrations/instructions and a real media-error fallback.

## Compatibility and boundaries
- Works against the current production backend; no backend deployment or feature flag is required for these changes.
- Does not alter ActiveWorkoutScreen, which overlaps open #406.
- Open #264/#265 are flag-off custom-exercise authoring; no shared changed files.
- Signed media entitlement/tenant fixes and delivered PDF/video access are excluded and escalated in the operator report.
- No dependency, lockfile, schema, migration, release/build, or production changes.
