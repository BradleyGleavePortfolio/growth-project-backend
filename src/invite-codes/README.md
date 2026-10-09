# invite-codes

Per-coach invite codes. Two coexisting models:

- **Default per-coach link** — `CoachProfile.invite_code`. One
  human-friendly code per coach. The Phase 1C surface and the URL the
  coach shares.
- **Legacy multi-row** `InviteCode` — supports `expires_at` and
  `max_uses`. Still honored on read; new flows prefer the default
  link.

A signup or attach call works against either source; preview /
validate / attach all probe `CoachProfile.invite_code` first and fall
back to `InviteCode` rows.

## Purpose

- Mint, list, revoke, and rotate invite codes.
- Preview a code publicly (coach name, business name, branding) so the
  signup screen and the public landing page can render a coach card
  before the user commits.
- Atomically attach a user to a coach when a code is redeemed (race-
  safe under concurrent redemption of the last seat).
- Carry the OWNER bypass — OWNERs cannot redeem their own coach
  invites and the validator refuses codes belonging to a non-coach
  user.

## Key files

| File | What it owns |
|---|---|
| `invite-codes.controller.ts` | `/coach/invite-codes*`, `/coaches/me/invite-link*`, `/invite/:code/preview`, `/auth/attach-coach-code` |
| `invite-codes.service.ts` | Code generation, validate / preview, atomic attach, default-link create / regenerate |
| `invite-codes.dto.ts` | `CreateInviteCodeDto` |

## Code shape

`GP-XXXXXX`, where `XXXXXX` is six characters from the unambiguous
alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no `0/O/1/I/L`). Generation
uses `crypto.randomBytes` and retries on `P2002` for the unique
constraint on `code` / `invite_code`. Two collisions in a row are
already astronomically unlikely; ten in a row surfaces an internal
error.

The 30-bit space is small enough that brute-force enumeration is the
relevant threat — every public path is throttled (preview at 30/min,
validate-invite-code at 20/min) so guessing a valid code is
infeasible.

## Endpoints

### Coach (authenticated)

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/coach/invite-codes` | Create a multi-use, optionally-expiring code |
| `GET` | `/coach/invite-codes` | List the caller's codes |
| `DELETE` | `/coach/invite-codes/:id` | Revoke (IDOR-checked) |
| `GET` | `/coaches/me/invite-link` | Get the default per-coach link (lazy create) |
| `POST` | `/coaches/me/invite-link/regenerate` | Rotate the default link; the old code is archived revoked, so a new signup with it gets `code_revoked` |

### Public

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/invite/:code/preview` | Coach card for a valid code; `{valid:false}` otherwise |

### Authenticated user (any role except OWNER)

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/auth/attach-coach-code` | Atomically link the caller to a coach via code |

The canonical attach path on the auth controller
(`/auth/attach-invite-code`) calls into the same service method and
is preferred for new clients.

## Validate / preview

`validate(code)` returns a structured `{ valid, coach_id, coach_name,
invite_code_id }` or `{ valid: false, reason }`. `previewCode` resolves
to a public-safe coach card (name, business name, branding) suitable
for unauthenticated callers. COACH-CARD-134: the card also carries the coach
consultation's `headline` (K1 headline, else the K1 `bio`) and `specialties`
(K2, known keys only, at most five), for CoachProfile codes and per-row
`InviteCode` invites alike; `null` and `[]` when the coach never answered.

Both refuse:
- Codes owned by a user whose role is no longer `coach` (defense
  against post-demotion redemption).
- Codes whose owning coach has `subscription_status` of `canceled` or
  `paused` (the coach is not currently accepting clients).

## Atomic attach (the ONE canonical writer)

`attachUserToCoachByCode(userId, code)` is the only code path that sets
`User.coach_id` from an invite code. `/auth/attach-invite-code`,
`/auth/select-role`, `/auth/signup-with-code`, `/auth/google` and
`/auth/apple` all delegate to it.

1. Trim and resolve the code to its coach (`CoachProfile` permanent code
   first, then `InviteCode` row) with **no** lifecycle checks yet. The typed
   form is tried exactly first, then upper-case, then with the dash after
   `GP` restored (`inviteCodeLookupCandidates`), so `gp-bradley` and
   `GPBRADLEY` reach the stored `GP-BRADLEY`; everything after uses the stored
   code. `previewCode` (signup-screen check and `/join/<code>` landing) uses
   the same forms.
2. Refuse `owner` (`owner_cannot_redeem`) and `coach` / `sub_coach`
   (`coach_cannot_redeem`) — never demoted, never re-parented.
3. Redeemer already attached:
   - to the **same** coach → idempotent success `already_attached: true`:
     no write, no seat, no `INVITE_REDEEMED` event — even if the invite is
     now exhausted, expired or revoked (a retried single-use invite must
     succeed; attach state cannot change, so there is nothing to protect);
   - to a **different** coach → `409 already_attached_to_different_coach`.
4. New redemption: full lifecycle (revoked / expired / exhausted / coach
   role), coach subscription (`coach_not_accepting_clients`), then in ONE
   transaction on a fresh read: intended-recipient check
   (`invite_intended_email_mismatch`), capacity-conditional seat bump
   (`used_count < max_uses`), first-redeemer attribution
   (`accepted_by_user_id`), and the conditional attach
   `updateMany({ id, role: 'student', coach_id: null })`. A lost race rolls
   the seat back and resolves to `already_attached` (same coach) or 409.

Response contract for callers (mobile): `already_attached: true` means "this
client already belongs to this coach"; it is **not** a fresh redemption. A
returning Google/Apple sign-in that still carries a cached code gets
`invite_attached: true` from this replay path. The replay does not re-check
the coach's subscription, because it changes no state. Do not show
"you joined" UI or count a new client from it; only `already_attached: false`
is a new redemption.

### Every join carries one package (B-PACKAGE-135)

`join-package.ts` picks the package: the one bound to the code while usable, else the coach's oldest usable
package, else a free "Getting started" package made on first use. Free or prepaid: granted inside the attach
transaction (a failed grant rolls the attach back). Paid: no attach, no seat, no ledger row; the result carries
`join.status: 'checkout_required'` and the app sends `join_code` to payment-intent or subscription-intent
(`paidJoinAllowed`). The purchase's entitlement attaches the client (`attachPaidJoinTx`). Every result carries
`join` (`invite_join` on the auth routes). Tests: `test/invite-grant.spec.ts` (B-PACKAGE-135 block).

Tests: `test/invite-attach-idempotent-replay.spec.ts`,
`test/select-role-canonical-attach.spec.ts`,
`test/invite-attach-reliability.spec.ts`.

## Coach code tools (A2, flag `FEATURE_COACH_CODE_TOOLS`, default OFF)

`coach-code-tools.controller.ts` / `coach-code-tools.service.ts`. Every route
is `JwtAuthGuard + CoachGuard`, `@Roles('coach','owner')`, tenancy from
`req.user.id` only, and answers `404 coach_code_tools_disabled` while the
flag is off. `:id` is an `InviteCode` id or the literal `coach-link`.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/coach/codes` | Coach link first, then shareable codes (no single-recipient invites) with status (`active`, `retiring`, `revoked`, `expired`, `used_up`), `join_url` = `qr_payload` (`https://app.trygrowthproject.com/join/<code>`), package, lineage and exact ledger usage (`signups_total`, `signups_7d`) |
| `POST` | `/coach/codes` | Create a `GP-XXXXXX` code (unlimited, no expiry unless set; optional label, `max_uses`, `expires_at`, package + grant mode checked by `InviteGrantService.assertBindablePackage` and written in the same INSERT as the code). `Idempotency-Key` header (8-128 visible characters, else `400 idempotency_key_invalid`): a retry returns the first code (`replayed: true`) |
| `POST` | `/coach/codes/:id/rotate` | New code with the same settings, linked by `rotated_from_id`; the old one is revoked now (`grace_hours` 0, default) or keeps working until `now + grace_hours` (max 168). A retried rotate returns the existing successor. `coach-link` requires `expected_code` (the link on screen), archives the old link code as an InviteCode row (with `successor_code`) so it keeps resolving, and a retry returns the first successor without writing |
| `POST` | `/coach/codes/:id/revoke` | Turn a code off (idempotent). The coach link can only be rotated (`409 coach_link_not_revocable`) |
| `GET` | `/coach/codes/signups?days=30` | Exact daily signups (1-90 days) in the coach's time zone (`CoachProfile.timezone`, else `America/Los_Angeles`), zero-filled, overall / `by_code` / `by_package`, with `unusual_today` (today >= 3 and >= 3x the trailing 7-day average) to catch a leaked code |

Team Mode (`resolveTeamAttribution`, as the legacy create): an active team
sub-coach's codes are stored under the head coach with `invited_by_user_id` =
the sub-coach. A sub-coach lists, rotates, revokes and counts only their own
codes, has no coach link (`403 coach_link_head_coach_only`) and cannot put a
package on a code (`403 code_package_head_coach_only`, nothing written); the head coach
sees and manages every team code (`issued_by_user_id` in each view).

Every create / rotate / revoke writes an audit row (`invite_code.created`,
`invite_code.rotated`, `invite_code.revoked`). Rotating or revoking never
touches `User.coach_id`, so clients who already joined stay with the coach.

### Signup ledger (`InviteRedemption`, always on)

`attachUserToCoachByCode` writes one row per NEW redemption inside the attach
transaction (code string, `coach_link` / `invite_code`, the package bound at
that moment). Replays and refusals write nothing. RLS: the coach reads own
rows, owner reads all, no public writes, anon denied
(`20270302000000_coach_code_tools`). Counts start at deploy.

### Specific refusals for an existing code

A NEW redemption of a code that resolves to a coach but cannot take a signup
now answers `code_revoked`, `code_expired` (including the end of a rotation
grace window) or `code_exhausted` with copy that says what to do next.
Unknown codes stay `invite_code_invalid`; public preview / validate stay
collapsed to `{ valid: false }`.

## Security and tenancy rules

- Coach-management endpoints are gated by
  `JwtAuthGuard + CoachGuard`. CoachGuard is widened in Phase 1B so
  OWNER passes through.
- `revokeForCoach` checks the IDOR guard explicitly — a coach can
  only revoke their own codes.
- `previewCode` and `validate` deliberately collapse not-found,
  revoked, expired, max-uses-reached, and non-coach-role into a
  single `{ valid: false }` so callers cannot enumerate which case
  applies.
- The throttler is the only enumeration defense; raise it cautiously.

## Environment variables

| Var | Purpose |
|---|---|
| `PUBLIC_INVITE_BASE_URL` | Base URL surfaced on `/coaches/me/invite-link` (defaults to `https://app.tgp.com/join`). Required in prod/staging. |

## Failure modes

- `expires_at` in the past on create → 400 `expires_at must be in the
  future`.
- 10 consecutive unique-constraint collisions on code generation →
  500 `Could not generate a unique invite code`. Astronomically
  unlikely; means the unique index or random source is broken.
- Concurrent redemption race lost → 400 `Invalid or expired invite
  code`. The user can retry — the redemption is atomic per request.
- Coach has been demoted → preview / validate return
  `{ valid: false }`. Existing students keep their `coach_id`; only
  new redemptions are blocked.

## Tests

| File | Covers |
|---|---|
| `test/invite-codes.service.spec.ts` | Mint, validate, preview, attach, race-loss, expired/revoked/max-uses, OWNER refusal |
| `test/invite-codes.controller.spec.ts` | Route guards, preview public path, IDOR on revoke |

## Operational notes

- Rotating a coach's default link via `regenerate` does *not* break
  existing clients on that coach's roster — `coach_id` on the
  `User` row is the durable link. Only future redemptions of the old
  code stop resolving.
- The legacy `InviteCode` rows are kept for the per-link analytics
  story (limited-seat onboarding cohorts). Default-link redemption
  does not write to that table.
- The `/api/invite/:code/preview` JSON route lives alongside the
  unprefixed HTML landing under `/invite/:code` (see
  [`../invite-landing/README.md`](../invite-landing/README.md)).
