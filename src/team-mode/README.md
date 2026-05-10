# Team Mode (runtime)

Implementation of ADR-0001 Team Mode foundation, with §10 product
questions resolved on 2026-05-10.

## Files

- `team-mode.controller.ts` — REST surface at `/team/*`. All routes
  guarded by `JwtAuthGuard + CoachGuard`. Tier gate enforced inline.
- `team-mode.service.ts` — assign / remove / list sub-coaches plus
  curated audit feed reads. Single source of truth for the
  transactional behaviour described in ADR §10a Q3.
- `team-mode.dto.ts` — class-validator DTOs.
- `team-mode.module.ts` — Nest module wiring.
- `tier-resolver.service.ts` — maps `CoachSubscription.stripe_price_id`
  to `growth | pro | enterprise | unknown` via env vars.

## Locked decisions (ADR §10a)

| # | Topic | Resolution |
|---|-------|------------|
| Q1 | Staff seat billing | Pro: paid Stripe seat. Enterprise: included. Growth: blocked. |
| Q2 | Sub-coach relations | Many-to-2 head coaches. Service guard + DB trigger. |
| Q3 | Removal | Auto-reassign clients to initiating head coach in one transaction. |
| Q4 | Audit log | 15 curated event_kinds (see `TeamAuditEventKind` enum). Not a CRUD firehose. |
| Q5 | Sub-coach invites | Allowed. Attribution via `InviteCode.invited_by_user_id`. |
| Q6 | Tier gate | Pro and Enterprise allowed. Growth and unknown blocked. |

## Required env vars

- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_PRO`
- `STRIPE_PRICE_ENTERPRISE`
- `STRIPE_PRICE_STAFF_SEAT` (Pro paid seat recurring price id)

When `STRIPE_SECRET_KEY` is unset OR `STRIPE_PRICE_STAFF_SEAT` is
unset, the assignment service still creates the local row + audit
events but logs a warning and skips the outbound Stripe call. This
keeps preview deploys functional. Production must set all four.
