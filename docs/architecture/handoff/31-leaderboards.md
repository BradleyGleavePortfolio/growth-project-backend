# Handoff brief 31 — Public/private leaderboards

> Operator-facing pre-work brief for expansion-roadmap item **#31**.
> Companion to the engineer-facing spec at
> [`../../specs/leaderboards.md`](../../specs/leaderboards.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 31](../expansion-wave-coach-experience.md).

---

## WHY

Challenges (#30) without a leaderboard are private journals.
Public leaderboards add accountability inside a roster and
proof on the public coach profile (#27). But they introduce
privacy (`User.email` must never become a handle), abuse
(squatting, slurs, bot participation), and performance
(snapshot projection, not on-demand recompute) concerns. See
spec §2.

## WHEN

Gated on:

1. Spec #30 review (the submission schema is the projection's
   source).
2. Spec #32 review (avatar resolver contract).
3. Spec #27 in `main` (the host page for the public widget).
4. Founder sign-off on moderation primitives in spec §11.

## WHERE

- **New module:** `src/leaderboards/` (spec §4).
- **New tables:** `LeaderboardSnapshot`, `LeaderboardEntry`,
  `LeaderboardModerationAction`.
- **Reads:** challenge family (#30), `User`, `UserAvatar` (#32).
- **Routes:** `/api/challenges/:id/leaderboard`,
  `/api/coach/leaderboards/...`, `/api/me/leaderboard/...`,
  `/api/admin/leaderboards/...`,
  `/public/coach/:slug/leaderboards/:id`. See spec §4.
- **Observability:** snapshot build duration, public throttle
  rate, takedown counts; alerts in spec §16.

## WHO

- **Owner / decision-maker:** founder for moderation policy and
  public-visibility default; backend lead for snapshot job
  contract and takedown audit shape; product for the public
  widget UX.
- **On the hook for runtime work:** backend platform.
- **Sign-offs before Phase 1:** founder + backend lead +
  product.
- **Audience:** participants (read), coaches (read full),
  OWNER (moderate), public visitors (read public boards).

## WHAT

**Already exists:**

- Spec at [`../../specs/leaderboards.md`](../../specs/leaderboards.md).
- Reuse plumbing: PR #93 (throttler), the audit module, the
  existing `CommunityWin` row (not the same shape — see gap
  map row #31).

**Still to be produced:**

- Migration adding `LeaderboardSnapshot`, `LeaderboardEntry`,
  `LeaderboardModerationAction`.
- The snapshot job (idempotent on
  `(challenge_id, now()::date)`).
- The display-handle validator + block list.
- The public read endpoint with edge caching.
- Spec #32 wire-up for avatar resolution.

## HOW

PR-1 lands the migration + the manual snapshot rebuild route
(`POST /admin/leaderboards/:id/snapshot/rebuild`) and the
coach-only full read. Public read defers to PR-5.

Five-phase rollout per spec §7:
1. Schema + manual rebuild.
2. Automatic rebuild.
3. Display handle.
4. Moderation.
5. Public surface.

Flip `LEADERBOARDS_ENABLED=on` once Phase 4 is live.
`LEADERBOARDS_PUBLIC_VISIBILITY` flips on at Phase 5 only after
the moderation queue has been observed under fire on staging.
The acceptance checklist is in spec §15; the runbook entry
goes to [`../../deploy-runbook.md`](../../deploy-runbook.md).
