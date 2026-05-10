# Perplexity Computer — handoff log

This file is updated by every Computer session that does substantive
work in this repo. New sessions should read it top-to-bottom before
touching anything. The most recent session is at the top.

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
