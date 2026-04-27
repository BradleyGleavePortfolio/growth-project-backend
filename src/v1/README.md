# v1 (coach console BFF)

Backend-for-frontend for the `tgp-coach-console` web app. Path layout
mirrors `tgp-coach-console/INTEGRATION_NOTES.md` exactly so the console
can target this origin without a translation shim.

## Purpose

- Serve the coach console with single-round-trip, console-shaped
  payloads (camelCased, presence-enriched, draft-aware).
- Gate every write on subscription state via `SubscriptionGuard` so a
  past-due / canceled coach cannot continue sending messages.
- Bridge the OWNER role: an OWNER can pass through these routes acting
  as themselves, or read another coach's data by id (the COACH role
  cannot).
- Persist message drafts (one per coach × client) so the console can
  autosave compose state.

## Key files

| File | What it owns |
|---|---|
| `v1-coach.controller.ts` | `/v1/coach/me/*` HTTP surface |
| `v1-coach.service.ts` | Console-shaped reads, send + draft writes, role-aware coach scoping |
| `v1-coach.dto.ts` | Class-validator DTOs for the send-message and save-draft bodies |
| `v1.module.ts` | Wires the BFF; imports `BillingModule` so `SubscriptionGuard` resolves |

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/v1/coach/me` | Coach identity + branding + subscription summary |
| `GET` | `/v1/coach/me/clients` | Console roster (presence, adherence, risk) |
| `GET` | `/v1/coach/me/threads` | Thread list with last message preview and unread counts |
| `GET` | `/v1/coach/me/threads/:clientId` | One thread + draft |
| `POST` | `/v1/coach/me/threads/:clientId/messages` | Send a message; subscription-gated |
| `GET` | `/v1/coach/me/threads/:clientId/draft` | Read the persisted draft |
| `POST` | `/v1/coach/me/threads/:clientId/draft` | Upsert draft (autosave); subscription-gated |

## Role gating

`resolveCoachId(caller, requested?)` is the pivot:

- OWNER may pass any `coachId` (or omit it; defaults to caller).
- COACH must act as themselves; passing a foreign id returns 403.
- Anything else: 403.

This is the only place tenancy on the BFF is enforced — every method
calls into `resolveCoachId` first, so adding a new endpoint that skips
it would be a tenancy regression visible in code review.

## Subscription gating

`SubscriptionGuard` is mounted on the two write paths
(`POST .../messages`, `POST .../draft`). OWNER bypasses; COACH
behavior follows the matrix described in
[`../billing/README.md`](../billing/README.md).

Drafts are explicitly behind the same guard as sends — a canceled
coach cannot accumulate compose state for messages they will never be
allowed to send. Console UX hides the compose box in this case; the
guard is the server-side enforcement.

## Throttling

- `POST .../messages`: 30 / minute / caller.
- `POST .../draft`: 120 / minute / caller (autosave can fire once per
  keystroke debounce).

## Drafts

Drafts are stored in `MessageDraft` keyed by
`(coach_id, client_id)` (`MessageDraft_coach_client_key`). One draft
per pair; upsert is idempotent. The send path clears the draft as
part of the same transaction so the console is not left holding stale
text after a successful send.

## Security and tenancy rules

- The OWNER bypass on `resolveCoachId` is the platform-admin escape
  hatch. There is no per-row owner check — OWNER is trusted globally.
- `getThread` returns 404 for foreign clients rather than 403 to avoid
  leaking the existence of clients on another coach's roster.
- Send / draft DTOs are class-validator-bounded; the global validation
  pipe runs in whitelist + forbid-non-whitelisted mode so unknown fields
  fail closed.
- `SubscriptionGuard` is layered on top of `JwtAuthGuard +
  CoachOrOwnerGuard`. Defense in depth: a routing change that drops one
  guard should not silently bypass billing.

## Environment variables

This module relies only on the platform-wide secrets and the Stripe
vars consumed by `SubscriptionGuard` (see
[`../billing/README.md`](../billing/README.md)).

## Failure modes

- COACH passing a different coachId → 403 immediately, no DB read.
- OWNER targeting a non-coach user id → `Coach not found` 404.
- `SubscriptionGuard` denies in enforce mode → 403 with
  `SUBSCRIPTION_*` error code; the console renders the corresponding
  empty state.

## Tests

| File | Covers |
|---|---|
| `test/v1-coach.service.spec.ts` | OWNER bypass, COACH scoping, send/draft persistence, presence/risk synthesis |

## Operational notes

- Path `tgp-coach-console/INTEGRATION_NOTES.md` is the contract source
  of truth — it lives in the console repo. When this file and that
  one disagree, the console wins (the route is owned by the consumer).
- `MessageDraft` rows persist across logouts and devices; the console
  expects the read on thread open to return the freshest body.
