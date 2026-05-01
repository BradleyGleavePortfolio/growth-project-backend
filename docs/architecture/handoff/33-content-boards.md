# Handoff brief 33 — Coach content boards

> Operator-facing pre-work brief for expansion-roadmap item **#33**.
> Companion to the engineer-facing spec at
> [`../../specs/content-boards.md`](../../specs/content-boards.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 33](../expansion-wave-coach-experience.md).

---

## WHY

Coaches today distribute newsletters, PDF packs, video
libraries, and link bundles through email or third-party
Notion. None of those routes is gated by `ClientCoachConsent`,
auditable, or co-located with the client's existing surfaces.
Content boards are the **distribution surface** for
already-ingested coach assets (PR #117). See spec §2.

## WHEN

Gated on:

1. PR #117 RFC §3 + §8 review (CoachAsset shape, Supabase
   prefix, mime allow-list — same union).
2. Spec #32 (avatar resolver — used for board cover image).
3. Spec #34 (regimens may link to a board from a regimen
   week).
4. Founder sign-off on per-tier byte ceilings (#37) and
   public-visibility default.

## WHERE

- **New module:** `src/content-boards/` (spec §4).
- **New tables:** `ContentBoard`, `ContentBoardItem`,
  `ContentBoardSubscription`, `ContentBoardView`.
- **Reads:** `CoachAsset` (PR #117), `Lesson`, `User`,
  `ClientCoachConsent`. Asset ingestion remains in PR #117.
- **Routes:** `/api/coach/content-boards/...`,
  `/api/me/content-boards`,
  `/api/content-boards/:id/items/:item_id`,
  `/api/admin/content-boards/:id/...`,
  `/public/coach/:slug/content-boards/:id`. See spec §4.
- **Item kinds:** `pdf_asset`, `video_asset`, `link_external`,
  `lesson_ref`, `markdown_inline`. Each has its own validator.

## WHO

- **Owner / decision-maker:** founder for byte ceilings,
  public-visibility default, newsletter fan-out trigger;
  backend lead for visibility model and view-tracking shape;
  product for board organization UX.
- **On the hook for runtime work:** backend platform.
- **Audience:** coaches (curate), clients (subscribe + read),
  OWNER (moderate), public visitors (read public boards).

## WHAT

**Already exists:**

- Spec at [`../../specs/content-boards.md`](../../specs/content-boards.md).
- `CoachAsset` ingestion (PR #117).
- The merged `Lesson` row.
- Markdown-sanitizer dependency (proposal:
  `isomorphic-dompurify`).

**Still to be produced:**

- Migration adding the four tables.
- The discriminated-union item validator.
- The external-link host deny list and SSRF guard.
- The view-tracking projection.
- The public read endpoint with edge caching.
- The newsletter fan-out hook (deferred to spec #36 wiring).

## HOW

PR-1 lands the migration + coach-side CRUD with only
`link_external` and `markdown_inline` item kinds wired (no
asset deps). This lets the runtime ship before #117's
ingestion is live.

Six-phase rollout per spec §7. Flag values:
`CONTENT_BOARDS_ENABLED=off | coach_only | on`;
`CONTENT_BOARDS_PUBLIC=on/off` separately (so an incident on
the public surface does not require disabling coach-side
reads). Acceptance criteria in spec §15.
