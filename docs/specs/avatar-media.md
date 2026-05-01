# Spec — Profile pictures / avatar media

**Roadmap row:** #32.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/32-avatar-media.md`](../architecture/handoff/32-avatar-media.md).
**Cross-references:** PR #117 (RFC §8 — Supabase Storage prefix
and mime allow-list), PR #121 spec
[`public-coach-profile.md`](./public-coach-profile.md) (#27 —
already references a coach avatar URL),
[`leaderboards.md`](./leaderboards.md) (#31 — consumer of the
display avatar), PR #120 platform-readiness lanes 03 (RBAC),
04 (data lifecycle), 06 (observability).

---

## 1. Status

Net-new feature. Spec #27 references a coach avatar URL field,
but no upload pipeline, no derive-thumbnail job, no scrub
posture, and no validation surface exists in `main`. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #32."

## 2. WHY

The platform needs *user-identity media* for three downstream
consumers:

- **Public coach profile (#27).** A coach without a face is not
  a marketable coach. The current placeholder UX is a
  monogram derived from the coach's display name; this spec
  replaces the placeholder with a real upload pipeline.
- **Leaderboards (#31).** Leaderboard entries need an avatar
  per participant. Without #32, every entry renders a generic
  silhouette.
- **Coach-client messaging (#36).** Inline avatars in a
  conversation thread are the cheapest way to make a chat surface
  feel personal.

Avatar media is a small feature with big surface area: every
consumer reads from one resolver, so the resolver must be
correct on day one. Mistakes here (mime confusion, scrub gaps,
storage-key leaks, image-bomb crashes) propagate.

## 3. WHEN

Trigger conditions:

1. PR #117 RFC §8 (Supabase Storage prefix and mime allow-list)
   is reviewed against this spec to confirm the prefix
   convention is reused.
2. The image-derivation library decision is made: spec defaults
   to `sharp` (existing transitive dep through `next-image` not
   present here, so a direct add) for thumbnailing.
3. Founder signs off on the avatar size ceiling (default 5 MB
   pre-derive; 200 KB post-derive).

## 4. WHERE

- **New module:** `src/avatars/` —
  `avatars.module.ts`,
  `avatars.controller.ts`,
  `avatars.service.ts`,
  `derive.service.ts`,
  `storage.service.ts`.
- **New tables / columns:** *Two options described in §10; both
  acceptable. The spec defaults to §10.A.*
  - **§10.A (preferred):** add columns to `User`:
    `avatar_storage_key`, `avatar_derived_keys` (Json),
    `avatar_updated_at`.
  - **§10.B (alternative):** new `UserAvatar` row with
    one-to-one to `User`. Used only if the founder wants
    per-avatar versioning history beyond `audit-and-gdpr.md`.
- **New routes (paths under `/api/`):**
  - `POST /me/avatar` (multipart upload, returns the new
    avatar's resolver URLs)
  - `DELETE /me/avatar` (reset to default)
  - `GET /users/:id/avatar?size=sm|md|lg` (resolver; redirects
    to the derived storage URL)
  - OWNER moderation:
    - `DELETE /admin/users/:id/avatar` (audit-tagged)
- **Reads:** `User`, `UserAvatar` (if §10.B).
- **Writes (Supabase Storage):** prefix
  `avatars/{user_id}/{generation}/<size>.{ext}`. The
  `generation` field forces cache-busting on each upload.
- **Storage bucket:** existing `avatars` bucket (or new
  `tgp-avatars` — operator decision; spec defaults to
  reusing the existing public-readable bucket if one exists,
  otherwise creating a new bucket with public read + service-role
  write).

## 5. WHO

- **Sign-off:** founder for the size ceiling and the default
  avatar policy; backend lead for the derive-job contract and
  the resolver URL shape; security/legal for the scrub posture
  on account delete.
- **On the hook:** backend platform.
- **Downstream consumers:** specs #27, #31, #36; the existing
  coach-console BFF (`src/v1/`); the mobile API
  (`src/coach/`).

## 6. WHAT

**Already exists:**

- Supabase Storage prefix conventions (PR #117 §8).
- The merged `audit` module — used for the moderation route.
- The `User` row — recipient of the new columns (§10.A).

**New surface:**

- Multipart upload, validation, derive-thumbnail.
- Three derived sizes (`sm` 64×64, `md` 192×192, `lg`
  512×512).
- Resolver URL convention.
- Default avatar fallback (deterministic monogram SVG, server-
  rendered, `Cache-Control: public, max-age=86400`).
- GDPR scrub: account delete removes every derived key from
  Storage.
- Moderation route.

**Non-goals:**

- Avatar cropping UI (mobile / web client owns this).
- Animated avatars / GIF uploads (parked for a later wave).
- Avatar history (the `generation` counter exists but only the
  current generation is served; history is stored only if §10.B
  is chosen).
- Per-coach branded default avatars (future tiering work,
  #37).

## 7. HOW

Smallest first PR: the migration + the resolver URL with
default-avatar fallback (no upload yet). This unblocks #27,
#31, #36 to start integrating against a stable contract before
the upload path lands.

Rollout phases:

1. **Phase 1 — resolver + default.** Migration, resolver route,
   default monogram SVG. No upload.
2. **Phase 2 — upload + derive.** `POST /me/avatar`,
   multipart, mime + size validation, derive job (synchronous),
   storage write, row update.
3. **Phase 3 — moderation.** OWNER delete route, audit log.
4. **Phase 4 — async derive.** Move derive to a background
   queue (BullMQ on existing `REDIS_URL`) when measured
   p95 derive duration > 1 s.

Feature flag: `AVATARS_ENABLED` (`off` | `read_only` | `on`).
`read_only` exposes the resolver and the default-avatar fallback
but rejects uploads. Default `off` until Phase 2; flip to
`read_only` for the duration between Phase 1 and Phase 2 so
downstream consumers can resolve URLs against the placeholder.

## 8. Data model sketch

### §10.A (preferred) — three columns on `User`

```prisma
// Additions to existing model User { ... }
avatar_storage_key   String?
avatar_derived_keys  Json?        // { sm, md, lg, generation }
avatar_updated_at    DateTime?
```

The `avatar_derived_keys` field stores
`{ "sm": "...", "md": "...", "lg": "...", "generation": 7 }`.
The `generation` is monotonic per user; every upload increments
it. The resolver always reads the current row, so cache busting
is "free" — the URL contains the generation.

### §10.B (alternative) — `UserAvatar` row

```prisma
model UserAvatar {
  id                  String     @id @default(uuid())
  user_id             String     @unique
  generation          Int        @default(1)
  storage_key_raw     String
  storage_key_sm      String
  storage_key_md      String
  storage_key_lg      String
  uploaded_at         DateTime   @default(now())

  user                User       @relation(fields: [user_id], references: [id], onDelete: Cascade)
}
```

This shape costs an extra join on every read but makes the
schema explicit (no `Json` blob) and leaves room for an
`avatar_history` table later. Spec defaults to §10.A;
operator chooses at PR-1.

## 9. API sketch

### Upload

`POST /api/me/avatar`

Headers:
- `Content-Type: multipart/form-data`
- `Idempotency-Key: <uuid>` (optional but recommended)

Body: one file part `avatar` containing the source image.

Validation:
- Size ≤ 5 MB.
- Mime ∈ {`image/png`, `image/jpeg`, `image/webp`}.
- Magic-byte check against the declared mime (mismatch → 400,
  not 415, to avoid leaking mime-confusion attacks).
- Pixel dimensions ≤ 6000 × 6000 (image-bomb defense).
- Decoded byte budget ≤ 200 MB (image-bomb defense; computed
  before decode begins).

Response (200):
```json
{
  "user_id": "...",
  "avatar_updated_at": "2026-06-01T10:00:00Z",
  "urls": {
    "sm": "https://.../avatars/<user_id>/7/sm.webp",
    "md": "...",
    "lg": "..."
  }
}
```

Errors:
- `400` — validation failure (size, mime, dimensions, magic-byte).
- `413` — body too large at the proxy layer.
- `503` — derive job failed; row is not updated; client may retry.

### Resolver

`GET /api/users/:id/avatar?size=md`

Returns `302` redirect to the derived URL when the user has an
avatar; returns `200 image/svg+xml` with the default monogram
when no avatar is set.

`Cache-Control: public, max-age=300, stale-while-revalidate=86400`.

### Moderation

`DELETE /api/admin/users/:id/avatar`

Effect: writes an `AuditLog` entry (`action='avatar_taken_down'`),
deletes the storage keys, clears the row columns. The default
monogram resumes service.

## 10. Rollout / feature flags

- **Env var:** `AVATARS_ENABLED` (`off` | `read_only` | `on`).
  Default `off` until Phase 1 ships; `read_only` for Phase 1;
  `on` after Phase 2.
- **Storage bucket env vars:** `SUPABASE_AVATAR_BUCKET`
  (defaults to `avatars`), validated as `optional` in
  `env-validation.ts`. Required when `AVATARS_ENABLED != 'off'`.
- **Fan-out order.** Backend (resolver) → mobile (read) →
  console (read) → mobile (upload) → console (upload).

## 11. RBAC and privacy

- **Reads.** The resolver is auth'd by default. A separate
  `GET /public/coach/:slug/avatar` (defined in #27, not here)
  exposes only public-coach avatars to unauthenticated readers.
- **Upload.** Self-only; no `POST /admin/users/:id/avatar`
  exists by design (the OWNER admin can only delete).
- **Storage authz.** The upload writes via the service role to
  a per-user prefix; the bucket is **not** public-write. Read
  is public by URL but the URLs are unguessable
  (`uuid + monotonic generation`).
- **GDPR.** A `DataExportRequest` includes the raw avatar
  storage key (current generation only). A user-deletion
  event:
  - Hard-deletes every storage key under
    `avatars/{user_id}/`.
  - Clears the row columns.
  - Writes an `AuditLog` entry.

  The audit log entry for the delete records *that* the avatar
  was scrubbed; it does **not** include the storage URL.

## 12. Tests

- **Unit:**
  - Magic-byte validator: every legal mime + every illegal one.
  - Image-bomb defense: decoded byte budget rejects a 100×100
    PNG that decompresses to 1 GB (synthetic).
  - Generation monotonicity.
- **Integration:**
  - Upload → derive → resolver round-trip on a real Postgres +
    real Supabase Storage staging.
  - GDPR delete sweeps the prefix.
- **Smoke:**
  - `GET /users/:id/avatar?size=md` returns 200 default monogram
    when no avatar.
  - `GET /users/:id/avatar?size=md` redirects to a 200 derived
    URL when avatar is set.
- **Manual eval:** none.

## 13. Risks

- **Image bombs.** Mitigated by the decoded byte budget and the
  pixel-dimension cap.
- **Mime confusion.** Mitigated by magic-byte checks; do not
  trust the upload's `Content-Type`.
- **Storage URL leak via audit log.** Mitigated by the §11
  policy: audit log records the scrub event but never the URL.
- **Cache poisoning via the resolver.** The resolver returns a
  302 with the generation in the URL; downstream caches see a
  fresh URL on every avatar change.
- **Default-avatar churn.** A change to the monogram SVG
  template must increment a `DEFAULT_AVATAR_VERSION` constant so
  caches invalidate.

## 14. Dependencies

- **Roadmap rows.** None upstream; #27, #31, #36 are
  downstream consumers.
- **Existing modules.** `src/audit/`, `src/auth/`,
  `src/common/throttling/`.
- **External services.** Supabase Storage. `sharp` (new
  dependency).
- **Decisions that must close.**
  - §10.A vs §10.B (column-on-`User` vs new `UserAvatar`).
  - Synchronous vs queued derive (default sync; switch to
    queued when p95 > 1 s).
  - Bucket reuse vs new bucket.

## 15. Acceptance criteria

1. Migration adds the columns (or new table) idempotently.
2. Resolver returns the default monogram when no avatar is
   set, with `Cache-Control` honored.
3. Upload accepts every legal mime, rejects every illegal one
   (magic-byte and declared mime), rejects oversize.
4. Decoded byte budget defense rejects a synthetic image bomb
   in tests.
5. GDPR delete sweeps the prefix and clears the row columns.
6. OWNER moderation route writes an `AuditLog` entry and
   restores the default monogram.
7. Spec #27, #31, #36 integrations against the resolver
   pass on staging.
8. Handoff brief at
   [`../architecture/handoff/32-avatar-media.md`](../architecture/handoff/32-avatar-media.md)
   updated.

## 16. Operator handoff

- **Runbook entry** in [`../deploy-runbook.md`](../deploy-runbook.md):
  how to flip the flag, how to set the bucket, how to take down
  an avatar from OWNER admin.
- **Dashboard tiles:**
  - "Avatar upload error rate" (per error code).
  - "Avatar derive p50/p95 latency."
  - "Bucket bytes used."
- **Alerts:**
  - Upload error rate > 5% over 1 hour.
  - Derive p95 > 2 s sustained 15 minutes (trigger Phase 4
    queued-derive).
- **Kill switches:**
  - `AVATARS_ENABLED=off` — disables route surface; resolver
    stays at default monogram.
  - `AVATARS_ENABLED=read_only` — accepts reads, rejects
    uploads.
