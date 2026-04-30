# 02 — API versioning & contract stewardship

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

The mobile app, the coach console, and the public landing pages
all consume the backend's HTTP contract. Today:

- All authenticated routes live under `/api/*`.
- One narrow versioned namespace exists: `/v1/*` (the coach-console
  BFF — see `src/v1/README.md`). It pre-dates a real versioning
  policy and is closer to "the BFF" than "v1 of the public API".
- `@nestjs/swagger` publishes an OpenAPI 3.1 spec (PR #94 already
  shipped this).
- Mobile builds in the wild span ~6 months. They are pinned to
  endpoint shapes that existed at the time the build was cut.

Without an explicit versioning policy, every shape change is a
risk: mobile clients stuck on old TestFlight or Play builds break
silently. We have already had two contract churns (one in messaging
read-markers, one in invite landing) where the only thing that
saved us was that the operator caught it before the deploy
finished. That posture does not scale across Team Mode, AI Program
Builder, check-ins v2, and revenue dashboards landing in the same
quarter.

**Cross-feature impact:**

| Feature | Why this lane carries it |
|---|---|
| Team Mode | Adds `team_id` to many existing read-models. Mobile must keep working when `team_id` is absent (solo coach). |
| AI Program Builder | Introduces a new `/api/builder/*` surface; mobile sees it only when the entitlement is on. The shape must be stable from day one. |
| Check-ins v2 | The biggest shape change in flight. Three-phase deprecation is the only safe path. |
| Public profiles | New public, unauthenticated read-model. Once published, mutations are forbidden — see SemVer rule below. |
| Templates marketplace | New surface; same "stable from day one" rule. |
| Revenue dashboards | Adds new OWNER reports; existing CSV consumers must keep working. |

## WHEN

This brief is the precondition for any **shape change** to an
existing endpoint that mobile or the coach-console reads. New
endpoints are easier and follow the additive rule below.

Concretely, settle this brief **before** the check-ins v2 shape
change ships. The other features either add new surfaces (which
do not need a version bump) or read new fields additively (which
also does not need a version bump).

## WHERE

- `src/main.ts` — global prefix `/api`. Today there is no
  versioning configured at the framework level.
- `src/v1/` — the coach-console BFF. Stays as-is; this brief
  proposes treating that as a *separate* surface (the BFF), not
  as v1 of the public API.
- `docs/openapi.json` — published spec, exported via
  `npm run openapi:export`. Becomes the source of truth for
  contract diffs.
- `src/main.ts` — adds `app.enableVersioning(...)` (Nest URI
  versioning) — only when the first non-additive change ships.

## WHO

- **Owner:** backend lead.
- **Reviewers:** mobile lead (because mobile pins to shapes),
  coach-console lead.
- **On the hook in production:** OWNER monitors mobile error
  rates in Sentry after every deploy that touches a versioned
  surface.

## WHAT

### What already exists

- OpenAPI 3.1 spec published (`docs/openapi.json`).
- A separate `/v1/*` BFF for the coach console.
- Smoke tests cover the boot-and-shape signal
  (`scripts/smoke.ts`).
- Mobile shape regression is caught manually via the
  `e2e-qa-runbook.md` sweep.

### What is missing

- An explicit **additive-only** rule for `/api/*` between version
  bumps.
- An explicit **three-phase deprecation** procedure for shape
  changes.
- A CI job that diffs `docs/openapi.json` against `main` on every
  PR and flags **breaking** changes (a flag, not a hard fail —
  the operator decides).
- A documented rule for which mobile build versions are
  considered "supported" (proposed: most-recent two minor
  versions, plus any version released in the last 60 days).

### Versioning policy (proposed)

Three rules. Each binds a specific kind of change to a specific
procedure.

1. **Additive change, no version bump.** Adding a new field to a
   response, adding a new optional request field, adding a new
   endpoint. Old clients ignore the new field; new clients see
   it. Counts as "no contract change" — ships in any PR.
2. **Non-additive change, three-phase deprecation.**
   - **Phase A:** the new shape is added next to the old shape.
     Both work. Mobile is updated to read the new shape.
   - **Phase B:** the old shape is marked deprecated in OpenAPI
     and emits a `Deprecation: <date>` response header. Mobile
     telemetry confirms <1% of traffic still on the old shape.
   - **Phase C:** the old shape is removed. PR title is
     `breaking(api): …`.
   The minimum gap between Phase A and Phase C is **two mobile
   release cycles**. If the operator has not cut a mobile release
   in that window, the gap extends.
3. **New versioned surface, only when needed.** A `/api/v2/*`
   prefix is introduced *only* when a single, large change cannot
   be expressed additively (proposed: when check-ins v2 ships).
   `/api/*` continues to mean v1 implicitly — no rename, no
   redirect.

### SemVer adjacency

We do not ship a SemVer version for the API. Instead the
`/api/openapi.json` file's `info.version` field is bumped per the
above rules:

- Additive change: bump the patch.
- Non-additive change in Phase A: bump the minor.
- Non-additive change in Phase C: bump the major.

Mobile reads this version on boot for telemetry only. Behavior
does not depend on it.

## HOW

### Operator handoff

- The OpenAPI diff job runs on every PR. It posts a comment with
  the diff summary. The operator (or backend lead) decides
  whether the diff is additive or breaking and labels the PR
  accordingly.
- A PR labeled `api:breaking` triggers a checklist comment
  reminding the author of the three-phase rule.
- Mobile telemetry for "what shape did this client read" is
  added once `BUILDER_ENABLED` and Team Mode introduce their own
  endpoints — coordinated with lane #10 (analytics).

### BFF ↔ public API split

The coach-console BFF (`/v1/*`) is **not** "v1 of the public
API". It is a separate surface with a separate consumer (the
console). Re-stating this in `docs/api-conventions.md` so that
nobody assumes a `/v2/*` BFF is required when the public API
introduces `/api/v2/*`.

### Mobile pinning

Proposed support window: most-recent two mobile minor versions,
plus any version released in the last 60 days. This is the
standard a Phase-C removal must clear before it ships. The
operator verifies via mobile telemetry before the Phase-C PR
merges.

## Risks

- **Operator forgets the three-phase rule.** Mitigation: PR
  template (under `.github/`) reminds, and the CI diff job
  comments on PRs that look breaking.
- **OpenAPI drift from runtime.** Mitigation: the spec is
  generated from decorated controllers (`@nestjs/swagger`); a
  new check job runs `npm run openapi:export` and fails if the
  committed spec is stale.
- **`/v1/*` BFF gets confused for public-API v1.** Mitigation:
  rename in docs only — call it "the BFF" or "console BFF"
  consistently. No code rename (would be a contract change for
  the console).

## Dependencies

- OpenAPI export script (already exists).
- CI workflow (existing GitHub Actions; one new job to add).
- Lane #10 (analytics) for mobile shape telemetry.
- Lane #11 (release QA) for the Phase-A → Phase-C window.

## Acceptance criteria

1. ✅ `docs/api-conventions.md` exists with the three rules
   above, the SemVer-adjacent bump rules, and the support window.
2. ✅ A CI job diffs `docs/openapi.json` against `main` and
   posts a labeled comment.
3. ✅ A CI job verifies the committed `docs/openapi.json` matches
   `npm run openapi:export` output. Stale spec fails the build.
4. ✅ The PR template includes a single line: "Is this an API
   shape change? If yes, link the deprecation plan."
5. ✅ The BFF (`/v1/*`) is renamed in documentation to "console
   BFF" everywhere (no code rename).

## Test strategy

- **Unit:** none — this lane is procedural.
- **Integration:** OpenAPI export is exercised by the existing
  build; the new diff and freshness jobs run on every PR.
- **Manual:** before any Phase-C PR, the operator checks mobile
  telemetry (lane #10) and confirms <1% of traffic on the old
  shape.

## Rollout & kill-switch

- The diff and freshness CI jobs are non-blocking initially
  (`continue-on-error: true`). After two release cycles with no
  false positives, they are flipped to blocking.
- Kill switch: the diff job can be disabled by removing the
  workflow file; the freshness job's failure is bypassed by
  re-running `npm run openapi:export` and committing the result.
- No runtime kill switch — this lane is build-time only.
