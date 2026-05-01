# Spec: Rewards and Bounties

> **Status:** Draft (engineer-facing). **Roadmap row:** #43
> (engagement & retention wave). **Owner:** backend lead.
> **Companion brief:** [`docs/architecture/handoff/43-rewards-and-bounties.md`](../architecture/handoff/43-rewards-and-bounties.md).
> **No runtime in this PR.** No schema change, no migration, no
> module wiring. Runtime PRs descend from this spec, behind
> `BOUNTIES_ENABLED`. **This spec deliberately stops short of
> any sweepstakes/lottery surface** — see §11 for the legal
> posture.

This is the engineer-facing specification for **Rewards and
Bounties** — the surface that lets a coach pay, comp, or credit
their members for completing specific, coach-defined actions
(post a transformation photo, refer a friend, hit a 30-day
check-in streak, win this month's challenge). It is the
financial-ledger sibling of the challenge-leaderboard spec
(PR #123 #30, #31) and the retention-incentive layer atop
the community spec ([`community-spaces.md`](./community-spaces.md))
and the events spec
([`events-live-calls.md`](./events-live-calls.md)).

The 16-section template follows
[`docs/specs/README.md`](./README.md). Every section closes with
the decisions that must be settled before the first runtime
PR.

---

## 1. Status banner and cross-references

- **Stage:** discovery → spec.
- **Depends on (drafts):** PR #117 (no direct dep; reuses no-AI
  posture), PR #118 (Team Mode forward-compat), PR #120 (lanes
  #01 flags / #03 RBAC / #04 data lifecycle / #05 billing
  packaging / #06 observability / **#11 release QA** for the
  prize-payout regression gate), PR #121 (#28 program-templates
  is the structural cousin), PR #122 (mastermind operating model
  has its own non-cash rewards via concierge — this spec covers
  the **in-app** reward only), PR #123 (#30 coach-challenges and
  #31 leaderboards are the natural redemption triggers; #36
  messaging+progress for the coach-side payout banner).
- **Reuses (merged):** `User`, `CoachProfile`, `CoachSubscription`,
  `Invoice`, `PaymentFailure`, `StripeProcessedEvent`,
  `AuditLog`, `AuditAction`, the throttler.
- **Out of scope:** sweepstakes, lotteries, raffles, "win a free
  vacation" prize draws — anything where the prize is awarded
  by chance rather than by completion of a coach-defined task
  (see §11). Cross-coach bounty federation. Cash-out to bank
  account by members. Member-to-member bounties (only
  coach-to-member in v1). Stripe Connect payouts (parking-lot
  in PR #120 lane #05).

---

## 2. WHY — problem in user/business terms

**Coach problem.** A coach wants to incentivise a specific
behaviour — "share your transformation photo, get $50 toward
your next month's invoice" or "hit your 30-day check-in streak,
get a free 1-on-1 call." Today they do it by hand: a Venmo, a
manual discount code, a private DM. Nothing tracks the outcome,
nothing audits the payout, and the coach loses every dispute
because there is no record.

**Client problem.** A client completes the action and waits.
Will the coach remember? Will the credit show up? Will the
comp get applied to next month? Trust collapses on every
ambiguity, and the engagement loop the bounty was supposed to
drive collapses with it.

**Business problem.** Rewards are the **one** mechanic that
turns the coach's audience into a marketing engine: referrals,
testimonials, transformation photos, retention streaks. Whop,
Patreon, Discord, and every creator platform that scaled past
$10M ARR has a rewards layer, because rewards are how the
audience pays the platform back in word-of-mouth. This spec
adds that layer **without** the pitfalls (legal exposure from
sweepstakes, fraud from cash-out, abuse from stacked claims).

**Why now.** The community spec and the challenge spec
(PR #123 #30) both produce **completion events** — a
transformation post, a streak hit, a challenge win. Without a
rewards layer, those events are pure dopamine. With a rewards
layer, they become a retention mechanic the coach can dial up
or down per tier.

---

## 3. WHEN — gating conditions for the first runtime PR

PR-1 (schema + read-only `GET` of an empty bounty list) cannot
start until **all** of the following are true.

1. **Reward-currency decision recorded.** The first runtime PR
   ships **only** the **coach-credit** currency (§7) — a
   subscription-credit applied to the next invoice via
   Stripe's existing `coupon` / `promotion_code` /
   `customer_balance` mechanics. **No cash, no gift cards, no
   crypto, no points-tradable-for-money**. Any currency
   addition lands as a separate runtime PR with its own gating
   review.
2. **Payout posture confirmed.** Coach pays the platform
   per the existing tier; the platform applies a credit to the
   member's next coach invoice. The coach does not directly
   move money to the member; the platform reconciles via the
   existing Stripe ledger. PR #120 lane #05 records the
   per-coach monthly bounty cap (defaults: L1 $0/mo, L2
   $100/mo, L3 $500/mo).
3. **Sweepstakes posture written.** The platform Terms of
   Service explicitly disclaims sweepstakes / lottery / chance-
   based prize structures, and the spec restricts bounties to
   completion-of-task-by-coach-criteria. Recorded as a
   compliance line in `docs/audit-and-gdpr.md` (a future edit,
   not in this PR).
4. **Audit posture confirmed.** Every state transition writes a
   row through `AuditService.write` with a new `AuditAction`
   constant prefix `bounty_*` — same convention as `coach_*`.
5. **Anti-fraud floors confirmed.** A bounty cannot pay out
   more than the coach's monthly cap, more than the tier-
   allowed amount, or to a member whose account is flagged
   (per the existing GDPR / abuse posture in
   `docs/audit-and-gdpr.md`).
6. **OWNER review for any bounty above $X.** Any bounty payout
   above an OWNER-set threshold (default $100) writes a
   `BountyPayoutReviewQueue` row before applying the credit.
   The OWNER reviews via `/api/admin/bounties/review-queue`
   (existing OWNER admin convention).

---

## 4. WHERE — modules, tables, routes touched

### 4.1 New module

`src/bounties/` (peer to `src/billing/`).

| File | Owns |
|---|---|
| `bounties.module.ts` | Wires controller + services. Imported by `app.module.ts` only behind `BOUNTIES_ENABLED`. |
| `bounties.controller.ts` | `GET /api/bounties/coach/:coach_id`, `GET /api/bounties/:id`, `POST /api/bounties` (coach), `PATCH /api/bounties/:id` (coach), `POST /api/bounties/:id/claim` (member; requires evidence), `POST /api/bounties/:id/award` (coach approves a claim), `POST /api/bounties/:id/reject` (coach rejects a claim with a reason), `GET /api/admin/bounties/review-queue` (OWNER), `POST /api/admin/bounties/review-queue/:id/approve` (OWNER). |
| `bounties.service.ts` | Prisma + the per-coach monthly cap predicate. |
| `bounties-credit.service.ts` | The Stripe credit-application path. Idempotent against the existing `Invoice` ledger. Reuses `StripeProcessedEvent` table for dedup. |
| `bounties-evidence.service.ts` | Evidence intake (a CommunityPost id, a CheckIn id, an Event attendance, a referral-code redemption). Pure validation, no side effects. |
| `dto/*.ts` | DTOs + Swagger. |
| `README.md` | Module orientation. |

### 4.2 New tables (additive, sketched in §8)

`Bounty`, `BountyClaim`, `BountyPayout`, `BountyPayoutReviewQueue`.
Every row carries `coach_id`. Every write carries the
nullable `acted_by_member_user_id` PR #118 hook.

### 4.3 New env vars (described, not added)

- `BOUNTIES_ENABLED` — global kill-switch. Default off.
- `BOUNTIES_MAX_REWARD_PER_BOUNTY_USD` — hard ceiling
  (default $500).
- `BOUNTIES_MAX_MONTHLY_PAYOUT_PER_COACH_USD` — soft cap per
  tier; OWNER alerts at 80%.
- `BOUNTIES_OWNER_REVIEW_THRESHOLD_USD` — review-queue
  threshold (default $100).
- `BOUNTIES_PER_USER_DAILY_CLAIM_CAP` — anti-grief cap on
  claim spam (default 5).

### 4.4 Mobile + console contract

Mobile reads `GET /api/bounties/coach/:coach_id` and writes
claims via `POST /api/bounties/:id/claim`. The claim body
carries an evidence reference (a `CommunityPost.id`, a
`CheckIn.id`, an `EventAttendance.id`, a referral code) plus
optional free-text. The platform validates the evidence
**reference** (does the row exist? does it belong to the
claiming user? was it created within the bounty's eligibility
window?).

Coach console reads/writes the same surface, plus the per-
bounty roster of claims, plus the per-coach payout ledger.

### 4.5 Files explicitly NOT touched

- `prisma/schema.prisma` — no edit in this PR.
- `prisma/migrations/` — no migration in this PR.
- `src/common/env-validation.ts` — env vars described, not
  registered.
- `app.module.ts` — no module wiring in this PR.
- `new-website` — out of scope; bounties are **not** marketed
  on the public site, since the marketing site is intentionally
  bounty-free to avoid sweepstakes-adjacent positioning.

---

## 5. WHO — sign-off, on-the-hook, downstream, hard boundaries

| Role | Person / artefact | What they decide |
|---|---|---|
| Founder | Bradley | Per-tier monthly cap; whether the OWNER review threshold is hard-blocked or warning-only above the threshold; whether bounties can apply to lapsed accounts (spec defaults: no). |
| Backend lead | (TBD) | Stripe credit mechanics — `coupon`-on-next-invoice vs `customer_balance` adjustment vs negative `Invoice` line item. Spec defaults to `customer_balance` (cleanest reconciliation). |
| Legal / compliance | (TBD) | Sign-off on §11 sweepstakes posture and the ToS update. **PR-1 cannot ship without this.** |
| Mobile | (TBD) | The evidence-attach UI shape; spec defaults to "pick from a list of recent eligible items". |
| Coach console | (TBD) | The award/reject UI shape; spec defaults to a per-bounty roster with one-click approve. |
| Pager | OWNER | First 30 days. The credit-application path is the highest-risk surface; double-application is the failure mode to avoid. |
| Hard boundaries | — | (a) **No sweepstakes / lotteries / chance-based prizes.** Every bounty is a completion-of-task-by-coach-criteria. (b) No member-to-member bounties. (c) No cash payout to a member's bank; the credit applies to the coach's invoice for that member. (d) No bounty above the per-tier cap. (e) `new-website` stays untouched. |

---

## 6. WHAT — already exists, net-new, non-goals

### Already exists (reused)

- `User`, `CoachProfile`, `CoachSubscription`, `Invoice`,
  `PaymentFailure`, `StripeProcessedEvent`, `AuditLog`.
- The throttler (PR #93).
- The Stripe `customer_balance` adjustment path (the platform
  already issues credits in a few flows; the bounties module
  formalises the path).
- The OWNER admin convention (`docs/admin-reports.md`) for
  the review queue.

### Net-new

- Four tables (§8).
- Per-coach monthly cap predicate.
- Evidence-validation service.
- Stripe credit-application service (idempotent).
- OWNER review-queue surface.

### Non-goals

- Cash-out by member.
- Sweepstakes / chance-based prizes.
- Cross-coach bounty stacking.
- Auto-award-on-event (an `EventAttendance` does **not**
  auto-award the bounty in v1; the coach reviews and
  approves manually). A future PR can add an opt-in
  auto-award path with the OWNER review threshold acting as
  the brake.
- Tradeable points / leaderboard tokens / NFTs / crypto.
  Out of scope, period.
- Bounties for **non-members** (the surface is closed to
  members of the coach's roster only).

---

## 7. HOW — rollout plan + smallest first PR + feature flag

### 7.1 Rollout phases

| Phase | What lands | Flag state |
|---|---|---|
| PR-1 | Schema (additive); `GET /api/bounties/coach/:id` returns `[]`; module wired but unreachable. | `BOUNTIES_ENABLED=false`. |
| PR-2 | Coach can create a `Bounty` row (no claim path yet). Read returns the coach's own bounties. | Flag on for staging; off for prod. |
| PR-3 | Member can `claim` a bounty with evidence; the claim sits in `pending`. Coach sees the claim in the console. | Flag on for one beta coach in prod. |
| PR-4 | Coach `award`/`reject` paths; the credit-application service writes `BountyPayout` + adjusts `customer_balance`. | Flag on for ≤5 beta coaches. |
| PR-5 | OWNER review queue; the per-coach monthly cap predicate; PostHog telemetry; weekly OWNER report row. | Flag on for L2/L3. |
| PR-6 | Console moderation (delete bounty, refund payout via reverse-credit, audit-log every action). | GA. |
| PR-7 | Optional: an opt-in auto-award path for narrowly-defined bounties (e.g. "claim the bounty exactly when your check-in streak reaches 30") with strict idempotency + OWNER review threshold. | GA. |

### 7.2 Smallest first PR

**PR-1** ships:

- Schema additions in §8.
- `bounties.module.ts` registered behind the flag.
- `GET /api/bounties/coach/:coach_id` returns `[]` when the
  flag is off.
- Smoke assertion: route mounted + 200 + `[]`.
- OpenAPI export update.
- A new section in `docs/audit-and-gdpr.md` declaring the
  sweepstakes posture (drafted in this PR's spec; the
  runbook line lands with PR-1's audit-doc edit).

PR-1 carries no claim path, no Stripe call, no OWNER review.

### 7.3 Feature flags

- `BOUNTIES_ENABLED` — required for PR-1.
- All other flags listed in §4.3 land alongside the PR that
  needs them, never earlier.

---

## 8. Data model sketch (additive Prisma; **not** migrated here)

```prisma
model Bounty {
  id                       String   @id @default(uuid())
  coach_id                 String
  coach                    User     @relation("BountyCoach", fields: [coach_id], references: [id])
  title                    String                  // ≤ 200 chars
  description              String                  // ≤ 4 KB; the criteria the member must meet
  reward_kind              String   @default("coach_credit") // "coach_credit" only in v1
  reward_amount_cents      Int                     // > 0; ≤ BOUNTIES_MAX_REWARD_PER_BOUNTY_USD * 100
  evidence_kinds           String[]                // ["community_post","check_in","event_attendance","referral_code","manual"]
  eligibility_starts_at    DateTime
  eligibility_ends_at      DateTime?               // null = open-ended
  per_member_cap           Int      @default(1)    // each member can claim N times
  total_claims_cap         Int?                    // null = uncapped
  status                   String   @default("active") // "active"|"paused"|"closed"
  acted_by_member_user_id  String?                 // PR #118
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  claims                   BountyClaim[]

  @@index([coach_id, status, eligibility_ends_at])
}

model BountyClaim {
  id                       String   @id @default(uuid())
  bounty_id                String
  bounty                   Bounty   @relation(fields: [bounty_id], references: [id], onDelete: Cascade)
  coach_id                 String                  // denormalised tenancy axis
  user_id                  String
  user                     User     @relation("BountyClaimUser", fields: [user_id], references: [id])
  evidence_kind            String
  evidence_id              String?                 // FK-by-string into the cited row
  evidence_note            String?                 // ≤ 2 KB
  status                   String   @default("pending") // "pending"|"awarded"|"rejected"|"voided"
  rejection_reason         String?
  reviewed_by_user_id      String?                 // coach.id when awarded/rejected
  reviewed_at              DateTime?
  acted_by_member_user_id  String?                 // PR #118
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  payout                   BountyPayout?

  @@unique([bounty_id, user_id, evidence_kind, evidence_id]) // anti-double-claim
  @@index([coach_id, user_id, status])
  @@index([bounty_id, status, created_at])
}

model BountyPayout {
  id                       String   @id @default(uuid())
  claim_id                 String   @unique
  claim                    BountyClaim @relation(fields: [claim_id], references: [id], onDelete: Cascade)
  coach_id                 String
  user_id                  String
  amount_cents             Int
  stripe_customer_id       String                  // the member's Stripe customer (for the coach's invoice)
  stripe_balance_txn_id    String                  // idempotency anchor on Stripe
  status                   String   @default("pending") // "pending"|"applied"|"reversed"
  applied_at               DateTime?
  reversed_at              DateTime?
  reversal_reason          String?
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  @@index([coach_id, status, applied_at])
}

model BountyPayoutReviewQueue {
  id                String   @id @default(uuid())
  payout_id         String   @unique
  payout            BountyPayout @relation(fields: [payout_id], references: [id], onDelete: Cascade)
  coach_id          String
  amount_cents      Int
  threshold_cents   Int                       // copy of BOUNTIES_OWNER_REVIEW_THRESHOLD_USD * 100 at write
  status            String   @default("queued") // "queued"|"approved"|"rejected"
  decision_by_user_id String?                 // OWNER user
  decision_at       DateTime?
  created_at        DateTime @default(now())

  @@index([status, created_at])
}
```

### 8.1 Schema notes

- `Bounty.reward_kind` is a closed-vocab string — only
  `"coach_credit"` in v1. Adding `"comp_event_seat"` or
  `"comp_call_minute"` later is a one-line allow-list change.
- `BountyClaim` unique on
  `(bounty_id, user_id, evidence_kind, evidence_id)` is the
  anti-double-claim invariant. A member who tries to claim the
  same bounty against the same evidence row twice gets a 409.
- `BountyPayout.stripe_balance_txn_id` is the idempotency
  anchor — the Stripe API call that adjusts
  `customer_balance` returns a transaction id; we store it.
  Re-running the application path checks the column first.
- `BountyPayout.status='reversed'` is the refund posture: a
  rejected-after-award claim writes a reverse credit (positive
  `customer_balance` adjustment) and stores the new
  `stripe_balance_txn_id` in a separate row; the original row
  flips to `reversed`.
- `BountyPayoutReviewQueue.threshold_cents` is captured at
  write-time so a subsequent threshold change does not retro-
  bypass the queue.

---

## 9. API sketch (routes + envelope + throttling)

### 9.1 Read

```
GET /api/bounties/coach/:coach_id?status=&cursor=
  → 200 { bounties: BountyEnvelope[], next_cursor: string|null }
  → 423 { error: "feature_locked" }
```

```
GET /api/bounties/:id
  → 200 { bounty: BountyEnvelope, my_claim: BountyClaimEnvelope | null }
```

### 9.2 Write — coach

```
POST /api/bounties
  body: { title, description, reward_amount_cents, evidence_kinds,
          eligibility_starts_at, eligibility_ends_at?, per_member_cap?, total_claims_cap? }
  → 201 { bounty }
  → 422 { error: "validation_failed" }
  → 423 { error: "feature_locked" }
```

Throttle: `5/hour/coach`. Cap enforcement: per-coach monthly
cap is checked at create + at each award; create-time check
is "if this bounty's `reward_amount_cents * total_claims_cap`
would exceed the remaining cap, refuse with
`monthly_cap_exceeded`".

```
PATCH /api/bounties/:id
  body: { title?, description?, status?, total_claims_cap?, eligibility_ends_at? }
  → 200 { bounty }
```

A bounty in `closed` cannot be re-opened (one-way state).

### 9.3 Write — member

```
POST /api/bounties/:id/claim
  body: { evidence_kind, evidence_id?, evidence_note? }
  → 201 { claim }
  → 409 { error: "already_claimed" }
  → 422 { error: "evidence_invalid" }
  → 423 { error: "not_eligible" }
  → 429 { error: "rate_limited" }
```

The evidence-validation service runs:
1. Confirm the cited row exists, belongs to the claiming
   `user_id`, and was created in the bounty's eligibility
   window.
2. Confirm the per-member cap is not exceeded.
3. Confirm the total-claims cap is not exceeded (atomic: the
   service reserves a slot via a unique constraint).
4. Write `BountyClaim` with `status='pending'`.

### 9.4 Award / reject — coach

```
POST /api/bounties/:id/award
  body: { claim_id }
  → 200 { claim: { status: "awarded" }, payout: { status: "pending" | "applied" | "queued" } }
  → 422 { error: "claim_not_pending" }
  → 423 { error: "monthly_cap_exceeded" }
```

The award path is **transactional**:
1. Flip the claim to `awarded`.
2. Insert a `BountyPayout` row.
3. If the `reward_amount_cents >= BOUNTIES_OWNER_REVIEW_THRESHOLD_USD * 100`,
   insert a `BountyPayoutReviewQueue` row with `status='queued'`
   and **stop** — the credit is **not** applied to Stripe yet.
4. Otherwise, call Stripe's `customer_balance` adjustment
   with the payout id as the idempotency key; on success,
   flip the payout to `applied`.

```
POST /api/bounties/:id/reject
  body: { claim_id, reason }
  → 200 { claim: { status: "rejected", rejection_reason: string } }
```

### 9.5 OWNER review queue

```
GET /api/admin/bounties/review-queue?status=queued
  → 200 { queue: BountyReviewEnvelope[] }
```

```
POST /api/admin/bounties/review-queue/:id/approve
  → 200 { queue_row: { status: "approved" }, payout: { status: "applied" } }
```

The OWNER approval triggers the same Stripe call as the
auto-applied path; idempotency anchor is the payout id.

```
POST /api/admin/bounties/review-queue/:id/reject
  body: { reason }
  → 200 { queue_row: { status: "rejected" } }
```

The reject path leaves the claim flipped to `awarded` but the
payout in `pending` indefinitely (the OWNER's notes capture
the reason). A future PR adds a "void claim" path that flips
both the claim and the payout to `voided` and notifies coach
+ member.

### 9.6 Envelope

```ts
type BountyEnvelope = {
  id: string;
  coach_id: string;
  title: string;
  description: string;
  reward_amount_cents: number;
  evidence_kinds: string[];
  eligibility_starts_at: string;
  eligibility_ends_at: string | null;
  per_member_cap: number;
  total_claims_cap: number | null;
  total_claims_count: number;
  status: "active"|"paused"|"closed";
};

type BountyClaimEnvelope = {
  id: string;
  status: "pending"|"awarded"|"rejected"|"voided";
  rejection_reason: string | null;
  payout_status: "pending"|"applied"|"reversed"|"queued"|null;
  reviewed_at: string | null;
};
```

---

## 10. Media / replay storage

Bounties carry no media of their own. Evidence references
existing rows: `CommunityPost.id`, `CheckIn.id`,
`EventAttendance.id`, an `InviteCode.redemption.id`, or a
manual free-text note (`evidence_kind='manual'` — the coach
audits this themselves and approves at their discretion).

The bounties surface deliberately does **not** introduce a
new media plane; that keeps the storage cost model tight and
keeps the abuse surface narrow (no upload, no transcript, no
moderation).

---

## 11. Sweepstakes / lottery posture (legal)

**Bounties are completion-of-task contracts, not sweepstakes.**

A sweepstakes (or lottery, or raffle) is regulated in most
jurisdictions because the prize is awarded by **chance**. The
bounties surface is regulated differently because the prize is
awarded by **completion of a coach-defined task** — the same
legal posture as a referral program, a transformation contest
where every qualifying entry wins, or a "post your before-and-
after, get the reward" promotion.

To keep the surface on the safe side of that line, the spec
forbids:

- **Random selection.** The platform cannot ship a "draw a
  random member who completed the task and award them" path.
- **Chance-based eligibility.** Every bounty's eligibility
  predicate must be deterministic ("posted by date X",
  "attended event Y", "redeemed code Z"). No "first 100" — that
  is sweepstakes-adjacent because not every qualifier wins.
- **Purchase-as-entry.** Members on a coach's roster are
  members regardless of bounty existence; the bounty is not a
  "buy more, win more" loop.
- **Marketing as a sweepstakes.** Coach console and mobile copy
  must use "complete this, get this" language. The platform's
  ToS update declares the surface non-sweepstakes; copy that
  contradicts the ToS is rejected at the spec level (the
  controller does not enforce copy, but the design review
  does).

The OWNER review queue is the second backstop: any bounty
above the threshold gets human review. This is not legally
required but is good operational hygiene.

The Terms of Service update lands with PR-1's
`docs/audit-and-gdpr.md` edit (the runtime PR adds the
section; the spec records the wording).

---

## 12. Member-only access + RBAC + privacy

| Concern | Posture |
|---|---|
| Authentication | `JwksAuthGuard` on every route. |
| Tenancy axis | `coach_id` on every row. Cross-coach reads return 403. |
| Entitlement gate | Per-coach via `SubscriptionGuard`. Per-member via the entitlement bundle (the member's tier must include bounties; otherwise `feature_locked`). |
| GDPR | All four tables in the per-table retention matrix (PR #120 lane #04). Account-deletion scrub: tombstones claim, hard-deletes evidence note, **preserves** the financial ledger row (`BountyPayout`) for the legally-mandated retention window (default 7 years per the existing finance posture). |
| PII | Evidence notes are free-text; the platform never indexes them for search; the coach + OWNER are the only readers. |
| Audit-log | Every `POST /bounties`, `claim`, `award`, `reject`, OWNER queue action writes one row through `AuditService.write` with a new `bounty_*` action prefix. |
| Anti-fraud | Per-user daily claim cap (§4.3). Per-coach monthly cap. OWNER review threshold. The `(bounty_id, user_id, evidence_kind, evidence_id)` unique anti-double-claim. |

---

## 13. AI governance

Bounties have no AI surface in v1. The AI Business Copilot
([`ai-business-copilot.md`](./ai-business-copilot.md)) **suggests**
bounty ideas to the coach (e.g. "your retention is dipping,
consider a 30-day check-in bounty for $25"); the coach reviews
and creates manually. The copilot never writes a `Bounty` row
directly.

Why no AI award path: the OWNER review threshold and the
fraud floors are easier to reason about with a human in the
loop. PR-7 (auto-award) is opt-in only and requires the
coach to whitelist the deterministic predicate; an AI cannot
auto-award.

---

## 14. Feature flags + entitlements

| Flag | Default | Gates |
|---|---|---|
| `BOUNTIES_ENABLED` | off | Whole module. |
| `BOUNTIES_MAX_REWARD_PER_BOUNTY_USD` | $500 | Hard ceiling at create. |
| `BOUNTIES_MAX_MONTHLY_PAYOUT_PER_COACH_USD` | per-tier | Soft cap; OWNER alerts at 80%. |
| `BOUNTIES_OWNER_REVIEW_THRESHOLD_USD` | $100 | Review queue gate. |
| `BOUNTIES_PER_USER_DAILY_CLAIM_CAP` | 5 | Anti-grief. |
| Entitlement bundle | tier-gated | Bounties bundled at L2+. L1 returns `feature_locked`. |

Kill-switch: `fly secrets set BOUNTIES_ENABLED=false`. In-flight
claims sit in `pending`; the coach side surface returns the
empty envelope; no money moves.

---

## 15. Analytics + telemetry

PostHog events:

| Event | Properties |
|---|---|
| `bounty_created` | `coach_id`, `reward_amount_cents`, `evidence_kinds`, `total_claims_cap` |
| `bounty_claim_created` | `coach_id`, `bounty_id`, `evidence_kind` |
| `bounty_claim_awarded` | `coach_id`, `bounty_id`, `claim_id`, `reward_amount_cents` |
| `bounty_claim_rejected` | `coach_id`, `bounty_id`, `claim_id`, `rejection_reason_class` |
| `bounty_payout_applied` | `coach_id`, `payout_id`, `amount_cents` |
| `bounty_payout_reversed` | `coach_id`, `payout_id`, `reason_class` |
| `bounty_review_queue_decision` | `coach_id`, `decision`, `amount_cents` |

OWNER metrics counter:

- `bounty_payouts_30d_total_cents_per_coach`.
- `bounty_payouts_30d_total_cents_platform`.
- `bounty_review_queue_open`.
- `bounty_payout_reversal_rate_30d` (red-flag if > 5%).

The weekly recap (PR #121 spec #23) reads
`bounty_payout_applied` and surfaces "you earned $50 in
rewards from your coach this week"; this is the highest-
intent retention message in the recap.

---

## 16. Tests, risks, dependencies, acceptance, operator handoff

### 16.1 Tests

- **Unit**: cap predicate at create + award; per-user daily
  claim cap; the unique constraint on
  `(bounty_id, user_id, evidence_kind, evidence_id)`; the
  evidence-validation matrix.
- **Integration**: every route in §9 against a stubbed Stripe;
  the OWNER review queue flow; the reverse-credit (refund)
  path.
- **Smoke**: route mounted; returns `[]` when flag off.
- **Eval**: not applicable — no AI surface in v1.
- **Load**: concurrent claim writes against a bounty with a
  total-claims cap of 1; assert the unique constraint catches
  the second writer (no over-pay).
- **Stripe-replay**: PR #95-style replay smoke for the
  `customer_balance` adjustment idempotency. Reuses the
  pattern in `scripts/stripe-webhook-smoke-replay`.

### 16.2 Risks

- **Double-payout.** Stripe call + DB write are not atomic.
  Mitigation: idempotency key from the payout id; the post-
  call write checks the existing row.
- **Cap circumvention.** A coach pauses a bounty, then
  resumes it after the cap resets. Mitigation: cap is computed
  on `created_at` of the payout, not the bounty. A pause does
  not buy more cap.
- **Sweepstakes drift.** A coach writes copy that is
  sweepstakes-adjacent. Mitigation: copy review at design time;
  the OWNER review queue is the second backstop.
- **Evidence forgery.** A member references a foreign post
  id. Mitigation: evidence-validation confirms ownership
  (`row.user_id === claim.user_id`).
- **Reversal flood.** A coach awards then rejects in bulk.
  Mitigation: PostHog alert on `bounty_payout_reversal_rate_30d
  > 5%`; OWNER reads daily.
- **Cross-tenant leak.** A naive query across `coach_id` is
  caught by the integration test that asserts a foreign-coach
  token returns 403.
- **Account closure mid-payout.** A member whose account is
  scheduled for deletion has a pending payout. Mitigation:
  account-deletion scrub holds the payout if `status='pending'`
  and lets it apply (or void) before tombstoning the row.

### 16.3 Dependencies

- Internal: PR #117 (no direct dep), PR #118 (forward-compat),
  PR #120 (lanes #01, #03, #04, #05, #06, #11), PR #123 (#30,
  #31, #36 — natural redemption paths), `community-spaces.md`
  (evidence kind), `events-live-calls.md` (evidence kind),
  `ai-business-copilot.md` (suggestion writer).
- External: Stripe (already in use); legal review for the ToS
  update.

### 16.4 Acceptance criteria

- A coach creates a $25 bounty for "post a transformation
  photo this month" with `evidence_kinds=['community_post']`.
  A member posts and claims; the coach awards; the payout
  applies as a $25 credit on the member's next coach
  invoice, idempotently. The OWNER metrics counter reflects
  the $25 in `bounty_payouts_30d_total_cents_platform`.
- A bounty above $100 routes to the OWNER review queue
  before applying; the OWNER approval applies the credit.
- A member cannot claim the same bounty twice against the
  same evidence row.
- A revert is a Fly secret flip; in-flight claims sit in
  `pending`; no money moves while the flag is off.

### 16.5 Operator handoff

- **Runbook entry:** `docs/operations/bounties.md` (a future
  doc) covers the cap predicate, the OWNER review queue, the
  reversal path, and the legal posture in §11.
- **Dashboard tiles:** payouts-30d-per-coach, review-queue-
  open, reversal-rate-30d, cap-utilization-per-coach.
- **Kill-switch:** `fly secrets set BOUNTIES_ENABLED=false
  -a tgp-backend-prod`. In-flight claims stay `pending`.
- **First 30 days:** OWNER reads `bounty_payout_reversal_rate_30d`
  daily; any value > 5% is the on-call signal.

---

## Decisions that must close before PR-1

1. Stripe credit mechanic (`customer_balance` vs
   `coupon`/`promotion_code` vs negative invoice line item).
   Spec defaults to `customer_balance`. (Backend lead.)
2. Per-tier monthly cap defaults (spec defaults: L1 $0, L2
   $100, L3 $500). (Founder + PR #120 lane #05.)
3. OWNER review threshold ($100 default). (Founder.)
4. ToS section wording for the sweepstakes posture. (Legal.)
5. Whether a manual evidence note is allowed (spec defaults:
   yes, with the coach approving at discretion). (Founder.)
6. Whether the auto-award path (PR-7) ships at GA or stays
   parking-lot. Spec defaults: parking-lot. (Backend lead.)
