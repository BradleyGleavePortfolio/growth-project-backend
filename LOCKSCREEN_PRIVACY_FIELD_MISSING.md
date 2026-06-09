# LOCKSCREEN PRIVACY FIELD MISSING — schema/product gap

**Status:** Open — requires a separate schema-migration PR with operator sign-off.
**Raised by:** PR #370 fixer (v1-4 community realtime + push + telemetry).
**Date:** 2026-06-09

## Summary

Hard Gate #4 requires push-notification rendering to consult
`User.lockscreenPrivacy` and use generic copy when it is `true`. The current
Prisma schema does **not** contain that column on `User` (or on
`UserPreferences` / `NotificationPreferences`). PR #370 is under a **zero schema
mutation** hard gate, so the column cannot be added in this PR.

## Verification (field does not exist)

```
$ grep -in -E 'lock.?screen|lockscreen_privacy|lockscreenPrivacy' prisma/schema.prisma
# (no matches — exit 1)
```

Inspected `model User` (schema.prisma:154) and `model UserPreferences`
(schema.prisma:1308): neither declares a lockscreen-privacy column. The only
push-related `User` field is `expo_push_token`.

`sha256sum prisma/schema.prisma` is unchanged from origin/main:
`f4a70e7064d874426b1ca9c57e3f7addc36d72ca33b2076f70ca513285cb416a`.

## Resolution applied in this PR (safe-by-default)

`CommunityNotificationsService.resolveLockscreenPrivacy()` now returns
**privacy-ON unconditionally** (`return true`). Consequences:

- Every community push uses the generic privacy-ON copy
  (`COMMUNITY_PUSH_BODIES[kind].privacyOn`).
- Titles/bodies never include sender names or user-authored message text.
- The forward-compatible `SendCommunityPushInput.lockscreenPrivacy` carrier is
  retained but **ignored** — no override can turn privacy OFF without a real
  per-user DB value backing it. This closes the gate the safe way.

This satisfies Hard Gate #4 (generic copy, no leak) without mutating the schema.

## Required follow-up (separate PR, operator sign-off)

1. Add `lockscreenPrivacy Boolean @default(true)` to `model User` (or to a
   preferences model) via a proper migration.
2. Extend the community push recipient query to
   `select: { expo_push_token: true, lockscreenPrivacy: true }`.
3. Change `resolveLockscreenPrivacy()` to read the recipient's real column value
   (e.g. `resolveLockscreenPrivacy(user.lockscreenPrivacy)`), defaulting to
   `true` when null.

Until then, community push is privacy-on for everyone, which is the
conservative, gate-satisfying behaviour.
