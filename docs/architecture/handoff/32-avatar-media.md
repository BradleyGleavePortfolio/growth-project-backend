# Handoff brief 32 — Profile pictures / avatar media

> Operator-facing pre-work brief for expansion-roadmap item **#32**.
> Companion to the engineer-facing spec at
> [`../../specs/avatar-media.md`](../../specs/avatar-media.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 32](../expansion-wave-coach-experience.md).

---

## WHY

The platform needs user-identity media for downstream consumers:
public coach profile (#27), leaderboards (#31), and messaging
(#36). A small feature with big surface area — get the resolver
right on day one, because every consumer reads from it. See
spec §2.

## WHEN

Gated on:

1. PR #117 RFC §8 review (Supabase Storage prefix, mime
   allow-list).
2. Image-derivation library decision (`sharp` proposed in
   spec §14).
3. Founder sign-off on size ceiling (5 MB pre-derive).

## WHERE

- **New module:** `src/avatars/` (spec §4).
- **Schema change:** prefer §10.A (three columns on `User`:
  `avatar_storage_key`, `avatar_derived_keys`,
  `avatar_updated_at`); §10.B alternative (separate
  `UserAvatar` table) is acceptable.
- **Storage:** Supabase Storage bucket
  `avatars/{user_id}/{generation}/<size>.{ext}`. New env var
  `SUPABASE_AVATAR_BUCKET`.
- **Routes:** `POST /me/avatar`, `DELETE /me/avatar`,
  `GET /users/:id/avatar?size=...`,
  `DELETE /admin/users/:id/avatar`. See spec §4.
- **Observability:** upload error rate, derive p50/p95
  latency, bucket bytes used.

## WHO

- **Owner / decision-maker:** founder for size ceiling and
  default-avatar policy; backend lead for resolver URL shape;
  security/legal for scrub posture.
- **On the hook for runtime work:** backend platform.
- **Audience:** every user (uploading), specs #27 / #31 / #36
  (consuming), OWNER (moderating).

## WHAT

**Already exists:**

- Spec at [`../../specs/avatar-media.md`](../../specs/avatar-media.md).
- Supabase Storage prefix conventions (PR #117 §8).
- The existing `audit` module.

**Still to be produced:**

- Migration adding the columns (or new table).
- The upload + multipart validation pipeline.
- The derive-thumbnail job (synchronous in Phase 2; queued in
  Phase 4 if p95 > 1 s).
- The default monogram SVG renderer.
- The OWNER moderation route.
- New dependency: `sharp` (or equivalent).

## HOW

PR-1 ships the migration plus the resolver route with the
default-avatar fallback. This unblocks downstream specs (#27,
#31, #36) to integrate against a stable URL contract before
the upload path lands.

Four-phase rollout per spec §7. Flag values:
`AVATARS_ENABLED=off` until Phase 1; `read_only` Phase 1–2;
`on` Phase 2+. Acceptance in spec §15; runbook in
[`../../deploy-runbook.md`](../../deploy-runbook.md) per
spec §16.
