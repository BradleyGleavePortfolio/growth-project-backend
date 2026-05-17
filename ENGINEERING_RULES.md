# Growth Project — Engineering Rules

> These rules apply to every commit, every AI generation session, and every PR.
> "DECACORN QUALITY — Whop AI / Notion levels. Clean, workable, 99.9% uptime."

---

## 1. Authorization & Tenant Isolation

- Every service method that reads or writes tenant data **must** have an explicit `WHERE` clause scoping to the caller's tenant ID — a route-level guard is not enough.
- Any new role or permission type gets a **dedicated guard file** (`*.guard.ts`) — no inline `if (role === 'coach')` checks in service or controller code.
- Sub-coaches are **never** treated as head coaches. Any route that mutates team structure, billing, Connect, packages, or revenue-sharing must have `HeadCoachOnlyGuard` or `NoActiveSubCoachGuard` applied.
- Client data lookups always scope to `coach_id = caller.id`. If a sub-coach relationship exists, the scope must further resolve to the correct head-coach tenant — never merge multiple head-coach rosters.
- `assertXOwnsY()` helpers must be present and called before any cross-entity read or write. Return `404` for unauthorized IDs (not `403`) to avoid ID probing.

## 2. Database & RLS

- Every new Prisma table gets **RLS enabled in the same migration** that creates it. No table ships without:
  ```sql
  ALTER TABLE "TableName" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "TableName" FORCE ROW LEVEL SECURITY;
  ```
  plus at minimum an owner-bypass policy and a tenant-scoped SELECT policy.
- Financial tables (`Invoice`, `ClientPurchase`, `ConnectAccount`, `CoachPackage`, `SplitLedgerEntry`, etc.) get write-scope policies — not just SELECT.
- RLS policies use the `app.current_user_id()` and `app.is_owner()` helpers. Never reference `auth.uid()` directly.
- Migrations are **append-only** and timestamped. Never edit a shipped migration file.

## 3. Error Handling

- HTTP status codes are **semantically enforced**:
  - `402` → entitlement/paywall (never collapse to 500 or empty state)
  - `403` → access denied
  - `404` → not found or intentionally hidden (not "forbidden")
  - `409` → conflict / idempotency duplicate
  - `410` → permanently gone (paired with dead-code removal on mobile)
- Mobile `errorMessage()` must prefer `response.data.message` over `AxiosError.message` — users never see raw axios network strings.
- The mobile API client's response interceptor handles `402` specifically: fire `entitlementEvents.emitRequired()`, do not navigate directly from the interceptor, do not retry.
- React Query `retry` returns `false` for `402` — entitlement failures are not retried.

## 4. Entitlement / Paywall

- `ClientEntitlementGuard` is applied to every paid endpoint. Use `@SkipClientEntitlement()` only for billing-recovery routes (checkout, entitlement check, billing portal, package list).
- Mobile has `EntitlementProvider` wrapping all authenticated student navigation. Bootstrap check fires on login; foreground check fires on app resume.
- Paid screens use `ProtectedScreen` wrapper — they never mount and fire guarded API calls if `entitlementActive === false`.
- `PackageSelectionSheet` is a promotional prompt only — it is **never** the enforcement gate.

## 5. DTO / Schema Hygiene

- Every field a mobile screen **sends** must exist in:
  1. The backend DTO (with `@IsOptional()` or required decorator)
  2. The Prisma schema
  3. The service explicit field map
  No "it might be permissive" assumptions. `forbidNonWhitelisted: true` is global and enforced.
- HTTP verb must match controller decorator exactly. Mobile calls `PATCH` if backend says `PATCH`.
- New notification preference fields get added to schema, migration, DTO, service map, and mobile field mapping in the same session.

## 6. Env Vars & Boot Validation

- Every new service dependency that requires a credential gets added to `prodHardenedFeatureVars` **in the same commit** it is introduced.
- If a feature flag being `true` implies required credentials (e.g. `GOOGLE_CALENDAR_ENABLED=true` needs OAuth vars), those credentials are validated at boot via `ENV_RULES` — no silent fallback to stubs in production.
- The outstanding required secrets are tracked below and must be set before first gym license:

  | Secret | Status |
  |---|---|
  | `STRIPE_WEBHOOK_SECRET` | Must be set in Fly |
  | `ANTHROPIC_API_KEY` | Must be set in Fly |
  | `DIRECT_URL` | Must be set in Fly (Prisma migrations) |
  | `ADMIN_SERVICE_TOKEN` | Must be set in Fly |
  | `BOOTSTRAP_SECRET` | Set + delete after first owner created |
  | `ADMIN_BACKEND_API_URL` | Set in Vercel |

## 7. Dead Code

- A route returning `410 Gone` means the corresponding mobile API call, React Query hook, and UI component are **deleted in the same session** — not deferred.
- Stub/mock flags that are not `__DEV__`-gated do not ship. Pattern: `const FLAG = __DEV__ && readFlag('EXPO_PUBLIC_FLAG', false)`.
- If code can be confirmed as bloat (unused exports, commented-out blocks, placeholder adapters that throw `ServiceUnavailableException`), delete it.

## 8. Scheduling / Provider Pattern

- Provider adapters must be either **fully implemented** or **explicitly disabled** — no adapter that throws `ServiceUnavailableException` ships as the default production path.
- Silent fallback to stub adapter is only acceptable when the session type itself was booked as `manual`. Real-provider rows falling back to stub must surface an operator-visible error.
- `VideoLinkResult.joinUrl` is typed `string | null`. Code that renders a "Join" button checks for a real `http(s)` URL — not truthy alone.
- Manual video-link UX must exist before scheduling is enabled for a gym: coach can attach a URL per session, client sees the Join button only after it is saved.

## 9. Stripe / Payments

- Platform is Merchant of Record. `automatic_tax: { enabled: true }` on every `createCheckoutSession` call.
- Package lookup is always scoped: `WHERE id = packageId AND coach_id = client.coach_id AND is_active = true AND archived_at IS NULL`. A null `client.coach_id` throws `COACH_NOT_ASSIGNED` before any Stripe call.
- Stripe webhook handler uses `STRIPE_WEBHOOK_SECRET` signature verification. `PaymentFailure.stripe_event_id` is `@unique` — idempotency enforced at schema level.
- `applySubscription()` and any multi-step payment write runs inside a Prisma `$transaction`.

## 10. New Feature Checklist

Before any feature is considered done, verify:

- [ ] DB query scopes to the correct tenant (`WHERE coach_id = caller.id` or equivalent)
- [ ] New DB table has RLS enabled with policies in the same migration
- [ ] Mobile error handler surfaces `response.data.message` to the user
- [ ] DTO has a field for everything mobile sends; HTTP verb matches
- [ ] New env vars are in `prodHardenedFeatureVars` (or noted as required for Brad to set)
- [ ] Dead code from the previous version of this feature is removed
- [ ] `410` routes have no live callers
- [ ] Mock/stub flags are `__DEV__`-gated
- [ ] Paid endpoints have `ClientEntitlementGuard`; mobile has `ProtectedScreen`
- [ ] Stripe calls that write money are idempotent and transactional

## 11. Code Style

- Role enum: `{ coach, student, owner }` — clients are `student`, never `client` in code.
- Auth guard sets full Prisma user object on `req.user`. Always reference `req.user.id`, never `req.user.sub`.
- RLS interceptor fires **after** `JwtAuthGuard`. `set_config(..., true)` — transaction-scoped, pgbouncer-safe.
- App aesthetic: quiet luxury, premium, calm — Cormorant Garamond / Inter, bone/forest palette (`#FAF8F5`, `#4A7C59`, `#1A1A1A`). No emoji, no gamification chrome.
- Sub-coach revenue share: **5% only** when the head coach explicitly toggles it on per-relationship. Never automatic.

---

*Last updated: Round 3 audit fixes — May 17 2026*
