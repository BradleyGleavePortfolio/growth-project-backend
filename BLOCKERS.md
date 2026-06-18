# BLOCKERS — TM-14 (PR #436) fixer-pass-1

## B-P2-2 — `payload jsonb` column omitted from `MarketplaceConnectEvent` [OPERATOR DECISION]

**Status:** Resolved under the operator's default decision (DECLINE raw payload
storage). Documented; not blocking the push timeline.

**Question for operator (verbatim):**
> TM-14 migration omits the `payload jsonb` column from `marketplace_connect_event`.
> Lens B flagged this as contract-divergence-from-brief. The omission improves PII
> posture (no raw Stripe Account blob stored). Do you want me to (a) keep the
> omission and update the brief / add an ADR documenting the decision, or (b) add
> the column?

**Decision taken (per fixer dispatch — operator default):** **(a) DECLINE raw
payload storage.**

Reason: the PII/secret blast radius of persisting a raw Stripe `Account` blob
(legal name, DOB, address, ID/bank metadata, `requirements` verification state)
outweighs the observability gain. The idempotency key (`stripe_event_id` PK) plus
the minimal projected fields (`type`, `stripe_account_id`, `coach_user_id`,
`onboarding_completed`, `processed_at`) are already sufficient for attribution,
dedup, and audit trail. Stripe remains the system of record for the full event
body (re-fetchable by event id).

**Artifacts:**
- ADR: `docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md` (problem,
  options A/B/C, decision, consequences, reversibility).
- Inline comment in
  `prisma/migrations/20261220000030_marketplace_connect_event/migration.sql`
  pointing to the ADR.

**No `payload jsonb` column was added.** The existing migration `20261220000030`
is left as-is (not renumbered). If the operator overrides to option (b), it is a
single additive, later-dated migration — no rewrite of `20261220000030` required.

---

No other blockers. All remaining Lens B findings (B-P2-1, B-P2-3, B-P3-1) are
resolved in code. Lens B P3-2 and P3-3 were explicit "no action" / "positive
note" items per the audit report.
