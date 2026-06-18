# ADR — TM-14: Do Not Store Raw Stripe `account.updated` Payload in the Connect-Event Ledger

- **Status:** Accepted
- **Date:** 2026-06-17
- **Decision owner:** Bradley Gleave (repo owner)
- **Implementation PR:** #436 — `feat/tm-14-connect-account-updated-webhook`
- **Audit finding resolved:** B-P2-2 (Lens B, `TM-14-audit-B-d5a611d.md`)
- **Affected table:** `MarketplaceConnectEvent`
  (`prisma/migrations/20261220000030_marketplace_connect_event/migration.sql`)

## Context

The original TM-14 lane brief listed a `payload jsonb` column among the
expected columns of the `MarketplaceConnectEvent` ledger — the intent being
to retain the full Stripe `account.updated` event body for replay and
debugging.

The shipped table omits that column. It persists only:

| Column                 | Purpose                                                    |
| ---------------------- | --------------------------------------------------------- |
| `stripe_event_id` (PK) | Idempotency anchor — a redelivered event loses the PK race |
| `type`                 | The Stripe event type (`account.updated`)                 |
| `stripe_account_id`    | The connected account id (`acct_...`)                     |
| `coach_user_id`        | Resolved from the Connect mirror; nullable                |
| `onboarding_completed` | Derived signal (charges_enabled && payouts_enabled)       |
| `processed_at`         | Audit-trail timestamp (DB default `CURRENT_TIMESTAMP`)    |

Lens B flagged the divergence-from-brief as a P2 and explicitly noted the
shipped shape is *"arguably better for PII posture"* and *"a deliberate,
defensible design choice"* — not a defect. No spec or downstream consumer
depends on a raw-payload column.

## Problem

A Stripe `Account` object embedded in an `account.updated` event is a large,
PII- and secret-bearing blob. It can include the business owner's legal name,
date of birth, address, government-ID metadata, bank-account fingerprints,
`requirements`/`future_requirements` containing sensitive verification state,
and tokens/ids that widen the blast radius of any future read of this table.

Persisting that blob verbatim in an application table means:

1. **Blast radius.** Any future bug, over-broad RLS policy change, or
   service-role credential leak exposes raw KYC/banking PII, not just a
   boolean and a couple of ids.
2. **Compliance surface.** Raw payment-onboarding PII at rest expands the
   PCI/GDPR/data-retention footprint and the set of tables that must be
   considered in any data-subject deletion or breach assessment.
3. **Retention drift.** A jsonb dumping ground accumulates fields nobody
   chose to store, indefinitely, with no schema review gate.

## Options considered

- **(A) Store only the derived signal + identifiers (SHIPPED).** Minimal,
  attributable, idempotent. Replay/debug relies on Stripe as the system of
  record (the event is re-fetchable from the Stripe Dashboard/API by
  `stripe_event_id`) plus our own structured logs.
- **(B) Add `payload jsonb`.** Maximal local debuggability, at the cost of
  storing raw KYC/banking PII at rest in an application table.
- **(C) Store a redacted/projected jsonb subset.** A middle path, but it
  re-introduces a schema-less column, requires a redaction allow-list that
  must be maintained as Stripe evolves the Account shape, and still risks
  drift. The structured columns in (A) already are the curated projection.

## Decision

**Adopt Option (A): do not add a `payload jsonb` column.** Store only the
derived `onboarding_completed` boolean and the minimal identifying fields.
Stripe remains the system of record for the full event body; debugging and
replay use `stripe_event_id` against Stripe plus our structured logs.

## Consequences

- **Positive:** Smallest possible PII/secret footprint at rest; narrowest
  breach/compliance surface; the ledger contains nothing a client principal
  could exploit even if RLS regressed (it is also RESTRICTIVE deny-all +
  service-role-only). Idempotency and attribution are fully preserved.
- **Negative / trade-off:** No local copy of the raw event. If we ever need
  to reconstruct the exact bytes Stripe sent (e.g. a forensic replay), we
  must fetch from Stripe by event id rather than read our own table. This is
  acceptable: Stripe retains events and is the authoritative source.
- **Reversibility:** Additive. If a concrete future need for the raw payload
  emerges, it can be introduced as a *new, dated* migration (after the
  current floor) with an explicit redaction/retention policy — without
  rewriting `20261220000030`.

## Status of the audit finding

B-P2-2 is resolved by this ADR: the omission is an intentional,
documented design decision, not an oversight. An inline comment pointing to
this ADR has been added to the migration. No `payload jsonb` column is added.
