# Invite grants — clinic launch C01

Clinic clients pay Bradley outside the app. They must pass the paywall without Stripe, in a way that is auditable, revocable and general enough for any coach.

## Model

- **Binding.** A coach binds an invite code to one of their packages with a `grant_mode`:
  `none` (default, attach only) · `free` · `prepaid` (client paid outside the app).
  Two kinds of code can carry a binding: a per-row `InviteCode` (`package_id`, `grant_mode`)
  and the coach's **permanent link code** on `CoachProfile` (`invite_code_package_id`, `invite_code_grant_mode`).
  The QR code for a clinic is simply `/join/<code>` of a bound code.
- **Grant.** After a successful attach through a bound code has **committed** — a new redemption *or* a same-coach
  idempotent replay, never after a refusal (a client of another coach gets `409 already_attached_to_different_coach`
  and nothing else) — `InviteCodesService.attachUserToCoachByCode` calls `InviteGrantService.grantForAttachedCode`
  (own transaction, never throws). The attach can never be undone by the grant: an archived/inactive bound package, a
  double submit or a resolver error leaves the client attached and returns `grant.status` = `package_unavailable` /
  `already_active` / `pending_consent` / `code_unavailable` / `failed`. The grant is a `ClientPurchase` row:
  `amount_cents = 0`, `source = 'invite_grant:free' | 'invite_grant:prepaid'`, `stripe_checkout_session_id = 'grant_<uuid>'`
  (synthetic, never sent to Stripe), `grant_metadata = { invite_code_id, invite_code, code_kind, package_id, grant_mode, granted_at }`,
  `access_expires_at` mirrors the package's one-time duration (weeks) or is open-ended. One row per (package, client).
- **Who may receive a grant (grant right).** A new redemption is the right (the attach already checked recipient,
  lifecycle and consumed the seat). For an already-attached client (replay, or `POST /v1/invite-codes/:code/claim-grant`)
  an existing grant row is the right; with no row the code itself must authorise a NEW grant for that person, atomically
  with the row: permanent coach code → yes; `InviteCode` row → never if revoked; its recorded first redeemer
  (`accepted_by_user_id`) → yes without another seat; otherwise not expired, intended recipient matches, and one seat is
  consumed. Otherwise `code_unavailable` (attach) / `409 INVITE_CODE_UNAVAILABLE { reason }` (claim). Coach membership
  alone is never permission.
- **Consent gate (owner ruling).** With `FEATURE_CONTRACTS_ENABLED` off (production today) grants are active immediately
  — unchanged. With it on, comp/code/free grants require the in-app onboarding agreement — the one "I agree" box
  covering the PT waiver and data visibility, stored as `ClientCoachConsent` scope `onboarding.agreement` via
  `POST /consent/grant`. The external e-sign platform waiver is **not** consulted for grants. Without the agreement the
  row is created `status = 'pending_consent'`, `entitlement_active = false`, and the response carries
  `recovery: { action: 'grant_consent', consent_scope: 'onboarding.agreement', endpoint: 'POST /consent/grant', then: 'automatic' }`;
  recording the agreement activates every pending grant for that coach (re-checking package and code revocation), and a
  retry of `claim-grant` / `claim-free` does the same. A code revoked while pending is not reopened. Packages with their
  own coach agreement (`requires_contract` + template) still use `CheckoutContractGate` and cannot be bound to a code
  (`400 PACKAGE_REQUIRES_CONTRACT`).
- **Every signup path reports it.** `/auth/attach-invite-code`, `/auth/select-role`, `/auth/signup-with-code`,
  `/auth/google` and `/auth/apple` return `invite_grant` (`{ status, package_id, purchase_id, recovery? }`) whenever the
  code carries a package, so mobile can show the agreement box instead of a paywall.
- **Delivered like a purchase.** Inside the grant transaction `PurchaseFanoutService.onPurchaseEntitled` runs with
  `entrypoint: 'invite_grant' | 'free_package_claim'` — same program/drip assignment as a paid checkout — and the coach's
  new-client alert is flushed after commit. Revoke cancels the grant's pending drops (`grant_revoked`).
- **Free packages.** A coach may price a package at `amount_cents = 0`. A client of that coach claims it via
  `POST /v1/packages/:id/claim-free` → same grant record with `source = 'free_package_claim'`.
  Non-free packages return `400 PACKAGE_NOT_FREE`; checkout returns `400 PACKAGE_IS_FREE` for $0 packages before any Stripe call.
- **Honoured by** the existing readers unchanged: `ClientEntitlementGuard` (`entitlement_active` + `status in paid/active/trialing` + expiry)
  and `CheckoutService.hasActiveEntitlement` (`GET /v1/checkout/entitlement`).
- **Idempotent.** `ClientPurchase.idempotency_key` is UNIQUE and deterministic: `grant:<package_id>:<client_user_id>`
  (one grant per package per client regardless of mode/source; written with `upsert` = ON CONFLICT DO NOTHING, so a
  concurrent double submit converges on one row). Re-attach / re-claim returns `already_active`. A **revoked** grant
  (`status = 'revoked'`) is *not* re-granted by re-entering a public code or switching free↔prepaid
  (`revoked_not_regranted`, `409 GRANT_REVOKED` on the claim routes); re-granting is an explicit coach/owner action:
  revoke is the off-boarding tool, so re-grant means clearing the revoked row (SQL below) or binding a **new package**.
- **Stripe rows are never touched.** Every write in `InviteGrantService` filters on `source IS NOT NULL`.
  Finance readers exclude grants with `source IS NULL`: admin analytics (GMV / purchases_count), coach-connect subscriber
  counts, MRR and churn, and the Connect fee reconciliation sweep. `createAdminRefund` on a grant is `400 GRANT_NOT_REFUNDABLE`.
- **Free packages** are `amount_cents = 0`, `one_time`, no recurring companion (`PackagesService.assertValidPricing`);
  every paid leg keeps the 50¢ Stripe floor. No Stripe Price is minted for $0.

- **Joins (B-PACKAGE-135).** A free or prepaid coach-code join writes its grant inside the attach transaction
  (`grantForJoinTx`, after `joinGrantActive`); a grant that cannot be written rolls the attach back. See
  [`../invite-codes/README.md`](../invite-codes/README.md).

## API (coach/owner unless noted)

| Route | Roles | Purpose |
|---|---|---|
| `PUT /v1/invite-codes/:code/package-binding` `{ package_id \| null, grant_mode }` | coach (own codes/packages), owner | set / clear binding; audited `invite_code.binding_set` |
| `POST /v1/packages/:id/claim-free` | student (client of the package's coach) | claim a $0 package; audited `entitlement.granted`; 409 contract / revoked |
| `POST /v1/invite-codes/:code/claim-grant` | student (already attached to the code's coach) | claim the grant a bound code carries (web `/join` for signed-in clients, retry after signing); idempotent |
| `POST /v1/entitlements/grants/revoke` `{ client_user_id, package_id?, reason? }` | coach (own roster), owner | revoke grants — **active and pending** (`pending_consent`) rights, each by a conditional write to the final `revoked` tombstone, so consent recovery / a claim retry can never activate a withdrawn right (B-595-1); audited `entitlement.grant_revoked`; idempotent |

## Clinic setup (ops)

1. Bradley creates the clinic package (any price; the price is informational for prepaid) and publishes it.
2. `PUT /v1/invite-codes/<Bradley's permanent code>/package-binding { package_id, grant_mode: 'prepaid' }`.
3. Print the QR for `https://<web>/join/<code>`. Every client who joins through it is attached, then entitled and
   delivered (programs/drips + coach alert) immediately after; existing clients scanning it are entitled too.
4. To off-board a client: `POST /v1/entitlements/grants/revoke { client_user_id, reason }`.
5. To stop granting: rebind with `grant_mode: 'none'`. Existing grants stay until revoked.

## SQL fallbacks

```sql
-- revoke one client's grants
UPDATE "ClientPurchase" SET entitlement_active = false, status = 'revoked', canceled_at = now()
WHERE client_user_id = '<client>' AND source IS NOT NULL AND entitlement_active = true;
-- allow a revoked client to be re-granted by re-scanning (clears the tombstone)
DELETE FROM "ClientPurchase" WHERE client_user_id = '<client>' AND package_id = '<pkg>' AND source IS NOT NULL AND status = 'revoked';
-- migration rollback (down.sql) neutralises every grant row first: entitlement_active=false, status='revoked'.
-- clear the permanent-code binding
UPDATE "CoachProfile" SET invite_code_package_id = NULL, invite_code_grant_mode = 'none' WHERE user_id = '<coach>';
```

## Tests

- `test/invite-grant-authorization.spec.ts` — real InviteCodesService + InviteGrantService + ConsentService over a
  stateful DB: no re-parent/no grant across coaches, replay convergence, revoked/expired/exhausted/other-recipient
  denials, last-seat race, pending → active on consent, revoked code not reopened.
- `test/invite-grant.spec.ts` — delivery (fan-out), paywall guard, revoke, free packages, controller mapping.
