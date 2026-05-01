# Affiliate program — link, attribution & commission spec

> **Status:** draft, docs-only. Do not merge. No runtime changes.
> **Owner:** backend platform.
> **Wave:** 8 (parity layer).
> **Depends on:** Wave 2 (sub-coach hierarchy, Coach/Org models), Wave 5 (Stripe Connect routing), Wave 7 (buyer funnel attribution model).

This spec defines the data model, attribution rules, anti-fraud surface, and lifecycle for the TGP affiliate program. The buyer-facing dashboard, payout pipeline, and tax surface are specified separately in `dashboard-and-payouts.md`.

---

## 1. Purpose, non-goals, OWNER decisions

### Purpose
Allow third parties (existing coaches, content creators, partners) to refer prospective coaches or clients to the TGP platform and earn a commission on the resulting paid conversion. The program must be:

- **Verifiable** — every commission must trace to a signed click → conversion ledger entry.
- **Fraud-resistant** — self-referrals, click-stuffing, and bot conversions must auto-quarantine.
- **Reversible** — refunds within the chargeback window must claw back the commission.
- **Tax-correct** — 1099 thresholds and W9/W8-BEN collection must be enforced before payout.

### Non-goals (v1)
- No multi-level (MLM) trees beyond two levels — see OWNER decision below.
- No paid placement boost via affiliate (that lives in Wave 7 `featured-placements-and-monetization.md`).
- No commission on free trials that never convert.
- No commission on internal staff referrals (separate HR program).
- No commission on refunded purchases (clawback within 90 days).

### OWNER decisions (this spec)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Attribution window length | 7 / 30 / 60 / 90 days last-touch | **30 days last-touch click** |
| 2 | Multi-level | single-level only / two-level / N-level MLM | **single-level v1, two-level v2 deferred** |
| 3 | Default commission % | 10 / 15 / 20 / 25 | **20% flat, configurable per program** |
| 4 | Self-referral detection threshold | strict (any match) / heuristic / disabled | **strict on payment-method + account-id; heuristic on IP + device fingerprint** |
| 5 | Cookie consent fallback | server-side ledger only / cookie + server fallback / cookie only | **cookie + server-side fallback** |
| 6 | Refund clawback window | 30 / 60 / 90 / 180 days | **90 days** |
| 7 | Tiered commission | flat only v1 / tiered (volume-based) v1 | **flat v1; tiered deferred** |
| 8 | Bot-click filtering | inline (block at edge) / async (filter from ledger nightly) / hybrid | **hybrid: edge blocks known bot UAs, async sweeps for behavioural patterns** |

---

## 2. Personas + permission matrix

| Persona | Capabilities |
|---|---|
| `OWNER` | Approve/reject affiliate applications, set program commission %, set caps, manually adjust commissions, run clawbacks, view all programs and links. |
| `COACH` (program owner) | Create program for own products, set commission % within OWNER-set bounds, view program-level metrics, NOT view PII of affiliates. |
| `SUB_COACH` | None unless explicitly granted by parent COACH (entitlement bit). Default: read-only on parent's program metrics. |
| `AFFILIATE` (external partner) | Generate links, view own click/conversion/commission ledger, request payout, manage tax forms. |
| `CLIENT` | None — clients are not affiliates by default. A client may apply to become an affiliate (separate `AffiliateApplication` flow). |
| `ADMIN` | Full read on all programs and ledger entries. Can quarantine, clawback, force-pay (with audit). Cannot modify commission % retroactively (immutable on ledger row). |

Server-side enforcement at every endpoint. RBAC enforced in middleware before handler.

---

## 3. Prisma schema deltas (illustrative — not applied)

```prisma
// All money fields use Decimal(14,2). Currency stored on the row.
// Audit fields (created_at, updated_at, created_by, updated_by) on every table.
// All personal-data tables include a GDPR cascade column and a `delete_after` instant.

model AffiliateProgram {
  id                  String    @id @default(cuid())
  org_id              String
  owner_user_id       String    // Coach or Org owner who created the program
  product_scope       String    // "ALL" | "PROGRAM:{program_id}" | "TIER:{tier_id}"
  commission_pct      Decimal   @db.Decimal(5,2) // 0.00 - 100.00
  commission_currency String    @db.Char(3)      // ISO-4217
  cap_per_conversion  Decimal?  @db.Decimal(14,2) // optional cap
  attribution_days    Int       @default(30)
  clawback_days       Int       @default(90)
  status              AffiliateProgramStatus @default(DRAFT)
  starts_at           DateTime?
  ends_at             DateTime?
  multi_level_enabled Boolean   @default(false)  // v2 hook; v1 always false
  level_2_pct         Decimal?  @db.Decimal(5,2) // only meaningful when multi_level_enabled
  terms_url           String?
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt
  created_by          String
  updated_by          String

  org    Org    @relation(fields: [org_id], references: [id], onDelete: Cascade)
  owner  User   @relation(fields: [owner_user_id], references: [id])
  links  AffiliateLink[]
  conversions AffiliateConversion[]

  @@index([org_id, status])
  @@index([owner_user_id, status])
}

enum AffiliateProgramStatus {
  DRAFT
  ACTIVE
  PAUSED
  CLOSED
}

model AffiliateAccount {
  id                  String    @id @default(cuid())
  user_id             String    @unique // each user can be at most one affiliate account
  status              AffiliateAccountStatus @default(PENDING_REVIEW)
  payout_method       String?   // "STRIPE_CONNECT" | "MANUAL" — v1 STRIPE_CONNECT only
  stripe_account_id   String?   // Connect account
  kyc_completed       Boolean   @default(false)
  tax_form_kind       String?   // "W9" | "W8BEN" | "W8BEN-E"
  tax_form_collected_at DateTime?
  tax_form_storage_url String?  // signed URL into encrypted bucket
  payout_threshold_cents Int    @default(5000) // $50 default; per-currency on row
  payout_currency     String    @db.Char(3) @default("USD")
  consent_marketing_at DateTime?
  consent_program_at  DateTime  // required for any link generation
  banned_reason       String?
  delete_after        DateTime? // GDPR cascade
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt

  user                User      @relation(fields: [user_id], references: [id], onDelete: Cascade)
  links               AffiliateLink[]
  commissions         AffiliateCommission[]

  @@index([status])
}

enum AffiliateAccountStatus {
  PENDING_REVIEW
  ACTIVE
  SUSPENDED
  BANNED
  CLOSED
}

model AffiliateLink {
  id                  String    @id @default(cuid())
  program_id          String
  affiliate_account_id String
  code                String    @unique // 8-char base32, server-generated
  destination_url     String    // canonical destination on TGP
  utm_source          String?
  utm_medium          String?
  utm_campaign        String?
  utm_content         String?
  status              AffiliateLinkStatus @default(ACTIVE)
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt

  program             AffiliateProgram   @relation(fields: [program_id], references: [id], onDelete: Cascade)
  account             AffiliateAccount   @relation(fields: [affiliate_account_id], references: [id], onDelete: Cascade)
  clicks              AffiliateClick[]
  conversions         AffiliateConversion[]

  @@index([program_id, status])
  @@index([affiliate_account_id, status])
}

enum AffiliateLinkStatus {
  ACTIVE
  DISABLED      // affiliate disabled
  REVOKED       // platform revoked (fraud, terms violation)
}

model AffiliateClick {
  id                  String    @id @default(cuid())
  link_id             String
  click_token         String    @unique // signed cookie value, opaque
  ip_hash             String    // SHA-256(IP + daily salt) — never raw IP
  user_agent_class    String    // bucketed UA: "ios", "android", "desktop-chrome", "bot:…"
  referrer_host       String?
  device_fp_hash      String?   // hashed device fingerprint, optional
  geo_country         String?   @db.Char(2)
  is_bot_likely       Boolean   @default(false) // edge filter signal
  consent_state       String    // "GRANTED" | "DENIED" | "UNKNOWN"
  occurred_at         DateTime  @default(now())

  link                AffiliateLink @relation(fields: [link_id], references: [id], onDelete: Cascade)

  @@index([link_id, occurred_at])
  @@index([click_token])
}

model AffiliateConversion {
  id                  String    @id @default(cuid())
  program_id          String
  link_id             String
  affiliate_account_id String
  click_id            String?   // resolved click that "won" attribution; null if direct/server-only
  buyer_user_id       String    // the user who paid
  product_kind        String    // "COACH_SUBSCRIPTION" | "PROGRAM_PURCHASE" | "APP_INSTALL_PAID"
  product_ref         String    // foreign key in product table — soft string ref to allow cross-table
  gross_amount        Decimal   @db.Decimal(14,2)
  currency            String    @db.Char(3)
  payment_intent_id   String    // Stripe PaymentIntent
  attribution_kind    String    // "COOKIE" | "SERVER_SIDE_LEDGER" | "MANUAL"
  attribution_window_used Int   // days between click and conversion
  level               Int       @default(1) // 1 or 2 (v2 multi-level)
  parent_conversion_id String?  // for level-2 attribution chain
  status              AffiliateConversionStatus @default(PENDING)
  reject_reason       String?
  fraud_signals       Json?     // structured signal bundle if quarantined
  occurred_at         DateTime  @default(now())
  resolved_at         DateTime?
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt

  program             AffiliateProgram @relation(fields: [program_id], references: [id])
  link                AffiliateLink    @relation(fields: [link_id], references: [id])
  account             AffiliateAccount @relation(fields: [affiliate_account_id], references: [id])
  buyer               User             @relation(fields: [buyer_user_id], references: [id])
  commission          AffiliateCommission?

  @@index([program_id, status])
  @@index([affiliate_account_id, status])
  @@index([buyer_user_id])
  @@index([payment_intent_id]) // unique-ish; enforced at service layer for race-resilience
}

enum AffiliateConversionStatus {
  PENDING        // captured, not yet eligible (clawback window not elapsed for the source payment)
  ATTRIBUTED     // attribution resolved, eligible for commissioning
  COMMISSIONABLE // commission row written
  PAID           // payout transferred
  CLAWED_BACK    // refund/chargeback within window — commission reversed
  QUARANTINED    // fraud signals — held for manual review
  REJECTED       // manual review rejected
}

model AffiliateCommission {
  id                  String    @id @default(cuid())
  conversion_id       String    @unique
  affiliate_account_id String
  amount              Decimal   @db.Decimal(14,2)
  currency            String    @db.Char(3)
  level               Int       // 1 or 2
  computed_pct        Decimal   @db.Decimal(5,2) // snapshot at compute time — immutable
  payout_id           String?   // links to payout batch row (see dashboard-and-payouts.md)
  paid_at             DateTime?
  clawed_back_at      DateTime?
  clawback_reason     String?
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt

  conversion          AffiliateConversion @relation(fields: [conversion_id], references: [id], onDelete: Restrict)
  account             AffiliateAccount    @relation(fields: [affiliate_account_id], references: [id])

  @@index([affiliate_account_id, created_at])
  @@index([payout_id])
}
```

Notes:
- All money: `Decimal(14,2)`, currency stored on row.
- `AffiliateClick.ip_hash` uses SHA-256 with a daily-rotated salt — raw IP never stored.
- `AffiliateAccount.delete_after` participates in the GDPR cascade — when set and elapsed, all dependent click/conversion personal data is hard-purged; conversions remain as anonymized ledger entries (buyer_user_id replaced with a sentinel `gdpr-purged-{epoch}`).
- `AffiliateCommission.computed_pct` is immutable — retroactive program edits do not rewrite past commissions.

---

## 4. TypeScript API contracts

### Common error envelope
```ts
type ErrorEnvelope = {
  code: string;          // stable, machine-readable. e.g. "AFFILIATE_LINK_FORBIDDEN"
  message: string;       // human-readable
  details?: Record<string, unknown>;
  request_id: string;    // X-Request-ID
};

type Failure<E = ErrorEnvelope> = { ok: false; error: E };
type Success<T>                = { ok: true;  data: T };
type ApiResult<T>              = Success<T> | Failure;
```

### Idempotency
All POST/PATCH/DELETE endpoints accept a header `Idempotency-Key`. Repeated calls with the same key within 24 h return the cached result and do not re-execute side effects.

### Endpoints

```ts
// AFFILIATE-side endpoints (auth: AffiliateAccount.user_id session, capability: affiliate:self)

// POST /v1/affiliate/links
type CreateLinkBody = {
  program_id: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
};
type CreateLinkResponse = ApiResult<{
  link: {
    id: string;
    code: string;        // 8-char base32
    short_url: string;   // https://tgp.app/r/{code}
    canonical_url: string;
    program_id: string;
    created_at: string;  // ISO 8601
  };
}>;

// GET /v1/affiliate/links?program_id=&status=&cursor=&limit=
type ListLinksResponse = ApiResult<{
  items: Array<{
    id: string;
    code: string;
    short_url: string;
    program: { id: string; name: string; commission_pct: string; currency: string };
    metrics: {
      clicks_30d: number;
      conversions_30d: number;
      gross_volume_30d: { amount: string; currency: string };
      pending_commission: { amount: string; currency: string };
    };
    status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
    created_at: string;
  }>;
  next_cursor?: string;
}>;

// GET /v1/affiliate/conversions?status=&since=&until=&cursor=&limit=
type ListConversionsResponse = ApiResult<{
  items: Array<{
    id: string;
    program_id: string;
    link_code: string;
    occurred_at: string;
    gross_amount: { amount: string; currency: string };
    commission: { amount: string; currency: string; pct: string };
    status: AffiliateConversionStatus;
    clawback_eligible_until: string | null;
  }>;
  totals: {
    pending: { amount: string; currency: string };
    paid_lifetime: { amount: string; currency: string };
    clawed_back_lifetime: { amount: string; currency: string };
  };
  next_cursor?: string;
}>;

// POST /v1/affiliate/payouts/request
// (Idempotency-Key required.)
type RequestPayoutBody = { currency: string };
type RequestPayoutResponse = ApiResult<{
  payout_id: string;
  amount: { amount: string; currency: string };
  estimated_arrival: string; // ISO date
}>;

// PROGRAM OWNER endpoints (auth: COACH/OWNER, capability: program:write on org)

// POST /v1/affiliate/programs
type CreateProgramBody = {
  product_scope: 'ALL' | { kind: 'PROGRAM'; id: string } | { kind: 'TIER'; id: string };
  commission_pct: string;       // string for Decimal precision
  commission_currency: string;  // ISO-4217
  cap_per_conversion?: string;  // optional Decimal
  attribution_days?: number;    // default 30, OWNER-bounded 7..90
  clawback_days?: number;       // default 90, OWNER-bounded 30..180
  starts_at?: string;
  ends_at?: string;
  terms_url?: string;
};
type CreateProgramResponse = ApiResult<{ program: { id: string; status: 'DRAFT' } }>;

// PATCH /v1/affiliate/programs/:id  (rules: cannot change commission_pct retroactively;
//        edits affect only conversions occurring after `updated_at`).

// POST /v1/affiliate/programs/:id/transition  body: { to: 'ACTIVE'|'PAUSED'|'CLOSED' }
//   Server enforces state machine (see §6).

// ADMIN endpoints (auth: ADMIN role)
// POST /v1/admin/affiliate/conversions/:id/clawback   body: { reason }
// POST /v1/admin/affiliate/conversions/:id/release    body: { reason }   // un-quarantine
// POST /v1/admin/affiliate/accounts/:id/ban           body: { reason }
```

### Public click endpoint (unauthenticated)

```ts
// GET /r/:code  →  302 to canonical_url with affiliate cookie set
// Sets HttpOnly, Secure, SameSite=Lax cookie:
//   tgp_aff = base64url(JSON({ link_id, click_token, exp }))  signed with HMAC-SHA256(server_secret).
//   Max-Age = attribution_days * 86400.
// Edge filters known bot UAs: returns 302 but writes click row with is_bot_likely=true and consent_state='UNKNOWN'.
// Respects DNT / GPC: writes ip_hash and ua_class but no fingerprint and no cookie.
```

---

## 5. Route surface (verb + path + auth scope + rate-limit class)

| Verb | Path | Auth | Rate-limit class |
|---|---|---|---|
| POST   | `/v1/affiliate/applications`                       | session                  | `affiliate.app.write` (5/min/account) |
| GET    | `/v1/affiliate/programs`                           | session                  | `read.standard`        |
| POST   | `/v1/affiliate/programs`                           | program-owner cap        | `affiliate.prog.write` (10/min/org) |
| PATCH  | `/v1/affiliate/programs/:id`                       | program-owner cap        | `affiliate.prog.write` |
| POST   | `/v1/affiliate/programs/:id/transition`            | program-owner cap        | `affiliate.prog.write` |
| POST   | `/v1/affiliate/links`                              | affiliate cap            | `affiliate.link.write` (60/min/account) |
| GET    | `/v1/affiliate/links`                              | affiliate cap            | `read.standard`        |
| PATCH  | `/v1/affiliate/links/:id`                          | affiliate cap            | `affiliate.link.write` |
| GET    | `/v1/affiliate/conversions`                        | affiliate cap            | `read.standard`        |
| POST   | `/v1/affiliate/payouts/request`                    | affiliate cap + KYC      | `affiliate.payout.write` (1/24h/account) |
| GET    | `/r/:code`                                         | public                   | `edge.click` (token-bucket per IP, soft 600/min/IP) |
| POST   | `/v1/admin/affiliate/conversions/:id/clawback`     | admin cap                | `admin.write`          |
| POST   | `/v1/admin/affiliate/conversions/:id/release`      | admin cap                | `admin.write`          |
| POST   | `/v1/admin/affiliate/accounts/:id/ban`             | admin cap                | `admin.write`          |

All endpoints emit `X-Request-ID`; every mutation writes an `AuditLog` row keyed by `request_id` (see §8).

---

## 6. State-transition tables

### `AffiliateProgram`

| From | Event | To | Side effects |
|---|---|---|---|
| DRAFT     | publish (owner)         | ACTIVE   | owner notified; program visible to affiliates |
| DRAFT     | discard (owner/admin)   | CLOSED   | links cannot be created; no conversions accepted |
| ACTIVE    | pause (owner/admin)     | PAUSED   | new clicks still tracked; new conversions rejected with code `PROGRAM_PAUSED` |
| PAUSED    | resume (owner/admin)    | ACTIVE   | conversions accepted again |
| ACTIVE    | close (owner/admin)     | CLOSED   | links revoked; pending conversions still resolve through clawback window |
| PAUSED    | close (owner/admin)     | CLOSED   | same as above |
| CLOSED    | (terminal)              | —        | — |

### `AffiliateConversion`

| From | Event | To | Side effects |
|---|---|---|---|
| PENDING        | clawback_window_elapsed (job)        | ATTRIBUTED   | commissions become eligible for compute |
| PENDING        | refund_received (Stripe webhook)     | CLAWED_BACK  | reverse outstanding commission ledger entry; never paid |
| PENDING        | fraud_signal_triggered (job/manual)  | QUARANTINED  | hold; admin notified |
| ATTRIBUTED     | commission_computed (job)            | COMMISSIONABLE| `AffiliateCommission` row written |
| COMMISSIONABLE | included_in_payout (job)             | PAID         | `paid_at` set; payout id linked |
| COMMISSIONABLE | refund_received (within clawback)    | CLAWED_BACK  | reverse; if already paid, deduct from next payout or invoice owner |
| PAID           | refund_received (within clawback)    | CLAWED_BACK  | clawback ledger entry; recoup from balance or future payouts |
| QUARANTINED    | admin_release                         | PENDING      | re-enters normal lifecycle |
| QUARANTINED    | admin_reject                          | REJECTED     | terminal |
| (any non-PAID) | conversion_voided (admin, with reason)| REJECTED     | audit row required |

### `AffiliateAccount`

| From | Event | To | Side effects |
|---|---|---|---|
| PENDING_REVIEW | approve (admin)             | ACTIVE     | account can generate links |
| PENDING_REVIEW | reject (admin)              | CLOSED     | terminal; user notified |
| ACTIVE         | suspend (admin)             | SUSPENDED  | links disabled; pending commissions held |
| SUSPENDED      | reinstate (admin)           | ACTIVE     | links re-enabled |
| ACTIVE/SUSPENDED| ban (admin, fraud)         | BANNED     | all links revoked; pending commissions forfeited; payouts halted |
| (any)          | user_close (self)           | CLOSED     | links disabled; payable balance paid out at next cycle |

---

## 7. Failure modes (≥6) with detection + recovery

### 7.1 Cookie blocked (browser, ITP/Safari, ad blocker)
- **Detection:** `Set-Cookie` accepted but subsequent server-rendered page does not echo the cookie back; observed via 1×1 verification beacon at start of checkout flow.
- **Recovery:** server-side ledger fallback. On `POST /v1/checkout/create-intent`, server inspects `Referer`, `Sec-Fetch-Site`, and a query param `aff_token` (carried through links via redirect) to resolve the click. If neither cookie nor token present, conversion gets `attribution_kind = SERVER_SIDE_LEDGER` only when an `aff_token` matched a click within window; else attribution_kind null and conversion is *unattributed* (no commission).
- **Test:** integration test that drives a checkout with cookies disabled and verifies the conversion still attributes via `aff_token`.

### 7.2 Attribution race (two affiliate clicks within window)
- **Detection:** `AffiliateClick` rows with the same `buyer_user_id` (resolved at conversion time) within the window for two different `link_id`s.
- **Recovery:** **last-touch wins**, breaking ties by latest `occurred_at`. If clicks occur within 1 second of each other, prefer the one with `consent_state = 'GRANTED'`; if still tied, prefer the older program (lower `program.created_at`) — deterministic tiebreak.
- **Audit:** record both candidate click ids in `fraud_signals.attribution_race_candidates`.

### 7.3 Refund timing (refund issued after payout)
- **Detection:** Stripe `charge.refunded` webhook arrives for a payment intent referenced by a `PAID` conversion.
- **Recovery:** if within `clawback_days`, write `AffiliateCommission.clawed_back_at`, deduct amount from affiliate's running balance. If running balance goes negative, hold next payout (or all payouts) until balance ≥ 0; if affiliate is closed, write `AffiliateClawbackInvoice` (out of v1 scope but column reserved).
- **Idempotency:** keyed on Stripe charge id + refund id.

### 7.4 Currency mismatch (program in EUR, conversion in USD via cross-border charge)
- **Detection:** `AffiliateConversion.currency` ≠ `AffiliateProgram.commission_currency`.
- **Recovery:** **convert at conversion time** using the same FX rate Stripe used to settle (read from PaymentIntent metadata). Store the rate snapshot in `AffiliateCommission.fraud_signals` (rename to `metadata` in v2). Rule: commission is computed on the gross amount **in the program's commission_currency**.
- **Failure mode within failure mode:** if FX rate unavailable, conversion goes to `QUARANTINED` for manual review.

### 7.5 KYC reject (Stripe Connect)
- **Detection:** Stripe Connect `account.updated` webhook with `requirements.disabled_reason` set, or `payouts_enabled = false`.
- **Recovery:** suspend payouts but continue accruing commissions. Notify affiliate with the specific KYC gap. Hold up to 180 days. After 180 days unresolved, `AffiliateAccount` → SUSPENDED, commissions held until resolution.

### 7.6 Self-referral (buyer is the affiliate)
- **Detection:**
  - Strict: `buyer_user_id == affiliate_account.user_id`.
  - Heuristic: same email domain + same payment method fingerprint, or matching device fingerprint + same IP /24 within 7 days.
- **Recovery:** strict match → reject conversion with code `SELF_REFERRAL`. Heuristic match → `QUARANTINED` for admin review.
- **Test:** unit test for both branches; integration test simulating a self-checkout via affiliate's own link.

### 7.7 Click stuffing / bot conversion
- **Detection:** click velocity > 50/min/IP, missing or randomized referrer, UA on bot blocklist, abnormally short click→conversion intervals (< 10 s), or device fingerprint repeated > 100 clicks/day.
- **Recovery:** edge filter sets `is_bot_likely = true`; conversions whose winning click is `is_bot_likely` go to `QUARANTINED`. Hybrid sweep job runs nightly to mark behavioural patterns missed at edge.

### 7.8 Affiliate disabled mid-window
- **Detection:** `AffiliateAccount.status` transitions to `SUSPENDED` or `BANNED` while pending conversions exist.
- **Recovery:** SUSPENDED → conversions accrue but payouts held. BANNED → conversions transition to `REJECTED` with reason `AFFILIATE_BANNED`; commissions forfeited and not paid.

---

## 8. Security, privacy, audit

- **Audit:** every mutation route writes an `AuditLog` row: `{request_id, actor_user_id, action, target_kind, target_id, before_state, after_state, ip_hash, occurred_at}`. Include reason on admin actions.
- **PII to PostHog:** **never**. Affiliate dashboard analytics use server-aggregated counts only. PostHog events emitted by client must contain only opaque ids (no email, no name, no ip, no link code).
- **GDPR delete:** `AffiliateAccount.delete_after` set on user deletion → cascade deletes click rows older than 7 days (audit retention floor) and replaces `buyer_user_id` in `AffiliateConversion` with `gdpr-purged-{epoch}` sentinel. Conversions remain on ledger for tax-reporting integrity.
- **GDPR export:** affiliate self-service export endpoint returns a signed URL to a JSON archive containing the affiliate's links, click ledger (with `ip_hash` not raw IP), conversions, commissions, and payouts.
- **Consent:** `AffiliateAccount.consent_program_at` must be non-null before any link is generated. UI presents the program terms; consent is recorded with the timestamped IP-hash.
- **Least privilege:** capability tokens scope to `affiliate:self`, `affiliate:program:write`, `affiliate:admin`. No wildcard scopes. Each token bound to user_id and org_id where applicable.
- **Encryption:** tax forms stored in encrypted bucket (KMS-backed). `tax_form_storage_url` is an internal pointer; public download requires re-issuance via signed URL with 5-minute TTL.
- **Webhook signing:** affiliate-facing webhook events (e.g. `conversion.attributed`) signed HMAC-SHA256 with per-affiliate secret; rotation supported.

---

## 9. Performance budgets

| Scale (coaches) | Endpoint | p50 | p95 | Notes |
|---|---|---|---|---|
| 100        | `GET /v1/affiliate/links`            | 40 ms  | 120 ms | small dataset; no aggregation pressure |
| 100        | `GET /r/:code` (edge)                | 8 ms   | 25 ms  | edge cache by code; click-row write async |
| 1 000      | `GET /v1/affiliate/links`            | 60 ms  | 200 ms | per-affiliate metrics from materialized view |
| 1 000      | `GET /v1/affiliate/conversions`      | 80 ms  | 250 ms | cursor pagination, index `(account_id, status)` |
| 1 000      | `GET /r/:code`                       | 10 ms  | 30 ms  | |
| 10 000     | `GET /v1/affiliate/links`            | 120 ms | 400 ms | metrics view materialized hourly + delta cache |
| 10 000     | `GET /v1/affiliate/conversions`      | 150 ms | 500 ms | partition `AffiliateConversion` by `occurred_at` month at this scale |
| 10 000     | `GET /r/:code`                       | 12 ms  | 40 ms  | edge layer absorbs traffic; click-row write batched (≤ 100 ms write delay) |

Background jobs:
- `clawback-window-elapsed` job: sweeps PENDING → ATTRIBUTED at hourly cadence; ≤ 30 s for 10 k coaches.
- `commission-compute` job: ATTRIBUTED → COMMISSIONABLE; targets ≤ 60 s for 10 k coaches.
- `bot-sweep` job: nightly, behavioural pattern detection; ≤ 10 min for 10 k coaches.

Read-replica vs primary:
- `GET /v1/affiliate/links`, `GET /v1/affiliate/conversions`, dashboard reads → **read replica**, ≤ 5 s lag tolerated.
- Mutations → primary.
- `/r/:code` click rows → primary (write-heavy); reads (counts) from replica.

---

## 10. Billing / payment

- All money fields `Decimal(14,2)`; currency stored on row.
- Stripe Connect for affiliate payouts (Express accounts); Standard not supported v1.
- Default payout cadence: monthly on the 7th, settling commissions PAID through prior month-end.
- Min payout threshold: configurable per `AffiliateAccount.payout_threshold_cents`, default $50 (or per-currency equivalent).
- Refund clawback: 90 days; commission reversed at PAID-state too (debt to affiliate).
- 1099-NEC threshold (US): trailing-12-month gross commission ≥ $600 triggers W9 collection requirement before further payout.
- W8-BEN/W8-BEN-E: required for non-US affiliates before first payout regardless of threshold.
- Cap per conversion: optional `program.cap_per_conversion`. Useful for high-ticket products where 20% would exceed program economics.

Detailed payout pipeline, KYC flows, tax forms, and reconciliation rules are in `dashboard-and-payouts.md`.

---

## 11. AI rules

- No AI in the affiliate hot path (link creation, click attribution, commission compute) — these are deterministic ledger ops.
- Fraud-detection sweep job *may* call sonar-pro (default model) to summarize suspected fraud cases for admin review. Hard monthly cap: $200/mo for fraud-summary calls, hard request cap: 50/day.
- MCP scopes for affiliate data: `affiliate:read:summary` (aggregate counts only, no individual records). `affiliate:read:individual` requires explicit admin grant per session and is audit-logged.
- Tool actions (e.g. "ban this affiliate via MCP") — disabled by default. Requires explicit per-call confirmation by an authenticated admin; logged with full request_id chain.

---

## 12. Day-1 implementation order

1. Migrations: `AffiliateAccount`, `AffiliateProgram`, `AffiliateLink`, `AffiliateClick`, `AffiliateConversion`, `AffiliateCommission` (and audit/idempotency tables already present).
2. Capability tokens: `affiliate:self`, `affiliate:program:write`, `affiliate:admin`.
3. Edge `/r/:code` route with cookie set + click row write (async).
4. `POST /v1/affiliate/applications` + admin approval flow (manual review).
5. `POST /v1/affiliate/programs` + state machine transitions.
6. `POST /v1/affiliate/links` + listing endpoints.
7. Conversion capture: hook into existing `POST /v1/checkout/create-intent` (resolves click) and `charge.succeeded` webhook (writes conversion row).
8. `clawback-window-elapsed` job.
9. `commission-compute` job + `AffiliateCommission` writes.
10. `dashboard-and-payouts.md` — payout batch, Stripe Connect transfers, tax form gates.
11. Admin endpoints: clawback, release, ban.
12. Bot sweep job.

---

## 13. Test plan

### Unit
- Attribution tiebreak rules (race, consent_state precedence, deterministic older-program fallback).
- Commission compute with currency conversion.
- Clawback math at PAID and pre-PAID states.
- Self-referral detection (strict + heuristic branches).
- Bot UA classifier.
- 1099 threshold gate.

### Integration
- End-to-end click → conversion → commission → payout (happy path).
- Cookie-blocked path with `aff_token` query fallback.
- Refund-after-payout clawback.
- Cross-border currency conversion.
- Affiliate suspension mid-window.
- KYC reject hold.
- Two affiliates clicking within window (last-touch).
- Idempotent retry on `POST /v1/affiliate/links` and `POST /v1/affiliate/payouts/request`.

### E2E
- Affiliate signup → application → admin approval → link gen → simulated click → simulated checkout → see commission → request payout → KYC complete → payout transfer.
- Program owner: create program → publish → pause → resume → close → verify pending conversions still resolve.

### Load
- 10 k coach scenario: 1 M clicks/day, 10 k conversions/day. Validate p95 budgets at edge and at compute jobs.
- Bot burst: 10 M synthetic bot clicks; ensure < 1 % bypass edge filter, sweep catches the rest.

### Security
- ITP cookie scenarios (Safari, Firefox ETP).
- DNT/GPC respect.
- IP-hash never decodes back to raw IP.
- Tax form storage encrypted at rest; signed URL TTL ≤ 5 min.

---

## 14. Migration / backfill plan

Greenfield. No existing affiliate data to backfill.
- New tables only — no schema changes to existing entities.
- One small column addition reserved on `User`: a soft `affiliate_account_id` denormalized pointer for fast lookup (optional; can be a join). **OWNER decision deferred** — recommend join until profiling shows pressure.

---

## 15. Rollback plan

- Feature-flag the program at three layers: edge route `/r/:code`, conversion capture hook, payout batch job. Each can be disabled independently.
- Schema additions are pure-add; rollback = disable flags + leave tables in place.
- If a buggy commission compute is detected, freeze the `commission-compute` job, run an audit query, write corrective ledger entries (never UPDATE — append correction rows).
- All payouts go through a 24 h hold window after first transition to PAID before Stripe transfer is dispatched, allowing pre-flight reconciliation.

---

## 16. Senior-engineer onboarding checklist

- [ ] Read `docs/affiliate/README.md`, this file, `dashboard-and-payouts.md`, and Wave 7 `buyer-funnel-and-attribution.md`.
- [ ] Read TGP `audit-and-gdpr.md` and `api-conventions.md`.
- [ ] Review `AuditLog`, capability token, idempotency-key infrastructure already present in repo.
- [ ] Review existing Stripe Connect wiring from Wave 5 (`tgp-finance-app`) — affiliate payouts piggyback on the same Connect destination model with an additional ledger split.
- [ ] Confirm read-replica access and edge-route deployment topology with infra.
- [ ] Familiarize with PostHog event emission policy: aggregate only, never individual link or conversion ids.
- [ ] Read the bot-classifier rules and the daily IP-hash salt rotation schedule.
- [ ] Sit with a tax/finance owner for one hour on 1099/W8 collection mechanics.

---

## 17. Cross-repo dependency map

| Dep | Repo | Surface |
|---|---|---|
| Stripe Connect transfer execution | `tgp-finance-app` | Re-uses Wave 5 Connect destination model. Adds an "affiliate" sub-ledger split alongside coach payouts. Detailed in `tgp-finance-app/docs/billing/affiliate-payouts.md` (Wave 8 finance branch — not in this PR). |
| Mobile affiliate dashboard | `growth-project-mobile` | Read-only mirror of `GET /v1/affiliate/links` and `GET /v1/affiliate/conversions`. No native payout UI v1 (deep-link to web). |
| Admin moderation UI | `growth-project-backend` (this repo) Wave 1 admin console | New screens hooked via the canonical admin shell (`docs/admin/control-room-spec.md`). |
| Buyer funnel ledger | `growth-project-backend` Wave 7 | Conversion capture writes into the same `BuyerFunnelEvent` ledger; affiliate code read from cookie at funnel entry. |

---

## 18. Open clarifications (none blocking)

All OWNER decisions enumerated in §1 are recommendations. Implementation can proceed with the recommendations on file; OWNER may flip any of them with a follow-up PR before GA.
