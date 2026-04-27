# Metrics & Instrumentation

This document describes the server-side metrics surface for the Growth
Project backend. There are two audiences:

- **Operators** running the platform (OWNER role) — use the
  `GET /api/admin/metrics` endpoint for authoritative counters from
  Postgres.
- **Product/growth analysts** — query PostHog for event-level data driven
  by the canonical event taxonomy in `src/analytics/events.ts`.

The two systems are intentionally redundant: PostHog gives you funnels,
cohorts, retention; the admin endpoint gives you a counter you can trust
even if PostHog drops events. They should agree.

## What we never report

The metrics surface is aligned to "investor-readable" reporting standards.
The following are **never** synthesized:

- Revenue or MRR figures from anything other than Stripe-mirrored
  `Invoice.amount_paid_cents`. No "expected value" math, no projections.
- Customer counts that include unverified, deleted, or seed users.
- Engagement metrics computed from a model output (e.g. AI-generated DAU).

If a number is reported, the row that produced it exists in Postgres.

## PostHog event taxonomy

All event names are defined in [`src/analytics/events.ts`](../src/analytics/events.ts).
Server-side capture goes through `AnalyticsService` (PII-stripping wrapper
around the PostHog Node SDK). When `POSTHOG_KEY` is unset the service is a
no-op — it is safe to ship instrumentation calls without provisioning the
key.

| Lane | Event | Distinct ID | Properties |
|---|---|---|---|
| Invite funnel | `invite_previewed` | `code:<GP-XXXXXX>` | (none) |
| Invite funnel | `invite_redeemed` | `userId` | `via`, `coach_id`, `legacy_invite_row?` |
| Signup | `user_registered` | `userId` | `role`, `provider="email"` |
| Signup | `user_registered_google` | `userId` | `role`, `provider="google"` |
| Signup | `user_signup_with_code` | `userId` | `had_invite_code`, `gate_enabled` |
| Coach | `coach_provisioned` | `coachUserId` | `provisioned_by_owner` |
| Coach | `coach_promoted` | `coachUserId` | `via` (`admin_promote` \| `become_coach`), `promoted_by_owner_id?` |
| Coach | `coach_action` | `coachUserId` | `action_type` (`archive_client` \| `unarchive_client` \| `post_guidelines`) |
| Billing | `subscription_updated` | `coachUserId` | `stripe_event_type`, `status`, `stripe_price_id`, `cancel_at_period_end`, `had_trial` |
| Billing | `subscription_canceled` | `coachUserId` | (none) |
| Billing | `invoice_paid` | `coachUserId` | `amount_paid_cents`, `currency` |
| Billing | `invoice_payment_failed` | `coachUserId` | `amount_due_cents` |
| AI | `ai_chat_invoked` | `userId` | `model_used` (`perplexity` \| `fallback`), `guardrails_applied_count`, `message_length`, `has_coach` |
| Messaging | `coach_message_sent` | `coachUserId` | `client_id`, `body_length` |
| Messaging | `client_message_sent` | `clientUserId` | `coach_id`, `body_length` |
| Client log | `client_food_logged` | `userId` | `meal_type` |

### PII handling

`AnalyticsService.capture()` strips a deny-list of PII keys (email, name,
phone, address, password, …) from the property bag before sending to
PostHog. `distinctId` is always our internal opaque user id, never an
email. The single exception is `invite_previewed` for anonymous public
preview lookups, where the distinct ID is the (non-PII, random)
`code:<GP-XXXXXX>` so PostHog can deduplicate previews of the same code.

## Admin metrics endpoint

`GET /api/admin/metrics?since_days=30` (OWNER-only) returns:

```json
{
  "window": { "since_days": 30, "since": "2026-03-28T00:00:00.000Z" },
  "users":     { "total": 120, "coaches": 8, "clients": 110, "new_in_window": 3 },
  "coach":     { "with_profile": 8 },
  "billing": {
    "active": 5,
    "trialing": 2,
    "past_due": 0,
    "canceled": 1,
    "invoices_paid_in_window": 3,
    "invoices_paid_amount_cents_in_window": 150000,
    "payment_failures_in_window": 2
  },
  "invites":  { "active_codes": 12, "redemptions_total": 25 },
  "activity": { "messages_in_window": 40, "food_logs_in_window": 220 },
  "ai":       { "users_with_profile": 110 }
}
```

All counters are computed via Prisma queries against rows that have
actually been written. The `since_days` query parameter is clamped to
`(0, 365]`; defaults to 30. Stripe-sourced figures (`invoices_paid_*`,
`payment_failures_in_window`) come from the webhook-mirror tables and
are the only money figures exposed.

## Validating the wiring

1. Set `POSTHOG_KEY` (and `POSTHOG_HOST` if not US cloud) in the running
   environment.
2. Trigger a known action — e.g. coach sends a message via
   `POST /api/coach/clients/:id/messages`.
3. Confirm the event appears in PostHog Live Events within ~10 seconds
   (the SDK is configured with `flushAt: 20, flushInterval: 10_000`).
4. Hit `GET /api/admin/metrics` as an OWNER and confirm the corresponding
   counter incremented.
