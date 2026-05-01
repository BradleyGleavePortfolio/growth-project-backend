# Handoff brief 36 — Messaging + progress visibility

> Operator-facing pre-work brief for expansion-roadmap item **#36**.
> Companion to the engineer-facing spec at
> [`../../specs/messaging-progress.md`](../../specs/messaging-progress.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 36](../expansion-wave-coach-experience.md).

---

## WHY

A coach loses the moment to act when the signal is in the
data and the action is in the chat. Today, check-ins, at-risk
alerts, and DMs live in separate surfaces with no deep-link
between them. This spec adds a **progress envelope**
(per-client adherence rolled up across regimen, check-ins,
challenges, content views, weight log, fasting log) and a
**deep-link convention** on `CoachMessage` (every message can
carry a `subject_kind` + `subject_id` pointing to the row that
prompted it). It also adds a **visibility preference** so the
client can fine-grain what the coach sees. See spec §2.

## WHEN

Gated on:

1. Specs #21 / #22 / #23 review (PR #121 — field-types,
   at-risk score, weekly recap).
2. Specs #34 / #35 review (`RegimenAssignment` is the source
   of truth for "this week").
3. Spec #30 review (`CoachChallengeParticipation` is the
   challenges source).
4. Founder sign-off on visibility default policy (default =
   full visibility on consent, granular opt-out).
5. Backend lead sign-off on the deep-link `subject_kind`
   catalog.

## WHERE

- **Module changes (additive):** `src/messaging/` gains two
  nullable columns on `CoachMessage` (`subject_kind`,
  `subject_id`) and a resolver. `src/coach/` gains a
  `progress.controller.ts` and a new module `src/progress/`
  holds the projection logic.
- **New tables:** `ProgressVisibilityPreference`,
  `ProgressSnapshot` (optional cache; default off).
- **Reads:** the entire roster of progress sources — see
  spec §4.
- **Routes:** `/api/coach/clients/:client_id/progress`,
  `/api/coach/clients/:client_id/progress/timeline`,
  `/api/me/progress-visibility`,
  `/api/messaging/threads/:id/with-subjects`. See spec §4.

## WHO

- **Owner / decision-maker:** founder for visibility default
  and per-client opt-out policy; backend lead for projection
  contract and `subject_kind` catalog; security for the
  consent-vs-visibility split.
- **On the hook for runtime work:** backend platform.
- **Audience:** coaches (read progress + send deep-linked
  messages), clients (control visibility), spec #22 (read
  same projection), spec #29 (read aggregates).

## WHAT

**Already exists:**

- Spec at [`../../specs/messaging-progress.md`](../../specs/messaging-progress.md).
- Merged `messaging` module and `CoachMessage` row.
- Merged `coach` module (roster, timeline, alerts).
- `ClientCoachConsent` row.

**Still to be produced:**

- Migration: `ProgressVisibilityPreference` (new),
  `ProgressSnapshot` (optional new), two nullable columns on
  `CoachMessage`.
- The projection assembler (`src/progress/aggregator.service.ts`).
- The visibility filter.
- The deep-link resolver and authz.
- The annotated thread read endpoint.
- (Optional Phase 3) the snapshot cache + invalidation.

## HOW

PR-1 lands the visibility preference table plus the read-only
`GET /me/progress-visibility` returning the default shape
derived from consent. Five-phase rollout per spec §7.
Acceptance in spec §15.

Flag: `PROGRESS_ENABLED=off | read_only | on`. Cache flag
`PROGRESS_CACHE=off` initially.
