# Plan A — Raw code citations (read-only evidence)

All paths relative to the mobile repo unless prefixed `[backend]`.
Backend worktree inspected: `growth-project-backend-b8746bcc-1ff92ec0`.

## Checkout wiring (mobile)

- `src/api/packagesApi.ts:48-51` — checkout return scheme + success/cancel deep-link URLs:
  - `PACKAGE_CHECKOUT_RETURN_SCHEME = 'com.growthproject.app'`
  - `PACKAGE_CHECKOUT_SUCCESS_URL = 'com.growthproject.app://checkout/success?session_id={CHECKOUT_SESSION_ID}'`
  - `PACKAGE_CHECKOUT_CANCEL_URL = 'com.growthproject.app://checkout/cancel'`
- `src/api/packagesApi.ts:543-562` — `publicPackagesApi.createCheckoutSession(packageId, {successUrl, cancelUrl})` → `POST /v1/checkout/sessions` `{ package_id, success_url, cancel_url }`, returns `{ url, sessionId, ... }`.
- `src/api/packagesApi.ts:278-286` — `CheckoutSessionResponse { url?, sessionId?, ... }`.
- `src/screens/client/BrandedCheckoutWebViewScreen.tsx:69-81` — route params `{ checkoutUrl, packageName?, returnScheme? }`.
- `BrandedCheckoutWebViewScreen.tsx:97-118` — `CHECKOUT_ALLOWED_HOSTS` origin allowlist.
- `BrandedCheckoutWebViewScreen.tsx:157-180` — `parseReturnDeepLink()` exact-match for `<scheme>://checkout/success|cancel`.
- `BrandedCheckoutWebViewScreen.tsx:222-239` — on success/cancel → `navigation.navigate('CheckoutReturn', { outcome, session_id })`.

## Search slice (mobile)

- `src/api/communitySearchApi.ts:40-46` — `SEARCH_KINDS = ['post','classroom_lesson','voice_note_transcript','event']`.
- `communitySearchApi.ts:50-61` — `SearchResultRowSchema` is `.strict()`; fields `id, kind, targetId, cohortId, authorId, excerpt, createdAt`. **Adding `unlock_cta` requires editing this strict schema.**
- `communitySearchApi.ts:63-72` — `SearchResponseSchema.strict()`.

## Open-guard UX (mobile) — the surface being replaced

- `src/screens/community/CommunityFindScreen.tsx:80-100` — `open(result)` switch routes each kind to its detail screen (no gating today).
- `CommunityFindScreen.tsx:131-145` — current "Search is not available right now." flag-off notice (defense-in-depth).
- Per spec, the new luxury CTA page intercepts `open()` for gated hits instead of navigating.

## Doctrine

- `docs/QUIET_LUXURY_DOCTRINE.md` — full ruleset.
- `src/__tests__/quietLuxuryDoctrine.test.ts:72-180` — 11 enforced invariants (scanned over `src/screens`, `src/components`).
- `src/theme/tokens.ts:142-226` — typography tokens (`display, h1..h4, body, bodyMd, bodySmall, caption, eyebrow, micro`).
- `tokens.ts:241-250` — `radius` (`sm:0, md:2, lg:4, xl:4, '2xl':4, pill:999`).
- `tokens.ts:371-418` — light/dark semantic tokens incl. `accent`, `accentText`, `textOnAccent`, `disabledBg`, contrast notes.

## Content↔package primitives (mobile)

- `src/api/packageContentsApi.ts:33-39` — `ContentAssetType = workout_program | workout_plan | meal_plan | pdf | video | auto_message`. **No `classroom_lesson` / `event`.**
- `packageContentsApi.ts:50-64` — `PackageContent { id, package_id, asset_type, asset_id, ... }` (the existing forward map package→content).
- `packageContentsApi.ts:135-186` — `coachPackageContentsApi` CRUD against `/v1/coach/packages/:id/contents`.
- `src/api/communityClassroomApi.ts:74-80+` — `ClassroomPost` has `id, workspace_id, cohort_id, coach_id, title, ...` — **no `package_id`**.

## Backend schema (Prisma)

- `[backend] prisma/schema.prisma:5036-5052` — `CoachPackageContent` with `asset_type`, `asset_id`, and crucially `@@index([asset_type, asset_id])` (reverse-lookup index already exists).
- `[backend] schema.prisma:3208-3290` — `CoachPackage { id, coach_id, name, amount_cents, currency, billing_type, interval, is_active, archived_at, published_at, is_sellable, ... }`.
- `[backend] ClientPurchase` model — `entitlement_active: Boolean`, `access_expires_at`, `status`, `package_id`, `client_user_id`; indexes `@@index([client_user_id, status])`, `@@index([entitlement_active, access_expires_at])`. **Entitlement source of truth.**
- `[backend] schema.prisma:6029-6055` — `CommunityClassroomPost` — no package linkage; `@db.Uuid` ids.
- `[backend] schema.prisma:5887-5916` — `CommunityEvent` — no package linkage; `@db.Uuid` ids.

## Backend search handler (injection point)

- `[backend] src/community/search/community-search.service.ts:55-115` — `search(user, workspaceId, query)`; membership gate, cohort scoping, then `pageRows.map((r) => ({ id, kind, targetId: r.target_id, cohortId, authorId, excerpt, ... }))`. **This map is where `getUnlockCTA(hit, user)` injects.**
- `[backend] src/community/search/community-search.dto.ts:57-68` — `SearchResultRow` Zod (`kind, targetId, excerpt, ...`).

## Cache pattern the spec calls "LRU+Redis pub/sub"

- `[backend] src/community/ai-triage/triage-cache.service.ts:1-45` — the actual shipped pattern is an **in-process insertion-ordered LRU Map** (R69, ZERO schema diff), 5-min TTL, `freshnessKey` content fingerprint for auto-invalidation, `MAX_CACHE_ENTRIES=1000`, opportunistic TTL sweep. **No Redis is provisioned in this repo today** (DECISIONS.md D4 confirms Redis is conditional). The unlock-CTA cache should mirror this LRU+freshnessKey shape, not assume Redis pub/sub.

## Decisions / rules

- `wave-1-5/DECISIONS.md` D1 — open-guard + per-hit `unlock_cta` (NOT exclude); base schema `{ kind, target_id?, label }`.
- `wave-1-5/DECISIONS.md` D6 — no per-client coach overrides in v1 (separate R82).
- `context/tgp-agent-context/rules/R82_TRACKING_ISSUE_DISCIPLINE.md` — every deferred item → GitHub tracking issue with 6 sections + owner (default Bradley Gleave).
