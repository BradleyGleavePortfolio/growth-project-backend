# Handoff brief — Public coach profile (B5)

**Roadmap row:** #27.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/public-coach-profile.md`](../../specs/public-coach-profile.md).
**Cross-references:** PR #119 (parent roadmap), brief
[`25-ready-to-scale-checklist.md`](./25-ready-to-scale-checklist.md)
(gates publication), brief
[`26-intake-questionnaire.md`](./26-intake-questionnaire.md)
("book a call" CTA target).

> **Hard boundary:** rendered by *this* backend, not by the
> `new-website` repo. Per `CLAUDE.md` and the strategy memo,
> `new-website` is out of scope for the entire expansion track.

## WHY

The strategy memo's B5 calls for `tgp.app/coachname` — a
shareable public surface with offer, social proof, testimonials,
and a "book a call" CTA into the platform-native intake. Today
the only public surface is the invite-landing page, which
already assumes the visitor has an invite code. This item adds
the cold-traffic entry point.

## WHEN

- Ready-to-scale checklist (#25) exposes
  `isReadyFor("public_profile")`.
- The public-pages module is reviewed for shared infra
  (caching, robots, SEO meta).
- Slug-allocation policy (reserved file, profanity moderation,
  90-day redirect) is signed off.

## WHERE

- New module: `src/coach-public-profile/`.
- New tables: `CoachPublicProfile`,
  `CoachPublicProfileTestimonial`,
  `CoachPublicSlugRedirect`.
- New anonymous route: `GET /c/:slug` (SSR HTML, unprefixed).
- New coach routes under `/api/coach/public-profile/*`.

## WHO

- **Sign-off:** founder for page template + testimonial-
  moderation policy; backend lead for tables; legal review of
  testimonial copy block.
- **On the hook:** backend platform.
- **Downstream:** intake (#26) — CTA target.
- **Hard boundary:** `new-website` repo is **not** the renderer.

## WHAT

- **Already exists:** `CoachProfile`, `src/public-pages/`,
  unprefixed-routes mechanism in `main.ts`.
- **Net-new:** three tables, one module, one feature flag
  (`PUBLIC_COACH_PROFILE_ENABLED`), `reserved-slugs.txt`,
  three PostHog events (one sampled).
- **Non-goals:** no custom domains; no theme editor; no third-
  party embed widgets; no A/B testing.

## HOW

PR-1 migration + module shell + reserved-slug enforcement. PR-2
coach edit routes. PR-3 anonymous render route + CDN cache
headers. PR-4 wires the `isReadyFor` gate. PR-5 design-partner
allow-list, then platform-wide.

## Risks (top three)

1. **Slug squatting** — reserved file blocks obvious targets;
   trademark dispute policy lives in a separate operator doc.
2. **Testimonial-consent ambiguity** — coach must check "I have
   permission" with that fact captured in `AuditLog` for
   defense in case of dispute.
3. **PII leakage in `meta_description`** — automated scrub
   identical to testimonials.

## Cross-references

- Spec: [`../../specs/public-coach-profile.md`](../../specs/public-coach-profile.md).
- Gate: brief #25.
- CTA target: brief #26.
