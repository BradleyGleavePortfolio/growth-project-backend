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
| `POST` | `/coaches/me/invite-link/regenerate` | Rotate the default link; old code stops resolving immediately |

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
for unauthenticated callers.

Both refuse:
- Codes owned by a user whose role is no longer `coach` (defense
  against post-demotion redemption).
- Codes whose owning coach has `subscription_status` of `canceled` or
  `paused` (the coach is not currently accepting clients).

## Atomic attach

`attachUserToCoachByCode(userId, code)` runs in a Prisma interactive
transaction:

1. Resolve the code to a coach id (via `CoachProfile` first, then
   legacy `InviteCode`).
2. Refuse OWNER callers — OWNERs are not coached.
3. For legacy codes, re-check `revoked` / `expires_at` / `max_uses`
   inside the transaction and bump `used_count` with optimistic
   concurrency on the row's prior `used_count`. The second concurrent
   redeemer of the last seat fails with `Invalid or expired invite
   code`.
4. Update the user with `role: 'student'` and the resolved
   `coach_id`.

The `bumped.count !== 1` guard is the optimistic-concurrency lever —
Prisma `updateMany` returns the affected row count and we treat
anything other than 1 as a lost race.

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
