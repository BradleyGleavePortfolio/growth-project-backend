# Perplexity Computer — handoff log

This file is updated by every Computer session that does substantive
work in this repo. New sessions should read it top-to-bottom before
touching anything. The most recent session is at the top.

---

## Session 2026-05-01 (mid-day PDT) — Wave 3 admin data-feed RFC

**Goal:** write the data-architecture companion to the Wave 1 admin
console reconciliation. The Wave 1 set defines **what** screens exist;
this RFC defines **how** the data flows underneath them: scope-bar
pattern, cohort taxonomy, time-window contract, scope-stack drilldown
data model, endpoint contract, query and caching layers, SSE/polling
decision, telemetry, privacy, RBAC extensions, existing-endpoint
reconciliation, new-gap inventory beyond Wave 1's §11.A–O.

**Status:** docs-only, draft, **NOT MERGED**. Branched from `main` so
this PR's diff is small and free of Wave 1 churn. Cross-PR dependency
on Wave 1 (PR #130) is documented below and at the top of every doc
file in this PR.

### What was done

Created branch `docs/wave-3-admin-data-feed` from `main`. Added two
new doc files in `docs/admin/`, plus this Wave 3 entry on top of the
existing handoff log:

| File | Lines | Purpose |
|---|---:|---|
| `data-feed-rfc.md` | 1794 | The architecture RFC. 20 sections including scope-bar mental model, cohort taxonomy, time-window contract, scope-stack data model + URL contract, endpoint contract (per-screen + feed envelope), query layer (N+1 fixes, indexes, materialised views), caching layer (TTLs, single-flight, soft-expire, cache-bust events), realtime (SSE for Overview, polling for tables), telemetry (operator productivity, query volume, cache health), privacy (audit-on-read at person-frame boundary), RBAC extensions (3 new advisory capabilities), existing-endpoint reconciliation table, new-gap inventory (§11.P-cohort, §11.P-archetype, §11.P-org-tree, §11.P-window, §11.P-observe), test plan, rollout phasing into Wave 1's §17, risks, 15 open questions for the user, decisions-made summary. |
| `data-feed-glossary.md` | 268 | Alphabetical glossary of every term the RFC introduces (archetype, capability hash, cohort, cohort intersection, compare-to-previous, cursor, drilldown, facet, feed envelope, frame, granularity, materialised view, org-cohort, person-frame, rebase, scope, scope bar, scope hash, scope stack, segment, single-flight, soft-expire, SSE, TBD-admin-P-*, tier, time window, wrap). |

### Key architecture decisions

1. **Per-screen endpoints, not a unified `/feed` router.** Existing
   `/api/admin/*` endpoints stay; new ones follow the same shape. The
   one extension is a `/api/admin/feed/v1/scope/*` family for cross-
   screen primitives (cohort listing, org-tree expansion, time-window
   aggregator). No deprecations of existing endpoints.
2. **Closed enum cohort taxonomy.** Eight cohort types in v1
   (`signup`, `archetype`, `tier`, `org`, four client variants); no
   operator-authored saved-searches in v1.
3. **Scope-stack lives in URL fragment + `localStorage`.** Server-side
   persistence deferred to v2. Eight-frame ceiling. Push-on-zoom-in,
   rebase-on-zoom-out.
4. **SSE for Overview / health-strip / recent-activity. Polling /
   manual for tables.** No WebSocket. Reconnect with `Last-Event-Id`,
   15s heartbeat, exponential backoff.
5. **Materialised views: cohort retention only in v1.** MRR breakdown
   matrix can ship real-time at 1k coaches; the retention matrix
   cannot. Refresh job ships in the same PR as the view; we do not
   ship a view without its refresher.
6. **UTC server-side, locale display only.** No per-operator timezone
   storage. DST and timezone-rollover bugs are not a place to live.
7. **Path-versioned feed (`/api/admin/feed/v1/`).** Matches the
   existing `/api/v1/` coach-BFF convention.
8. **Per-cohort cache TTLs (1m org, 5m signup/tier/program, 15m
   archetype, 30s platform-wide) plus an operator-action override.**
   When an OWNER takes a state-changing action, the backend Redis-
   publishes a cache-bust naming the affected scope; subscribers drop
   the matching keys. Operator never sees their own action lag.
9. **Capability hash mixed into cache keys.** Two operators with
   different RBAC capability sets do not share cache entries.
10. **Audit-on-read at person-frame boundary.** Cohort reads do not
    audit; person-frame pushes do. The `metadata.scope_hash` carries
    forensic context without recording cohort contents.
11. **No deprecations of existing endpoints.** Wraps are additive.

### Cross-repo dependencies

- **Wave 1 (PR #130 in this repo, `docs/admin-console-canonical`).**
  Hard dependency. This RFC cross-references §11.A–O (gap letters),
  §17 (7-week rollout), the canonical screen set in §3–§10, and the
  capability matrix in `deployment-and-rbac.md` §3. The four Wave 1
  files (`README.md`, `control-room-spec.md`,
  `deployment-and-rbac.md`, `pr-sequence.md`, `screens-addendum.md`)
  do not yet exist on `main` — they arrive when PR #130 merges. Until
  then, every cross-reference in this RFC's "References" section
  describes a path that materialises with PR #130. **Recommended
  merge order: PR #130 first, this PR second; or merge both as a
  sequenced pair so the cross-references resolve from day one.**
- **Wave 2 (sub-coach hierarchy, archetype taxonomy, programs +
  milestones).** Soft dependency. The archetype cohort, org-cohort
  tree expansion, and three of four client-cohort variants depend on
  schema additions Wave 2 owns (`CoachProfile.archetype`,
  sub-coach hierarchy table, `Program`/`Milestone` tables). This
  RFC's `not_yet_available` posture absorbs the dependency: until
  the Wave 2 schema lands, the chip dropdowns hide those cohort
  types. The endpoint contracts are stable across Wave 2 landing.
- **Wave 4 (mobile mirror) and Wave 5 (finance billing-split).** None.
  This RFC is backend-side only; the data-feed contract is consumed
  by `tgp-admin-web` and the optional admin mobile companion. Wave 4
  and Wave 5 are sibling docs PRs in other repos.

### Placeholders documented (and why)

- **Wave 1 file paths cited in `data-feed-rfc.md` "References" and
  in cross-references throughout (e.g.
  `[`./control-room-spec.md`](./control-room-spec.md)`).** Reason:
  branched from `main`, where these files do not yet exist; they
  arrive with PR #130. **Action:** if PR #130 merges first, no
  follow-up. If PR #130 is closed in favour of a different
  reconciliation, every cross-reference here that cites a §11 letter
  or §17 phase is restated against the new canonical document; the
  architectural decisions in this RFC do not change.
- **`TBD-admin-P-cohort`, `TBD-admin-P-archetype`,
  `TBD-admin-P-org-tree`, `TBD-admin-P-window`, `TBD-admin-P-observe`
  slot names in §15.** Reason: same convention Wave 1 uses for
  `TBD-admin-A..O`. Real PR numbers cut at branch-cut time. The
  canonical-spec author should append the §11.P-* rows verbatim to
  `pr-sequence.md` §3 in a docs sub-PR after this RFC merges.
- **`CoachProfile.archetype` column.** Reason: Wave 2 owns this
  schema addition. Documented as a hard dependency in §3.2 and §15.2;
  the runtime author for `TBD-admin-P-archetype` is the same person
  who lands the Wave 2 column.
- **Sub-coach hierarchy schema.** Reason: same. The org-cohort tree
  expansion endpoint (§15.3) hard-depends on Wave 2's sub-coach
  hierarchy table. Documented; not invented.
- **`User.last_seen_at` column (Wave 1 gap §11.F).** Reason: already
  reserved in `pr-sequence.md` §3 as `TBD-admin-F`. Cross-referenced
  in §8.2; this RFC adds no new dependency.
- **`Price` mirror table (Wave 1 gap §11.D).** Reason: already
  reserved as `TBD-admin-D`. Cross-referenced in §8.3; same.
- **15 open questions in §19.** Each is documented with options +
  recommendation. Reason: decision-grade content the user (Bradley)
  must validate before runtime PRs descend. Not artefacts of missing
  knowledge; deliberate deferrals.
- **Admins-of-admins panel (`/api/admin/observe/*`).** Reason:
  reserved as `TBD-admin-P-observe`, Phase 7 (hardening). The data
  surfaced is operator-side telemetry; useful once operators are
  using the console, not before.
- **`ADMIN_FEED_USE_REPLICA` env var name.** Reason: read-only
  replica is out of scope for v1 (§8.5). Reserving the name so the
  v2 author doesn't rename when the replica arrives.

### Decisions deferred to user (Bradley)

The 15 open questions in §19 of `data-feed-rfc.md` each carry our
recommendation. The questions in priority order:

1. **Q1 — per-screen vs unified endpoints.** Recommend per-screen.
   Hardest to reverse later.
2. **Q4 — materialised views in v1.** Recommend retention only.
3. **Q5 — archetype column placement.** Wave 2 author owns; defer.
4. **Q7 — capability matrix server-enforcement timing.** Recommend
   when `/api/admin/operators` ships.
5. **Q9 — cache TTLs.** Recommend per-cohort as written.
6. **Q11 — feed contract versioning.** Recommend path.
7. **Q13 — timezone handling.** Recommend UTC server, locale display.
8. **Q14 — bulk-export rate limit.** Recommend one per hour per OWNER.

The remaining seven (Q2 cohort enum vs free-form, Q3 SSE vs polling
for Overview, Q6 scope-stack server persistence, Q8 compare-to-
previous defaults, Q10 fragment vs query for scope-stack, Q12 SSE
delivery guarantees, Q15 admins-of-admins panel timing) are lower-
stakes — defaults work either way; explicit sign-off cleans up docs.

### What the next Computer should know

- **The user is Bradley Gleave** (`@BradleyGleavePortfolio`). Same
  ground rules as the Wave 1 session: enterprise depth, no emoji,
  no `Coming Soon`, no `any` types, no synthetic numbers, money is
  `Decimal(14,2)` end-to-end, AI calls use `sonar-pro`, audit row on
  every mutation, append-only audit log.
- **The Wave 1 PR (#130) and this PR are the two-PR docs sequence**
  the user wants in place before runtime work descends from either.
  Recommended merge order: PR #130 first, this PR second. The two
  may also merge as a sequenced pair the same day.
- **The `tgp-admin-web` frontend repo still does not exist.** Same
  posture as Wave 1. Cannot be created without explicit user
  approval (new repo creation).
- **`ADMIN_CONSOLE_V2_ENABLED` is still a reservation.** The data-
  feed contract is gated on it; no second flag.
- **§15 introduces five new gap rows (§11.P-*).** When PR #130 has
  merged and this PR opens, the same author should file a docs sub-
  PR appending those rows to `pr-sequence.md` §3 verbatim. The
  capability matrix in `deployment-and-rbac.md` §3 should also
  receive `view:cohort`, `view:org_tree`, `view:observe`.
- **The next runtime descent should land `TBD-admin-P-cohort`
  alongside the Phase 2 Coaches/Clients tables.** That endpoint is
  what populates the scope-bar's cohort chip dropdown; without it,
  operators have to guess valid cohort values.
- **No runtime code, schema, env, CI, or migration changes** in
  this PR. Same hard rule as Wave 1.

### Next steps if the wave continues

Two more draft PR waves planned in parallel (Opus subagents):

- **Wave 4** — mobile mirror of retention/onboarding into
  `growth-project-mobile` (separate repo).
- **Wave 5** — finance app sub-coach billing-split spec into
  `tgp-finance-app` (separate repo).

Each wave updates this file when its work completes.

---

## Session 2026-05-01 (early AM PDT) — Wave 1 admin console reconciliation

**Goal:** finish what the previous Computer was mid-build on when its
session was cut: reconciling the two competing admin console specs
(PR #127 and PR #128) into a single canonical source of truth.

**Status:** docs-only, draft, **NOT MERGED**. Sitting alongside #127
and #128 as a third draft PR. User instruction: stay unmerged
tonight; build to one-click-to-merge state.

### What was done

Created branch `docs/admin-console-canonical` from PR #128's branch
(`docs/admin-control-room-spec`). Adopted #128's
`docs/admin/control-room-spec.md` as the canonical primary spec
unchanged. Added four new doc files in `docs/admin/`:

| File | Lines | Purpose |
|---|---:|---|
| `README.md` | 36 | Index, supersedes #127, adopts #128 as primary |
| `control-room-spec.md` | 755 | Carried forward from #128 unchanged — the EHR control-room target shape, §11.A–O gap inventory, §17 7-week phased rollout |
| `deployment-and-rbac.md` | 157 | Migrated from #127 §1.3, §2, §11, §17 — deployment shape, auth, advisory client-side capability matrix, optional admin mobile companion wire contract |
| `pr-sequence.md` | 299 | Reconciles #127 §12 stale PR-numbered map with #128 §11 gap-letter inventory; allocates `TBD-admin-A..O` placeholder slots; phase rollup; explicit out-of-scope list |
| `screens-addendum.md` | 677 | The 9 screens from #127 §4 not covered in #128 §3-§10: AI & Audit, Reports & Exports, Privacy & GDPR, Feature Flags, Release & Readiness, Mastermind, plus 3 consumer-only (Marketplace, Payouts, Support) owned by other expansion PRs |

### Key reconciliation decisions

1. **#128 is canonical.** Its EHR control-room framing wins over
   #127's "web dashboard" framing. #128 also did the rigorous
   endpoint-gap inventory (§11.A–O) which is the contract future
   runtime PRs are graded against.

2. **PR #127's §12 PR-numbered map (#117–#126) is stale.** Those PR
   numbers are now used by other in-flight scopes (AI Program Builder,
   Team Mode, expansion roadmap, masterminds, coach-experience wave,
   commerce/marketplace, engagement/retention). The new
   `pr-sequence.md` allocates `TBD-admin-A` through `TBD-admin-O`
   placeholder slots instead of inventing collision-prone numbers.

3. **Recommended PR disposition:**
   - Close #127 unmerged with a comment pointing at this canonical PR.
   - Either merge #128 first then layer this PR on top (preserves
     git history) OR close #128 too and treat this as a complete
     replacement. **User decision required.**

4. **Three categories of cross-repo concern preserved:**
   - **Owned by admin console runtime PRs:** §11.A–O gap closures.
   - **Owned by other expansion PRs (admin console only consumes):**
     marketplace moderation (#125 commerce wave), payouts/disputes
     (Stripe Connect / commerce), support tickets (#126 engagement
     wave), feature flags (separate platform-readiness PR), AI cost
     tracking (separate AI infra PR), masterminds
     (`MastermindApplication` table — separate PR).
   - **Anti-scope:** no per-tenant scoping, no new auth model, no
     changes to `new-website`, no runtime/schema/migration/env/CI
     changes in this PR.

### What the next Computer should know

- The user is **Bradley Gleave** (`@BradleyGleavePortfolio`). He runs
  The Growth Project — a private high-touch coaching platform.
  Positioning sharpened tonight: **"Whop AI for trainers, gyms,
  influencers, info-sellers/coaches — with sub-coach hierarchy."**

- The previous Computer (the one before tonight's) died mid-build
  literally 4 minutes after opening PR #128. Its last action was
  pivoting the admin console framing from "web dashboard" (#127) to
  "EHR control room" (#128). Tonight's session finished that pivot.

- **Strict rules from the user:**
  - Build to enterprise depth/quality.
  - Never use placeholder content without noting why/where in this
    file.
  - Optimize for user experience (operator UX in this case).
  - Stay draft, stay unmerged, never touch live apps without
    explicit approval.
  - No emoji. No `Coming Soon`. No `any` types. No `ts-ignore`. No
    invented data. No synthetic numbers in metrics screens.
  - Money is `Decimal(14,2)` end-to-end. AI calls use `sonar-pro`,
    never `sonar`. Audit row on every mutation. Append-only audit log.

- **What is NOT in this PR (intentional placeholders, all justified):**
  - The `tgp-admin-web` frontend repo does not exist yet. Spec'd as
    next-step in `pr-sequence.md`. Cannot be created without user
    approval (new repo creation).
  - The `ADMIN_CONSOLE_V2_ENABLED` feature flag is referenced in the
    spec but not added to backend env yet. Requires a tiny runtime
    PR — out of scope for tonight's docs-only constraint.
  - The `/api/admin/operators` endpoint that would server-enforce the
    capability matrix is reserved-name-only. The matrix is
    advisory/client-side until that endpoint ships. Documented.
  - `X-Operator-Action` and `X-Operator-Surface` headers are spec'd
    but the backend doesn't yet echo them into audit metadata. Listed
    as a gap-closing requirement in `pr-sequence.md`.

### Next steps if tonight's plan continues

Three more draft PR waves planned in parallel (Opus subagents):
- **Wave 2** — retention progression system + sub-coach hierarchy +
  Whop-AI positioning + client/coach onboarding (5+ doc files in
  `docs/product/`)
- **Wave 3** — admin data-feed RFC for cohort drilldown (1 doc file
  in `docs/admin/`)
- **Wave 4** — mobile mirror of retention/onboarding (separate repo)
- **Wave 5** — finance app sub-coach billing-split spec (separate repo)

Each wave updates this file when its work completes.

---

## Session [previous] — what came before tonight

The previous Computer session opened a long string of draft expansion
PRs (#117 through #129 in `growth-project-backend`, #92–#97 in
`growth-project-mobile`, #106–#108 in `tgp-finance-app`) covering AI
Program Builder, Team Mode, masterminds + L1/L2/L3 SaaS tiers,
coach-experience wave, commerce/marketplace, engagement/retention, and
the original admin console specs (#127 + #128). All draft, all
unmerged, all CI green. None of them touched runtime code.

That session died right after opening #128 — likely a context limit
or session timeout. It was about to start runtime work behind an
`ADMIN_CONSOLE_V2_ENABLED` flag but never got there.

Tonight's session picked up the baton specifically on the
#127-vs-#128 reconciliation it left mid-pivot.
