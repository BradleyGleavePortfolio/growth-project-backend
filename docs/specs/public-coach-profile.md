# Spec — Public coach profile schema + route (B5)

**Roadmap row:** #27.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/27-public-coach-profile.md`](../architecture/handoff/27-public-coach-profile.md).
**Cross-references:** PR #119 (roadmap row #27), the existing
public-pages module (`src/public-pages/`), the existing invite-
landing surface (`docs/invite-landing.md`), spec
[`ready-to-scale-checklist.md`](./ready-to-scale-checklist.md)
(#25 — gates the public profile).

> **Hard boundary:** the public coach profile is rendered by the
> backend, not by the `new-website` repo. Per `CLAUDE.md` and the
> `coach_os_strategy_memo.md`, `new-website` is out of scope for
> this whole expansion. The route lives at the backend's existing
> public surface alongside the help center and trust pages.

---

## WHY

The strategy memo describes B5 as: "tgp.app/coachname with offer,
social proof, testimonials, 'book a call' CTA into TGP's intake."
This is the wedge into A1 (Coach Revenue Engine) — without a
shareable public surface, a coach has no place to send the link
that becomes a paying client. Today, the only public surface is
the invite-landing page, which assumes the visitor already has an
invite code; that is the wrong entry point for cold traffic.

The public coach profile is a **read-only surface** populated
from existing `CoachProfile` fields plus a small handful of new
fields (testimonials, offer, headline). It is gated by the
ready-to-scale checklist (#25): a coach who has not set their
business name, bio, accent color, and timezone does not get a
public route.

## WHEN

Trigger conditions:

1. The ready-to-scale checklist (#25) is at least at the point
   where `isReadyFor("public_profile")` exists.
2. The public-pages module (`src/public-pages/`) is reviewed for
   shared infrastructure (caching, rate-limiting, robots posture,
   SEO meta).
3. The slug-allocation policy is signed off (see "Slug policy"
   below).

## WHERE

- New module: `src/coach-public-profile/` (live alongside
  `src/public-pages/`, not inside it, because the editing surface
  is coach-side and the read surface is anonymous).
- New table: `CoachPublicProfile` — extends, not replaces,
  `CoachProfile`. The split is deliberate: the public table
  carries fields the coach explicitly publishes, with audit and
  versioning the private profile does not need.
- New route shape:
  - **Anonymous read** (no `/api` prefix; mirrors the help
    center): `GET /c/:slug` → SSR HTML page.
  - **Coach edit** (under `/api`): `GET /coach/public-profile`,
    `PUT /coach/public-profile`, `POST /coach/public-profile/publish`,
    `POST /coach/public-profile/unpublish`.
- Reads:
  - `CoachProfile` — branding, business name, bio.
  - `CoachReadinessStepOverride` (#25) — gate.
- Reserved slugs file under `src/coach-public-profile/reserved-slugs.txt`
  (admin, www, api, c, coach, owner, login, signup, …).

## WHO

- **Sign-off:** founder for the page template and the
  testimonial-moderation policy; backend lead for the table
  layout; legal review of the testimonial copy block (third-party
  attribution).
- **On the hook:** backend platform.
- **Downstream consumers:** the existing invite flow's "book a
  call" CTA links into the same intake (#26) once the public
  page exists.

## WHAT

### Already exists

- `CoachProfile` (`prisma/schema.prisma:194`).
- `src/public-pages/` — non-prefixed, anonymous routes (used by
  the help center and trust pages).
- `main.ts` already excludes a small set of paths from the
  global `/api` prefix (see README — "Public, unprefixed routes").

### Net-new

- `CoachPublicProfile` table + audit on every publish.
- `CoachPublicProfileTestimonial` table (one row per
  testimonial).
- The anonymous render path at `GET /c/:slug`.
- One feature flag, `PUBLIC_COACH_PROFILE_ENABLED`.
- `coach.public_profile.{published,unpublished,viewed}` PostHog
  events (the `viewed` event is sampled).

### Non-goals

- No custom domain support in v1. The route is `/c/:slug` on the
  primary backend host.
- No themed / drag-and-drop design tooling. Single template,
  populated from the existing `CoachProfile` fields plus a small
  net-new set.
- No third-party embed widgets (Calendly, Stripe payment links).
  The "book a call" CTA links into the platform-native intake
  (#26).
- No A/B testing of copy.

## HOW

Smallest first PR (PR-1):

- Adds the two models + migration.
- Adds the empty module shell.
- Adds the `reserved-slugs.txt` file and a unit test asserting
  no slug in the file is allowed at table-insert time.

PR-2 wires the coach-side editing routes.
PR-3 wires the anonymous render route under the unprefixed list.
PR-4 wires the gate (`isReadyFor("public_profile")` from #25).
PR-5 turns the flag on for design partners.

## Slug policy

- Lowercase ASCII, 3–32 chars, `[a-z0-9-]+`, no leading/trailing
  hyphen, no consecutive hyphens.
- Reserved slugs (file): cannot be claimed.
- First-come-first-served per coach. A coach can change their
  slug; the prior slug 301-redirects for 90 days, then is
  released back to the pool. The redirect ledger is a third
  table (`CoachPublicSlugRedirect`).
- Profanity filter: simple deny-list; flagged slugs are sent to
  OWNER moderation queue, not auto-rejected.

## Data model sketch

```prisma
model CoachPublicProfile {
  id              String   @id @default(uuid())
  coach_id        String   @unique
  coach           User     @relation("CoachPublicProfile", fields: [coach_id], references: [id])
  slug            String   @unique
  headline        String
  offer_summary   String   // up to 280 chars
  hero_image_url  String?
  cta_label       String   @default("Book a discovery call")
  cta_target      String   @default("intake") // "intake" | "external_url"
  cta_external_url String?
  is_published    Boolean  @default(false)
  published_at    DateTime?
  unpublished_at  DateTime?
  meta_title      String?
  meta_description String?
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  @@index([slug, is_published])
}

model CoachPublicProfileTestimonial {
  id          String   @id @default(uuid())
  profile_id  String
  profile     CoachPublicProfile @relation(fields: [profile_id], references: [id])
  quote       String   // up to 400 chars
  attribution String   // "Sarah, fitness client of 8 months"
  ordinal     Int      @default(0)
  created_at  DateTime @default(now())
  archived_at DateTime?

  @@index([profile_id, archived_at])
}

model CoachPublicSlugRedirect {
  id              String   @id @default(uuid())
  old_slug        String   @unique
  new_slug        String
  coach_id        String
  expires_at      DateTime
  created_at      DateTime @default(now())

  @@index([expires_at])
}
```

## API sketch

### Anonymous render

```
GET /c/:slug
→ 200 text/html (SSR)
  Renders the single template populated from CoachPublicProfile +
  testimonials. Sets cache-control: public, s-maxage=300,
  stale-while-revalidate=86400. Includes Open Graph + Twitter Card
  meta. robots.txt is permissive (these pages are intentionally
  indexed). The CTA links to /invite/<intake_token> if
  cta_target="intake", else to the external URL.
→ 404 when slug not found, slug archived, profile is_published=false.
→ 301 when slug matches a CoachPublicSlugRedirect row.
```

Response throttle: per-IP `60 req/min` at the existing public-
pages throttle bucket. CDN-fronted in production; the backend
serves the origin.

### Coach edit

```
GET /api/coach/public-profile
→ 200 { profile: CoachPublicProfile | null, testimonials: [...] }

PUT /api/coach/public-profile
body { slug?, headline, offer_summary, hero_image_url?, cta_label?,
       cta_target, cta_external_url?, meta_title?, meta_description? }
→ 200 { profile }
  Validates slug shape + reserved + existing-claim. Slug change
  creates a CoachPublicSlugRedirect row.

POST /api/coach/public-profile/publish
→ 200 { profile }
  Only allowed when isReadyFor("public_profile") is true. Sets
  is_published, published_at. Audit-logged.

POST /api/coach/public-profile/unpublish
→ 200 { profile }
  Sets is_published=false, unpublished_at. Public route returns
  404.

POST /api/coach/public-profile/testimonials
body { quote, attribution }
→ 201 { testimonial }

DELETE /api/coach/public-profile/testimonials/:id
→ 200 { testimonial }   // soft-delete; archived_at set
```

Throttle: edits `30 req/min`, publishes `5 req/min`.

## Rollout / feature flags

- **Env var:** `PUBLIC_COACH_PROFILE_ENABLED=true|false` (default `false`).
- **Kill-switch behavior:** anonymous route returns 404; coach
  edit routes return 404. Existing published rows persist; flip
  the flag back on and they reappear.
- **Indexing posture:** anonymous route is allowed in
  `robots.txt` only when the flag is on; otherwise the path is
  disallowed.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Coach-side editing routes lit; design partners draft.
  3. Anonymous route lit; CDN cached.
  4. `robots.txt` updated.
  5. Platform-wide.

## RBAC and privacy

- COACH for `/api/coach/*`.
- Anonymous for `GET /c/:slug`.
- The public profile is, by definition, opt-in public content.
  Testimonials carry attribution from third parties — see Risks
  for the consent posture.
- OWNER moderation surface for profanity-flagged slugs and for
  testimonial copy that fails an automated PII scrub (e.g. an
  email address inside a quote).
- Audit log: `coach.public_profile.{published,unpublished,
  slug_changed}`.

## Tests

- **Unit (`test/coach-public-profile-slug.spec.ts`):**
  - Slug regex.
  - Reserved-slug rejection.
  - Slug change creates redirect row.
  - Reserved file is loaded once on boot, cached.
- **Unit (`test/coach-public-profile-validation.spec.ts`):**
  - 280-char offer_summary cap.
  - 400-char testimonial quote cap.
  - cta_target switching invariants.
- **Integration (`test/coach-public-profile-routes.int-spec.ts`):**
  - 403 cross-coach edits.
  - Publish blocked when readiness gate fails.
  - 301 from old to new slug.
  - 404 for unpublished / archived slugs.
  - Anonymous route ignores auth header (does not throw).
- **Smoke:** seeded coach with all 12 readiness steps + a
  published profile → `curl /c/<slug>` returns 200 with the
  expected meta tags.

## Risks

1. **Squatting.** A non-coach seeds an account, claims a slug,
   never publishes. *Mitigation:* slug only enforced as
   `@unique` on `CoachPublicProfile`, which exists only after
   account creation. The reserved file blocks the obvious targets;
   policy for trademark disputes lives in a separate operator doc.
2. **Testimonial-consent ambiguity.** The coach uploads a
   client's words without clear consent. *Mitigation:* the edit
   form requires the coach to check a "I have permission to
   publish this" checkbox, captured in the `AuditLog` entry as a
   defense in case of dispute. Legal-review-gated copy.
3. **SEO collisions with the help center.** A help slug and a
   coach slug compete. *Mitigation:* the reserved file includes
   every existing public-pages route segment; CI test asserts no
   help route slug overlaps the reserved set.
4. **Public-render performance.** A popular coach's slug under
   load takes down the backend. *Mitigation:* CDN-fronted in
   production with `s-maxage=300`. The render is stateless and
   has no DB write path.
5. **PII in `meta_description`.** A coach pastes a client name
   into the SEO description. *Mitigation:* same automated scrub
   as testimonials.

## Dependencies

- **#25 ready-to-scale checklist:** publish gate.
- **#26 intake questionnaire:** the CTA target.
- The existing public-pages module: shared throttling + caching
  posture.

## Acceptance criteria

- [ ] Migration applied.
- [ ] Three tables exist with the documented indexes.
- [ ] Anonymous route returns SSR HTML with the documented meta
      tags.
- [ ] 301 redirect from changed slugs verified for 90 days.
- [ ] Reserved-slug file enforced; CI test passes.
- [ ] Audit log entries verified.
- [ ] Help center article: "How to publish your coach page."

## Operator handoff

- **Kill-switch:** `PUBLIC_COACH_PROFILE_ENABLED=false`. Anonymous
  route returns 404; published rows are preserved.
- **Slug disputes:** OWNER endpoint (in
  `src/admin/console/`) to force-release a slug + create a
  redirect to a new owner; logged.
- **Profanity / moderation queue:** OWNER report
  `/api/admin/reports/public-profile-flags`.
- **CDN config:** the anonymous route prefix `/c/` is configured
  for caching at the CDN; documented in `deploy-runbook.md`.
- **Runbook entry:** new section "Public coach surfaces"
  alongside the help center entry.
