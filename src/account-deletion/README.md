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
   tells the person they can also remove the app from their Apple Account
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
| `POST` | `/admin/users/:id/delete`    | Bearer, `owner` role + `X-Recent-Auth-Token` (B-608-13) | `{ message }`         |
| `POST` | `/account-deletion/receipt`  | Public; Bearer may be expired (30 days)   | `{ state: 'deleted' }`; 404 `NO_DELETION_RECEIPT`; 401 `RECEIPT_TOKEN_MISSING` / `RECEIPT_TOKEN_INVALID` |

The admin force-delete is an immediate, irreversible full erasure of any user
id, so it needs the same fresh, single-use step-up token as self-deletion,
minted for the calling owner (`POST /auth/recent-auth-token`). `RolesGuard`
runs first, so a non-owner is refused (403 `Insufficient role`) before its
token is consumed. Every RecentAuthGuard failure carries a stable `code`
(`RECENT_AUTH_REQUIRED`, `RECENT_AUTH_TOKEN_EXPIRED`, `RECENT_AUTH_TOKEN_INVALID`,
`RECENT_AUTH_TOKEN_USER_MISMATCH`, `RECENT_AUTH_TOKEN_ALREADY_USED`,
`RECENT_AUTH_SESSION_REQUIRED`, `RECENT_AUTH_UNAVAILABLE`).

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

### Completion receipt (B-608-10)

Removing the Supabase identity used to set `supabase_id` to `deleted-<id>`,
so the person's own token got 401 "User not found" before the 403 above.
Now the tombstone keeps a keyed receipt for `DELETION_RECEIPT_DAYS` (30)
after `deleted_at` (C-608-7):
`deleted-r2:<HMAC-SHA256(secret, "tgp-deletion-receipt:v2:" + auth id)>`.
The secret is `DELETION_RECEIPT_SECRET` (32+ characters) when set, else a key
derived from `RECENT_AUTH_SECRET`; a database snapshot plus a list of known
auth ids cannot be joined to a receipt without it. To rotate, move the old
value to `DELETION_RECEIPT_SECRET_PREVIOUS` for 30 days (lookups try current,
then previous). Legacy unkeyed `deleted-r1:<sha256>` receipts are never
written again but still match until the cron drains them. With no usable
secret no receipt is written: the tombstone forgets the auth id.

- `JwtAuthGuard`: an unknown `sub` whose receipt key matches a live receipt
  gets 403 `ACCOUNT_DELETED`. Any other unknown subject stays 401
  `{ code: 'USER_NOT_FOUND' }`.
- `POST /account-deletion/receipt` (public, 10 a minute): the app sends the
  access token it last held. The signature, issuer and audience are checked
  as usual, but a token that expired up to 30 days ago is accepted
  (`JwksVerifierService.verifyForDeletionReceipt`). The only answer is
  `deleted` or 404. An active account looks the same as an unknown one.
- The nightly cron replaces receipts (r2 and legacy r1) older than 30 days with `deleted-<id>`.
  The raw auth id is never stored after removal.

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

1. Collect storage objects (voice notes and voice-message files and the
   `${userId}/` voice prefix, only ever inside that prefix; coach media on
   Supabase and Mux; a coach's classroom media; Supabase bloodwork
   attachments, only `bloodwork/<userId>/…`; local data-export archives) and
   live Stripe subscription ids. Nothing external happens yet.
2. Tombstone the `User` row: email `deleted-<id>@tombstone.invalid`, name
   "Deleted user", phone, coach link, push token, leaderboard name, signup
   ref and payout method cleared, `deleted_at` set.
3. Run the erasure manifest (`account-deletion.manifest.ts`), including the
   RESTRICT-child pre-steps.
4. Delete the person's `deletion_audit` rows.
5. Only now, with every DB statement done, remove the objects and cancel the
   subscriptions (A-608-3). A constraint or data error therefore never leaves
   bytes removed and billing stopped on an account that did not finish. Any
   external failure throws, the transaction rolls back and the next nightly
   run retries; removal and cancellation are idempotent (a missing object or
   an already-canceled subscription counts as done), so repeating them after
   a rollback or a failed commit is safe. Past `purge_after` the deletion
   cannot be cancelled, so the person never gets back an account whose bytes
   are gone.
   Then insert one outcome row with a random subject id (no email, IP or
   user agent).
6. After commit, remove the Supabase auth identity. A returned or thrown
   error is logged, recorded as `auth_identity_cleanup_failed`, and retried
   by every nightly run until it succeeds (`supabase_id` becomes the
   completion receipt key once removed, then `deleted-<id>` after 30 days).
   "Not found" counts as removed.
   Data exports: every export of the user (finished or still building) has
   its archive path removed with the other stored objects. An export that
   finishes after finalization finds no request row and deletes its own
   archive. The nightly export expiry also removes archives older than an
   hour that no row points to (B-608-3).

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

Delete order is checked against the real database constraints:
`test/account-deletion/manifest-fk-order.spec.ts` replays every
`prisma/migrations/**/migration.sql` (ADD/DROP CONSTRAINT, DROP TABLE) and
fails if a manifest step deletes a parent (or anything in its ON DELETE
CASCADE closure) while an ON DELETE RESTRICT / NO ACTION child can still point
at it. Children that are Prisma relations are deleted by an earlier step
through that relation (`ExerciseSet` via `workout.user_id` before
`WorkoutSession`, `HabitLog` via `habit.user_id` before `Habit`); children
that are not (wearable prompt sources -> `WearableSample`) are deleted by
`RESTRICT_CHILD_PRE_STEPS` before the manifest runs.

The #622 AI consent ledger `AiProcessingConsentEvent` (now in the schema)
is deleted by a manifest entry. It rejects UPDATE (append-only trigger) and
its service_role policy allows DELETE, so erasure needs no policy change
(B-608-9). Tables that are not in this schema (`OPTIONAL_USER_TABLES`:
consultation intake #607 and the older name `AiProcessingConsent`) are purged
with a raw `DELETE` when the table exists.

Retained rows (all keyed only by the tombstone id): finance mirrors (Invoice,
ConnectAccount, ClientPurchase deactivated, SplitLedgerEntry, ConnectTransfer,
PartialRefundDecision, CoachCreditPackPurchase, CoachAIBudget,
MarketplaceConnectEvent), coach content a surviving client was assigned
(WorkoutPlan, WorkoutProgram and revisions, DailyMealPlan, MealTemplate,
coach MacroTarget, completed Lessons, contract envelopes and templates on the
coach side, deactivated CoachPackage), and the Scout insert-only import
ledgers (digests only; a DB trigger refuses DELETE).

Recipes the user created are always deleted, together with every bookmark of
them (anyone's), because #630 hides a deleted creator's recipes from everyone
and a bookmark therefore no longer opens anything.

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
| `APPLE_TEAM_ID`, `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY`; optional `APPLE_SIGNIN_CLIENT_ID` (default `com.growthproject.app`, the iOS bundle id; never read from `APPLE_AUDIENCES`) | unset                        | Sign in with Apple token revocation. Missing → `not_configured`, deletion still completes.                                 |
| `SUPABASE_VOICE_BUCKET`, `SUPABASE_MEDIA_BUCKET`, `SUPABASE_BLOODWORK_BUCKET`                                             | `voice-notes`, `coach-media`, `bloodwork` | Buckets purged at finalization. A bloodwork `supabase` ref must be `<bloodwork bucket>/<client id>/<file>` (validated at registration; anything else is skipped and counted at deletion). |
| `STRIPE_SECRET_KEY`, Mux credentials                                                                                      | —                            | Needed only if the person has live subscriptions or Mux assets; without them finalization fails closed, logs, and retries. |

## Tests

| File                                                      | Covers                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/account-deletion/lifecycle-races.spec.ts`           | Request/cancel/finalize state machine on an in-memory DB with row locks and rollback; Sol's six probes inverted (scrub failure rollback, Supabase returned error, fan-out failure, cancel after snapshot, re-request after snapshot, concurrent requests), cancel vs finalize 409, two cron workers, cutoff boundaries, non-identifying audit, admin delete, legacy link. |
| `test/account-deletion/erasure-manifest-coverage.spec.ts` | Schema coverage, entry validity, seeded execution (A erased, B byte-identical).                                                                                                                                                                                                                                                                                           |
| `test/account-deletion/manifest-fk-order.spec.ts`         | Delete order vs. FK constraints parsed from the migrations (RESTRICT / NO ACTION children first), pre-step SQL order.                                                                                                                                                                                                                                                       |
| `test/account-deletion/storage-billing.spec.ts`           | Storage collection/purge and Stripe cancellation, fail-closed paths; own-prefix rule for bloodwork and voice keys.                                                                                                                                                                                                                                                                                                      |
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
