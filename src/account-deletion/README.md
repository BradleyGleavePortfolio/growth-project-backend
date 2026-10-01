# account-deletion — in-app account deletion and erasure

Apple App Store guideline 5.1.1(v) requires that an account can be deleted
from inside the app, and that the deletion actually completes. This module
owns the whole lifecycle: request (with a fresh re-auth), a cancellable grace
period, and a nightly finalization that erases the person's data.

## Operator policy (defaults set 2026-10-01)

1. **Retention.** When deletion finalizes, all personal data is deleted or
   irreversibly scrubbed: profile, consultation intake, logs, wearables
   samples, Roman transcripts, messages, community posts/DMs/voice notes,
   storage objects, push tokens and the analytics identifiers we control.
   Only what the law requires is retained: payment and tax records held by
   Stripe (our local mirrors keep amounts, dates and Stripe ids only, attached
   to the tombstone id), and one non-identifying deletion audit row (random
   id, timestamp, outcome).
2. **Coach handoff.** When a coach deletes, their clients are detached
   (`User.coach_id = null`), not deleted. Clients keep their own data and the
   plans they were assigned (frozen, owned by the tombstone id), and the app
   shows a neutral "your coach is no longer available" state. A sub-coach may
   delete their own account.
3. **Billing.** Finalization cancels every live Stripe subscription the
   person pays or is paid for (coach subscription, client purchases on either
   side, guest checkouts), cancels pending drip drops, and the drip
   dispatcher refuses drops whose client or coach is deleted. Push tokens are
   cleared and notification rows deleted, so nothing further is sent.
4. **Apple.** If `APPLE_SIGNIN_KEY_ID` / `APPLE_SIGNIN_PRIVATE_KEY` are
   missing (true in production until the owner creates the key), deletion
   still completes; the outcome `not_configured` is logged, written to
   `deletion_audit` and returned as `apple_revocation`. The app only says
   Apple access was revoked when the server reports `revoked`; otherwise it
   tells the person they can also remove the app from their Apple ID
   settings. Set the key with the operator workflow
   `.github/workflows/fly-apple-signin-set.yml` (docs/deploy-runbook.md §7b.1).
5. **Google re-auth** works for Google accounts even though Google sign-in is
   off for new signups: `POST /auth/recent-auth-token` accepts
   `provider: 'google_session'` with the access token of a Supabase session
   created by a Google OAuth sign-in moments ago (see "Re-auth" below).

## Endpoints

| Method | Path                         | Auth                                      | Response                            |
| ------ | ---------------------------- | ----------------------------------------- | ----------------------------------- |
| `POST` | `/me/delete-account`         | Bearer (any role) + `X-Recent-Auth-Token` | `DeletionScheduledResponse`         |
| `GET`  | `/me/delete-account/confirm` | Bearer (any role), legacy email link      | `{ message, purge_after }`          |
| `POST` | `/me/delete-account/cancel`  | Bearer (any role)                         | `{ message }`; 409 while finalizing |
| `GET`  | `/me/delete-account/status`  | Bearer (any role)                         | `DeletionStatus`                    |
| `POST` | `/admin/users/:id/delete`    | Bearer, `owner` role                      | `{ message }`                       |

"Any role" means no `@Roles` decorator: `JwtAuthGuard` authenticates and the
service scopes every call by `req.user.id` (B-608-7, sub-coaches included).

`DeletionStatus`: `state` (`none` | `requested` | `confirmed` | `deleted`),
`requested_at`, `confirmed_at`, `grace_days`, `purge_after`, `completes_by`
(purge_after + 1 day: the nightly job runs once a day), `deleted_at`,
`cancellable`. `DeletionScheduledResponse` adds `already_scheduled`,
`message` and `apple_revocation` (`revoked` | `not_configured` |
`not_requested` | `exchange_failed` | `revoke_failed`).

After finalization the API answers 403 `{ code: 'ACCOUNT_DELETED' }` while
the old access token is still valid; the app treats that as completion and
signs out.

## State machine and concurrency

```
NONE ──POST /me/delete-account (fresh re-auth)──► CONFIRMED ──cron, now >= purge_after──► DELETED
  ▲                                                  │
  └──────────── POST cancel (now < purge_after) ─────┘
REQUESTED (legacy email flow only) ──POST /me/delete-account──► CONFIRMED (requested_at kept)
Admin: any state ──POST /admin/users/:id/delete──► DELETED
```

- Every transition locks the `User` row (`SELECT … FOR UPDATE`). Requests wait
  for the lock, so concurrent requests serialize and only the winner calls
  Apple. Cancel and finalization use `SKIP LOCKED`: a cancel that meets a
  running finalization gets 409; a second cron worker skips the row.
- `deletion_confirmed_at` is the schedule version. The cron passes the value
  it saw; if a cancel or re-request changed it, finalization skips
  (`rescheduled`). Due means `now >= purge_after`; cancellable means
  `now < purge_after`, so the two never overlap.
- Lifecycle audit rows are written in the same transaction as the transition
  they describe; a failed audit write rolls the transition back.

## Finalization (one transaction, 120 s timeout)

1. Collect storage objects (voice notes and voice-message files, the
   `${userId}/` voice prefix, coach media on Supabase and Mux, Supabase
   bloodwork attachments, local data-export archives) and live Stripe
   subscription ids.
2. Remove the objects and cancel the subscriptions. Any failure throws, the
   transaction rolls back and tomorrow's run retries (object removal and
   Stripe cancellation are idempotent).
3. Tombstone the `User` row: email `deleted-<id>@tombstone.invalid`, name
   "Deleted user", phone, coach link, push token, leaderboard name, signup
   ref and payout method cleared, `deleted_at` set.
4. Run the erasure manifest (`account-deletion.manifest.ts`).
5. Delete the person's `deletion_audit` rows and insert one outcome row with a
   random subject id (no email, IP or user agent).
6. After commit, remove the Supabase auth identity. A returned or thrown
   error is logged, recorded as `auth_identity_cleanup_failed`, and retried
   by every nightly run until it succeeds (`supabase_id` becomes
   `deleted-<id>` once removed). "Not found" counts as removed.

## Erasure manifest

The `User` row is tombstoned, never deleted, so no `onDelete: Cascade` fires.
`ERASURE_MANIFEST` lists an explicit decision (delete, update/scrub, or
retain with a reason) for every column in `prisma/schema.prisma` that can
hold a user id or a copy of the person's email.
`test/account-deletion/erasure-manifest-coverage.spec.ts` parses the schema
and fails if a User relation, user-id-like column or email column has no
entry, if an entry names a missing model/field, or if executing the manifest
against a seeded store leaves the person's id behind (outside documented
retention) or changes anyone else's rows. Adding a table that stores user data
therefore requires adding a manifest entry in the same PR.

Retained rows (all keyed only by the tombstone id): finance mirrors (Invoice,
ConnectAccount, ClientPurchase deactivated, SplitLedgerEntry, ConnectTransfer,
PartialRefundDecision, CoachCreditPackPurchase, CoachAIBudget,
MarketplaceConnectEvent), coach content a surviving client was assigned
(WorkoutPlan, WorkoutProgram and revisions, DailyMealPlan, MealTemplate,
coach MacroTarget, saved Recipes, completed Lessons, contract envelopes and
templates on the coach side, deactivated CoachPackage), and the Scout
insert-only import ledgers (digests only; a DB trigger refuses DELETE).

## Re-auth (`POST /auth/recent-auth-token`)

- Email accounts: `password`.
- Apple: a fresh Apple identity token (`provider: 'apple'`); the app also
  sends the authorization code to `/me/delete-account` for revocation.
- Google: `provider: 'google_session'`. The mobile app has no Google client id
  (sign-in is Supabase-brokered), so it runs the Supabase Google OAuth browser
  flow again and sends the new session's access token without storing that
  session. The server requires Supabase to accept the token (`getUser`), the
  token `sub` to equal the caller's `supabase_id`, a google provider on the
  identity, and an `amr` entry `{ method: 'oauth' }` newer than
  `RECENT_AUTH_TTL_MS`. The app's existing session keeps its original amr
  timestamp, so replaying it is refused.
- `provider: 'google'` (a Google-issued ID token) remains for clients that
  have a Google client id.

## Env vars

| Var                                                                                                                       | Default                      | Purpose                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DELETION_GRACE_DAYS`                                                                                                     | `14`                         | Days between scheduling and finalization.                                                                                  |
| `DELETION_FINALIZE_CRON`                                                                                                  | `0 3 * * *`                  | Nightly finalize job (03:00 UTC slot).                                                                                     |
| `APPLE_TEAM_ID`, `APPLE_SIGNIN_CLIENT_ID` (or first `APPLE_AUDIENCES`), `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY` | unset                        | Sign in with Apple token revocation. Missing → `not_configured`, deletion still completes.                                 |
| `SUPABASE_VOICE_BUCKET`, `SUPABASE_MEDIA_BUCKET`                                                                          | `voice-notes`, `coach-media` | Buckets purged at finalization.                                                                                            |
| `STRIPE_SECRET_KEY`, Mux credentials                                                                                      | —                            | Needed only if the person has live subscriptions or Mux assets; without them finalization fails closed, logs, and retries. |

## Tests

| File                                                      | Covers                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/account-deletion/lifecycle-races.spec.ts`           | Request/cancel/finalize state machine on an in-memory DB with row locks and rollback; Sol's six probes inverted (scrub failure rollback, Supabase returned error, fan-out failure, cancel after snapshot, re-request after snapshot, concurrent requests), cancel vs finalize 409, two cron workers, cutoff boundaries, non-identifying audit, admin delete, legacy link. |
| `test/account-deletion/erasure-manifest-coverage.spec.ts` | Schema coverage, entry validity, seeded execution (A erased, B byte-identical).                                                                                                                                                                                                                                                                                           |
| `test/account-deletion/storage-billing.spec.ts`           | Storage collection/purge and Stripe cancellation, fail-closed paths.                                                                                                                                                                                                                                                                                                      |
| `test/account-deletion/controller-roles.spec.ts`          | No role restriction on self endpoints (sub-coach), owner-only admin.                                                                                                                                                                                                                                                                                                      |
| `test/account-deletion/drip-fence.spec.ts`                | Drip dispatcher never selects drops for deleted accounts.                                                                                                                                                                                                                                                                                                                 |
| `test/auth-recent-auth-google-session.spec.ts`            | Google re-auth via a fresh Supabase OAuth session; replay refused.                                                                                                                                                                                                                                                                                                        |
| `test/account-deletion/apple-token-revocation.spec.ts`    | Apple revocation outcomes, including `not_configured`.                                                                                                                                                                                                                                                                                                                    |

## Residual risks

- Rows inserted by an unrelated in-flight request at the instant the
  finalization commits (for example a coach message to the deleted client)
  can survive until noticed; the tombstone blocks the account from any new
  activity.
- Coaches' free-text notes (for example `CoachDailyLog`) can mention a client
  by name; they belong to the coach and are not parsed.
- Bloodwork attachments on non-Supabase backends are client-supplied external
  links; the backend holds no bytes for them (the rows are deleted).
- Google re-auth depends on Supabase's `amr` timestamp semantics and on the
  Supabase Google provider staying enabled for existing users.
- The older `src/users/account.service.ts` deletion path
  (`deletion_scheduled_at`) is separate and unchanged.
