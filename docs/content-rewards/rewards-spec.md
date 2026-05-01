# Content Rewards — Core Spec

> Sibling: `payout-pipeline.md`, `buyer-discovery.md`. Read README.md first.

---

## 1. Scope of this document

This document specifies:

1. The Prisma data model deltas for `ContentReward`, `ContentSubmission`, `SubmissionView`, `SubmissionFlag`, `CreatorProfile`, `RewardLeaderboardEntry`, and supporting tables.
2. The full **state-transition tables** for `ContentReward` and `ContentSubmission`.
3. The **view-verification trust ladder** (tier 1 short-link, tier 2 OAuth, tier 3 manual).
4. The **anti-fraud rule set** (bot detection, IP velocity, device fingerprint, view-burst patterns) including auto-quarantine thresholds and the manual-review queue contract.
5. **Leaderboard rules** under TGP doctrine (no public dollar exposure, relative rank only, opt-in publication).
6. The **role and permission matrix** for OWNER, COACH, SUB_COACH, CLIENT, CREATOR (polymorphic), ADMIN.
7. **API contracts** (TypeScript-shaped request/response, idempotency, error envelope).
8. **Route surface** (verb + path + auth scope + rate-limit class).
9. **Performance budgets** at 100/1k/10k coach scale.
10. **Audit, GDPR, and PII rules** for every personal-data table.
11. **>=6 failure modes** with detection and recovery.

Money flow, decimal handling, and Connect transfer choreography are in `payout-pipeline.md`. Discovery attribution is in `buyer-discovery.md`.

---

## 2. Personas + permission matrix (full)

### 2.1 Personas

| Persona | Description | Authoritative entity |
|---------|-------------|----------------------|
| OWNER | TGP staff with full platform access | (no entity row; capability-based) |
| COACH | Operator of one or more `Org`s | `Coach` |
| SUB_COACH | Delegated operator under a Coach | `SubCoach` |
| CREATOR | Polymorphic role asserted on `Coach`, `Client`, or external invitee | `CreatorProfile` joined to one of {`Coach`, `Client`, external email-only stub} |
| CLIENT | End-buyer of a coach's program | `Client` |
| ADMIN | TGP support / moderation staff | (capability) |
| SYSTEM | Internal background jobs | (no row) |

A user becomes a CREATOR by accepting the creator addendum-of-service, completing Stripe Connect Express onboarding (KYC), and agreeing to anti-fraud terms. They retain their primary role (Coach or Client) but gain creator capabilities.

### 2.2 Permission matrix (content-rewards primitives only)

| Action | OWNER | ADMIN | COACH (own pool) | SUB_COACH (delegated) | CREATOR (own submission) | CLIENT |
|--------|:-----:|:-----:|:----------------:|:---------------------:|:------------------------:|:------:|
| `reward.create` | Y | N | Y | Conditional | N | N |
| `reward.update` (pre-active) | Y | N | Y | Conditional | N | N |
| `reward.update` (post-active, restricted fields) | Y | N | Y | Conditional | N | N |
| `reward.pause` | Y | Y | Y | Conditional | N | N |
| `reward.close` | Y | Y | Y | Conditional | N | N |
| `reward.viewLedger` | Y | Y | Y | Conditional | N | N |
| `reward.list` (public) | Y | Y | Y | Y | Y | Y |
| `submission.create` | N | N | N | N | Y (own) | N |
| `submission.update` (pre-approval) | N | N | N | N | Y (own) | N |
| `submission.delete` (pre-approval) | N | N | N | N | Y (own) | N |
| `submission.approve` | Y | Y | Y (own pool) | Conditional | N | N |
| `submission.reject` | Y | Y | Y (own pool) | Conditional | N | N |
| `submission.flag` | Y | Y | Y (own pool) | Conditional | Y (own) | N |
| `submission.viewPayout` | Y | Y | Y | Conditional | Y (self) | N |
| `submission.clawback` | Y | Y | N (auto only) | N | N | N |
| `creator.profile.update` | Y | Y | N | N | Y (self) | N |
| `creator.payouts.list` | Y | Y | N | N | Y (self) | N |
| `leaderboard.viewPublic` | Y | Y | Y | Y | Y | Y |
| `leaderboard.viewPrivateRevenue` | Y | Y | Y (own pool) | Conditional | Self only | N |
| `flag.queue.read` | Y | Y | Y (own) | Conditional | N | N |
| `flag.queue.adjudicate` | Y | Y | N | N | N | N |

"Conditional" for SUB_COACH = subject to the SubCoach capability matrix from Wave 2 + Wave 5. Specifically, a SubCoach has content-rewards capability iff `SubCoach.capabilities.contentRewards = true` (boolean stored on the join row). Default: `false`.

### 2.3 Capability flags

| Flag | Description | Default | Settable by |
|------|-------------|---------|-------------|
| `org.contentRewardsEnabled` | Org may create rewards. | `false` | OWNER |
| `coach.contentRewardsEnabled` | Coach may create rewards. | inherits from `org` | OWNER, COACH (off-toggle only) |
| `subCoach.capabilities.contentRewards` | SubCoach may operate rewards on Coach's behalf. | `false` | COACH |
| `coach.creatorRoleEnabled` | Coach may also be a creator (submit clips). | `true` | OWNER |
| `client.creatorRoleEnabled` | Client may opt in as creator. | `true` | OWNER |
| `creator.kycVerified` | Creator passed Stripe Connect KYC. | `false` | SYSTEM (Stripe webhook) |

---

## 3. Prisma schema deltas (illustrative)

> All schema in this section is **illustrative**. Do NOT apply to `prisma/schema.prisma` in this PR. A separate implementation PR will apply migrations.

### 3.1 `ContentReward`

```prisma
model ContentReward {
  id                  String                @id @default(cuid())
  orgId               String
  coachId             String
  createdByUserId     String
  title               String                @db.VarChar(140)
  description         String                @db.Text
  totalPoolCents      Decimal               @db.Decimal(14, 2)
  remainingPoolCents  Decimal               @db.Decimal(14, 2)
  currency            String                @db.Char(3)        // ISO-4217
  perViewCents        Decimal               @db.Decimal(14, 6) // micro-precision; payouts rounded at submission level
  capCents            Decimal?              @db.Decimal(14, 2) // per-creator cap, optional
  platformFeeBps      Int                   @default(500)      // 5% default; OWNER_DECISION 8.A
  startsAt            DateTime
  endsAt              DateTime
  status              ContentRewardStatus   @default(DRAFT)
  tagsRequired        String[]              // e.g., ["#growthproject", "@coachhandle"]
  platforms           ContentPlatform[]     // enum array
  bannedCategories    BannedCategory[]      // enum array
  minAccountAgeDays   Int                   @default(30)       // anti-burner-account
  minFollowers        Int                   @default(0)        // optional gating
  trustTierFloor      Int                   @default(1)        // 1, 2, or 3
  audit
  gdpr

  org                 Org                   @relation(fields: [orgId], references: [id], onDelete: Cascade)
  coach               Coach                 @relation(fields: [coachId], references: [id], onDelete: Cascade)
  submissions         ContentSubmission[]
  leaderboardEntries  RewardLeaderboardEntry[]

  @@index([orgId, status])
  @@index([coachId, status])
  @@index([endsAt])
  @@map("content_rewards")
}

enum ContentRewardStatus {
  DRAFT
  PENDING_APPROVAL  // optional org-level review gate
  ACTIVE
  PAUSED
  CLOSED
  ARCHIVED
}

enum ContentPlatform {
  TIKTOK
  INSTAGRAM
  YOUTUBE
  X
  SHORT_LINK
  REDDIT
  THREADS
}

enum BannedCategory {
  HATE_SPEECH
  SELF_HARM
  ADULT
  POLITICAL
  GAMBLING
  CRYPTO_SHILLING
  HEALTH_MISINFO
  COMPETITOR_SHILLING
}
```

`audit` and `gdpr` are convention-mixin shorthand. Concretely they expand to:

```prisma
// audit fields (applied to every mutation-eligible table)
createdAt           DateTime              @default(now())
updatedAt           DateTime              @updatedAt
createdByUserId     String                // already declared above on ContentReward
deletedAt           DateTime?             // soft-delete
deletedByUserId     String?

// gdpr fields
gdprDeletionRequestedAt  DateTime?
gdprDeletionCompletedAt  DateTime?
gdprExportedAt           DateTime?
```

### 3.2 `ContentSubmission`

```prisma
model ContentSubmission {
  id                   String                  @id @default(cuid())
  rewardId             String
  creatorProfileId     String
  platform             ContentPlatform
  platformPostUrl      String?                 @db.VarChar(500)  // null if SHORT_LINK only
  shortLinkSlug        String?                 @unique
  title                String?                 @db.VarChar(280)
  capturedViews        BigInt                  @default(0)
  verifiedViews        BigInt                  @default(0)
  paidViews            BigInt                  @default(0)        // verifiedViews already paid out
  status               SubmissionStatus        @default(PENDING)
  trustTier            Int                     @default(1)
  payoutAmountCents    Decimal                 @db.Decimal(14, 2) @default(0)
  paidOutCents         Decimal                 @db.Decimal(14, 2) @default(0)
  rejectReason         String?                 @db.VarChar(280)
  flaggedAt            DateTime?
  fraudScore           Int                     @default(0)        // 0-100, higher = riskier
  perceptualHash       String?                 @db.Char(64)       // future de-dup
  audit
  gdpr

  reward               ContentReward           @relation(fields: [rewardId], references: [id], onDelete: Cascade)
  creator              CreatorProfile          @relation(fields: [creatorProfileId], references: [id], onDelete: Cascade)
  views                SubmissionView[]
  flags                SubmissionFlag[]
  payoutInstructions   PayoutInstruction[]

  @@unique([rewardId, creatorProfileId, platformPostUrl])  // prevent same URL re-submitted to same pool
  @@index([rewardId, status])
  @@index([creatorProfileId, status])
  @@index([status, fraudScore])
  @@map("content_submissions")
}

enum SubmissionStatus {
  PENDING            // submitted, awaiting initial verification
  UNDER_REVIEW       // flagged by anti-fraud or coach, paused
  APPROVED           // verified, accruing payouts
  REJECTED           // permanently rejected
  PAID_PARTIAL       // some views paid, more accruing
  PAID_FINAL         // pool exhausted or campaign closed; no more accrual
  CLAWED_BACK        // payout reversed due to fraud/refund
}
```

### 3.3 `SubmissionView`

Per-view tally rows. We do NOT store one row per view (that would be 10M+ rows for a viral clip). Instead we store **rollup samples** at fixed cadences.

```prisma
model SubmissionView {
  id                String              @id @default(cuid())
  submissionId      String
  source            ViewSource
  capturedViews     BigInt
  verifiedViews     BigInt
  fraudFilteredOut  BigInt              @default(0)
  capturedAt        DateTime            @default(now())
  windowStart       DateTime
  windowEnd         DateTime
  raw               Json?               // platform raw response

  submission        ContentSubmission   @relation(fields: [submissionId], references: [id], onDelete: Cascade)

  @@index([submissionId, capturedAt])
  @@map("submission_views")
}

enum ViewSource {
  SHORT_LINK_LOG     // tier 1
  TIKTOK_OAUTH       // tier 2
  INSTAGRAM_GRAPH    // tier 2
  YOUTUBE_DATA_API   // tier 2
  X_API              // tier 2
  MANUAL_REVIEW      // tier 3
  RECONCILIATION     // daily reconcile job
}
```

### 3.4 `SubmissionFlag`

```prisma
model SubmissionFlag {
  id                String              @id @default(cuid())
  submissionId      String
  flagType          FlagType
  severity          Int                 // 1-10
  raisedByUserId    String?             // null if SYSTEM
  raisedBySystem    Boolean             @default(false)
  payload           Json
  status            FlagStatus          @default(OPEN)
  resolvedAt        DateTime?
  resolvedByUserId  String?
  resolution        String?             @db.VarChar(280)
  audit

  submission        ContentSubmission   @relation(fields: [submissionId], references: [id], onDelete: Cascade)

  @@index([submissionId, status])
  @@index([status, severity])
  @@map("submission_flags")
}

enum FlagType {
  BOT_TRAFFIC
  IP_VELOCITY
  DEVICE_FINGERPRINT_REUSE
  VIEW_BURST_PATTERN
  CONTENT_POLICY_VIOLATION
  PLATFORM_DELETED
  CREATOR_REPORTED
  COACH_REPORTED
  PERCEPTUAL_HASH_DUPLICATE  // v2
}

enum FlagStatus {
  OPEN
  UNDER_REVIEW
  UPHELD
  DISMISSED
  ESCALATED
}
```

### 3.5 `CreatorProfile`

Polymorphic creator role.

```prisma
model CreatorProfile {
  id                  String              @id @default(cuid())
  // exactly one of the following two must be non-null
  coachId             String?             @unique
  clientId            String?             @unique
  // OR external email-only invitee (no Coach/Client row yet)
  externalEmail       String?             @unique @db.VarChar(320)
  externalName        String?             @db.VarChar(140)

  displayHandle       String              @unique @db.VarChar(40)
  bio                 String?             @db.Text
  primaryPlatform     ContentPlatform?
  socialHandles       Json?               // {tiktok: "@x", instagram: "@y", ...}

  // Stripe Connect
  stripeAccountId     String?             @unique
  kycStatus           KycStatus           @default(NOT_STARTED)
  payoutCurrency      String              @db.Char(3) @default("USD")

  // Trust + fraud aggregates
  trustTier           Int                 @default(1)
  lifetimePaidCents   Decimal             @db.Decimal(14, 2) @default(0)
  totalSubmissions    Int                 @default(0)
  approvedSubmissions Int                 @default(0)
  rejectedSubmissions Int                 @default(0)
  flagCount           Int                 @default(0)

  // 1099 / tax
  taxYear1099Cents    Json?               // {2026: 750.00, ...}

  // Privacy
  publicLeaderboardOptIn Boolean          @default(false)

  audit
  gdpr

  coach              Coach?               @relation(fields: [coachId], references: [id], onDelete: SetNull)
  client             Client?              @relation(fields: [clientId], references: [id], onDelete: SetNull)
  submissions        ContentSubmission[]
  payoutInstructions PayoutInstruction[]

  @@map("creator_profiles")
}

enum KycStatus {
  NOT_STARTED
  PENDING
  ACTION_REQUIRED
  VERIFIED
  REJECTED
  RESTRICTED
}
```

GDPR: `CreatorProfile` is personal data. Cascade delete from `Client` or `Coach` deletion sets `coachId`/`clientId` to null but retains anonymised aggregates for fraud-history purposes (see §10).

### 3.6 `RewardLeaderboardEntry`

Materialised leaderboard view. Refreshed on submission state change and hourly cron.

```prisma
model RewardLeaderboardEntry {
  id                String              @id @default(cuid())
  rewardId          String
  creatorProfileId  String
  rank              Int
  verifiedViews     BigInt
  approvedClips     Int
  // dollar amount intentionally OMITTED from public surface
  payoutAmountCents Decimal             @db.Decimal(14, 2)  // private; surfaced only with creator opt-in
  computedAt        DateTime            @default(now())

  reward            ContentReward       @relation(fields: [rewardId], references: [id], onDelete: Cascade)
  creator           CreatorProfile      @relation(fields: [creatorProfileId], references: [id], onDelete: Cascade)

  @@unique([rewardId, creatorProfileId])
  @@index([rewardId, rank])
  @@map("reward_leaderboard_entries")
}
```

### 3.7 `PayoutInstruction`

Owned by `payout-pipeline.md`; declared here for FK clarity.

```prisma
model PayoutInstruction {
  id                  String              @id @default(cuid())
  submissionId        String?
  affiliateCommissionId String?           // present for affiliate path
  creatorProfileId    String?
  affiliateId         String?
  amountCents         Decimal             @db.Decimal(14, 2)
  currency            String              @db.Char(3)
  idempotencyKey      String              @unique
  status              PayoutInstructionStatus
  stripeTransferId    String?
  emittedAt           DateTime            @default(now())
  completedAt         DateTime?
  failureReason       String?

  submission        ContentSubmission?    @relation(fields: [submissionId], references: [id])
  creator           CreatorProfile?       @relation(fields: [creatorProfileId], references: [id])

  @@index([status])
  @@index([emittedAt])
  @@map("payout_instructions")
}

enum PayoutInstructionStatus {
  PENDING
  EMITTED        // sent to finance-app via domain event
  IN_FLIGHT      // finance-app acknowledged, transferring
  SUCCEEDED
  FAILED
  CLAWED_BACK
}
```

---

## 4. State-transition tables

### 4.1 `ContentReward.status`

| From | To | Trigger | Authorised by | Side-effects |
|------|----|---------|---------------|--------------|
| (none) | DRAFT | `reward.create` | COACH/SUB_COACH/OWNER | Audit row; pool not yet funded |
| DRAFT | PENDING_APPROVAL | `reward.submitForReview` (org-level review enabled) | COACH | Notification to org admin |
| DRAFT | ACTIVE | `reward.publish` (no review required) + funding completes | COACH | Stripe charges coach `totalPoolCents`; `remainingPoolCents := totalPoolCents - platformFee`; pool visible to creators |
| PENDING_APPROVAL | ACTIVE | `reward.approve` + funding completes | OWNER/ORG_ADMIN | Same as DRAFT→ACTIVE |
| PENDING_APPROVAL | DRAFT | `reward.reject` | OWNER/ORG_ADMIN | Reason recorded |
| ACTIVE | PAUSED | `reward.pause` | COACH/OWNER | New submissions blocked; existing accrual continues at zero rate (frozen) |
| PAUSED | ACTIVE | `reward.resume` | COACH/OWNER | Accrual resumes |
| ACTIVE | CLOSED | pool exhausted (auto) | SYSTEM | All `APPROVED` submissions move to `PAID_FINAL`; remaining views unfunded; coach receives summary |
| ACTIVE | CLOSED | `endsAt` reached (auto) | SYSTEM | Same as above |
| ACTIVE | CLOSED | `reward.closeEarly` | COACH/OWNER | Refund of `remainingPoolCents` to coach; existing approved views paid up to that moment |
| PAUSED | CLOSED | same as ACTIVE→CLOSED triggers | SYSTEM/COACH/OWNER | Same |
| CLOSED | ARCHIVED | 90 days post-close (auto) | SYSTEM | Read-only; ledger preserved; submissions remain queryable for tax purposes |

Once `CLOSED`, no new submissions accepted; existing payout instructions complete on their own pipeline.

### 4.2 `ContentSubmission.status`

| From | To | Trigger | Authorised by | Side-effects |
|------|----|---------|---------------|--------------|
| (none) | PENDING | `submission.create` | CREATOR | Submission audit row; tier-1 verification job enqueued |
| PENDING | UNDER_REVIEW | anti-fraud rule fires `severity >= 5` | SYSTEM | `flag` row; email to coach if SLA threshold breached |
| PENDING | UNDER_REVIEW | manual coach flag | COACH | Same |
| PENDING | APPROVED | tier-1 verification passes + below auto-approve threshold | SYSTEM | Begin accrual |
| PENDING | APPROVED | coach manual approve | COACH | Begin accrual |
| PENDING | REJECTED | tier-1 verification finds platform-policy hit (e.g., banned-category classifier) | SYSTEM | Reason recorded; creator notified |
| PENDING | REJECTED | coach manual reject | COACH | Reason mandatory |
| UNDER_REVIEW | APPROVED | flag dismissed by reviewer | OWNER/ADMIN/COACH | Resume accrual |
| UNDER_REVIEW | REJECTED | flag upheld | OWNER/ADMIN/COACH | Permanent reject |
| APPROVED | PAID_PARTIAL | first payout instruction emitted | SYSTEM | `paidOutCents` updated |
| PAID_PARTIAL | PAID_PARTIAL | subsequent payout instruction | SYSTEM | Cumulative |
| PAID_PARTIAL | PAID_FINAL | reward CLOSED OR cap reached OR creator-cap reached | SYSTEM | No further accrual |
| APPROVED | PAID_FINAL | direct (small clip, single payout cycle) | SYSTEM | Single payout |
| APPROVED | UNDER_REVIEW | post-approval flag (e.g., reconciliation job detects view-burst anomaly) | SYSTEM | Pause accrual |
| PAID_PARTIAL | UNDER_REVIEW | same | SYSTEM | Pause accrual; existing paid amount NOT auto-reversed |
| PAID_PARTIAL | CLAWED_BACK | flag upheld AND fraud confirmed | OWNER/ADMIN | Reverse paid transfers via finance-app (negative `PayoutInstruction`) |
| PAID_FINAL | CLAWED_BACK | same | OWNER/ADMIN | Same |
| any | REJECTED (with audit "withdrawn") | creator self-withdraws pre-approval | CREATOR | Hard delete pending soft-delete window |

### 4.3 `KycStatus` (CreatorProfile.kycStatus)

| From | To | Trigger | Authorised by |
|------|----|---------|---------------|
| NOT_STARTED | PENDING | creator initiates onboarding | CREATOR |
| PENDING | ACTION_REQUIRED | Stripe webhook `account.updated` indicates required docs | SYSTEM (webhook) |
| ACTION_REQUIRED | PENDING | creator submits docs | CREATOR |
| PENDING | VERIFIED | Stripe webhook indicates `charges_enabled=true && payouts_enabled=true` | SYSTEM (webhook) |
| VERIFIED | RESTRICTED | Stripe restricts (compliance, fraud) | SYSTEM (webhook) |
| any | REJECTED | Stripe rejects | SYSTEM (webhook) |

Until `KycStatus = VERIFIED`, no `PayoutInstruction` may emit for the creator. Pre-KYC submissions accrue but `PayoutInstruction.status = PENDING` indefinitely.

---

## 5. View-verification trust ladder

The trust ladder governs **how confidently we believe a view count** and consequently **how much we will auto-pay**. There are three tiers.

### 5.1 Tier 1 — Short-link wrapper (server-side log)

When a creator submits a clip, they include a TGP short-link in the platform post (e.g., bio, comment, description). Every viewer who clicks the short-link is logged server-side by TGP.

- **Trust:** Highest for *clicks*, but a click ≠ a view. Used as a **lower-bound floor** when the platform doesn't expose impressions.
- **Auth model:** No OAuth required. Public log endpoint with bot-filtering.
- **Coverage:** ~100% (any post can include a link).
- **Failure mode:** A clip can go viral with views but few clicks; tier 1 alone undercounts. Mitigated by tier 2.
- **Eligibility:** Up to **$50 lifetime per creator** payouts auto-approve on tier 1 alone (OWNER_DECISION 8.B Option A).

#### 5.1.1 Short-link envelope

```ts
// Short-link redirect endpoint contract
// GET /r/:slug
// Server-side: log click with bot/anomaly filter, then 302 to coach page or platform
// Public, no auth
//
// Headers captured (PII-aware): IP (hashed), User-Agent, Referer, Accept-Language
// Cookies set: tgp_attr (signed JWT, 30-day, includes click-id, slug, t)
//
// Bot filter: known-bad UA list, datacenter IP ranges, headless browser fingerprints,
// no JS challenge for redirect (would break viral mechanics) but post-redirect
// JS-fingerprint enrichment via /r/_e?id=<click-id> (best-effort).

interface ShortLinkClickLog {
  clickId: string;             // ULID
  slug: string;
  submissionId: string;        // resolved at insert
  ipHashed: string;            // sha256(ip + daily salt)
  userAgentRaw: string;
  userAgentClass: 'BROWSER' | 'BOT' | 'CRAWLER' | 'HEADLESS' | 'UNKNOWN';
  referer: string | null;
  countryCode: string | null;  // GeoIP, not stored to PostHog
  capturedAt: string;          // ISO
  fingerprintHash: string | null;  // populated by /r/_e if JS executed
  fraudScore: number;          // 0-100
}
```

### 5.2 Tier 2 — OAuth platform integration

The creator authenticates via OAuth on TGP and grants read access to their post analytics. We poll the platform's official metrics endpoint.

- **Trust:** High. Platform-reported impressions are authoritative for that platform.
- **Coverage:** ~85% of creators willing to OAuth.
- **APIs used:**
  - **TikTok Display API** + **TikTok for Developers Marketing API** (aggregate views per video).
  - **Instagram Graph API** (Reels insights via `/me/media/{id}/insights`).
  - **YouTube Data API v3** (`videos.list` `statistics.viewCount`).
  - **X API v2** (`tweets/:id/metrics/private` if available; else public impression count).
- **Polling cadence:** 15 min for first 24 h, hourly for next 7 days, every 6 h thereafter, until reward CLOSED.
- **Rate limits:** Each platform has limits; TGP queues requests with token-bucket per-creator and per-platform.
- **Failure mode:** Platform API outages, OAuth token expiry, video deleted. See §8.
- **Eligibility:** Required for payouts >$50 lifetime per creator AND for any single submission >$50 payout.

#### 5.2.1 Verification fetcher contract

```ts
interface PlatformViewFetcher {
  platform: ContentPlatform;
  fetchViews(input: {
    creatorProfileId: string;
    submissionId: string;
    platformPostUrl: string;
    accessToken: string;       // resolved from OAuth store
  }): Promise<{
    capturedViews: bigint;
    fetchedAt: string;
    raw: unknown;              // platform raw response, redacted
  } | { error: PlatformFetchError }>;
}

type PlatformFetchError =
  | { code: 'TOKEN_EXPIRED' }
  | { code: 'POST_NOT_FOUND' }
  | { code: 'POST_DELETED' }
  | { code: 'POST_PRIVATE' }
  | { code: 'RATE_LIMITED'; retryAfterSec: number }
  | { code: 'PLATFORM_5XX' }
  | { code: 'UNAUTHORISED' };
```

### 5.3 Tier 3 — Manual review

A human reviewer (TGP ADMIN or, optionally, the COACH for their own pool) confirms the view count visually, screenshots the post analytics, and records the count.

- **Trust:** Highest, but slow and expensive.
- **Coverage:** Variable (depends on staffing).
- **SLA:** 48 h to first review on submissions in the queue.
- **Eligibility:** Required for any single submission with payout > $500.

#### 5.3.1 Manual review record

```ts
interface ManualReviewRecord {
  submissionId: string;
  reviewerUserId: string;
  reviewedAt: string;
  capturedViews: bigint;
  screenshotS3Key: string;
  notes: string;
  decision: 'APPROVE' | 'PARTIAL_APPROVE' | 'REJECT';
  partialViewsApproved?: bigint;  // when decision = PARTIAL_APPROVE
  signatureHash: string;          // sha256 of (reviewerUserId + submissionId + capturedViews + reviewedAt + ENV.MANUAL_REVIEW_SECRET)
}
```

### 5.4 Trust-tier escalation rules

| Condition | Required tier |
|-----------|---------------|
| `creator.lifetimePaidCents <= $50` AND `submission.payoutAmountCents <= $50` | Tier 1 sufficient |
| `creator.lifetimePaidCents > $50` OR `submission.payoutAmountCents > $50` | Tier 2 required |
| `submission.payoutAmountCents > $500` | Tier 3 required IN ADDITION |
| `reward.trustTierFloor = 2` (coach override) | Tier 2 from cent zero |
| `reward.trustTierFloor = 3` (coach override) | Tier 3 from cent zero |
| `submission.fraudScore >= 60` | Tier 3 required |

---

## 6. Anti-fraud rules

The anti-fraud subsystem produces a `fraudScore` (0-100) per submission and per view-window. Score components are summed and clamped.

### 6.1 Rule list

| Rule | Trigger | Score weight | Action |
|------|---------|:------------:|--------|
| `BOT_TRAFFIC` | Short-link clicks where `userAgentClass = BOT` exceed 10% of total | +30 | Quarantine if score crosses 60 |
| `IP_VELOCITY` | Same hashed IP click bucket exceeds 50 in 1 hour | +20 | Quarantine on >100 |
| `DATACENTER_IP` | Click IP belongs to known datacenter ASN (AWS, GCP, OVH, etc.) | +15 | Filter from verifiedViews |
| `DEVICE_FINGERPRINT_REUSE` | Same fingerprint hash drives >25% of clicks for a single submission | +25 | Quarantine |
| `VIEW_BURST_PATTERN` | `dViews/dt` > 10x median creator-baseline for >2 hours then drops | +20 | UNDER_REVIEW |
| `PLATFORM_VIEWS_VS_LINK_CLICKS_DIVERGENCE` | Tier-2 platform views < 5% of tier-1 clicks (or > 20x) | +15 | Manual review |
| `CONTENT_POLICY_VIOLATION` | Classifier (perplexity/sonar-pro vision) flags banned-category | +50 | Auto-reject; payout = 0 |
| `PERCEPTUAL_HASH_DUPLICATE` (v2) | Hash matches existing submission to another reward | +35 | Quarantine; manual review |
| `ACCOUNT_AGE_BELOW_FLOOR` | Creator's platform handle <30 days old | +10 | Tier-2 required |
| `HIGH_REJECTION_RATIO` | Creator's `rejectedSubmissions / totalSubmissions > 0.4` | +20 | Quarantine new submissions until reviewed |
| `KYC_RISK_FLAG` | Stripe Connect Express flags risk | +30 | Tier-3 required, payout held |

### 6.2 Score thresholds

| Score | Action |
|-------|--------|
| 0-29 | Normal accrual |
| 30-44 | Flag opened, accrual continues (warning) |
| 45-59 | Tier-2 required immediately |
| 60-79 | Auto-quarantine (UNDER_REVIEW); manual review required |
| 80-100 | Auto-reject; creator account flagged for trust-tier downgrade |

### 6.3 Manual review queue

```ts
// GET /admin/content-rewards/review-queue
// Auth: ADMIN or coach (own pool)
// Returns: paginated list of UNDER_REVIEW submissions, sorted by oldest-first,
// with all flag reasons, fraud score, current verifiedViews, and tier-2 view fetch
// status if available.

interface ReviewQueueItem {
  submissionId: string;
  rewardId: string;
  rewardTitle: string;
  creatorHandle: string;
  creatorTrustTier: number;
  fraudScore: number;
  flags: Array<{
    flagType: FlagType;
    severity: number;
    raisedBySystem: boolean;
    raisedAt: string;
    payloadSummary: string;
  }>;
  capturedViews: number;
  verifiedViews: number;
  currentPayoutAccrued: number;   // cents
  ageInQueueHours: number;
  slaBreached: boolean;            // age > 48h
  platformPostUrl: string | null;
  platformPreviewThumbnail: string | null;  // s3 key
}

// POST /admin/content-rewards/review-queue/:submissionId/decide
// Body: { decision: 'APPROVE' | 'REJECT' | 'PARTIAL_APPROVE'; reason: string;
//         partialViewsApproved?: number; }
// Idempotency-Key required.
```

### 6.4 Trust-tier downgrade on creator

A creator is downgraded a trust tier (max → 1) on:

- 3 confirmed-fraud submissions in trailing 365 days, OR
- 1 confirmed CSAM/HATE_SPEECH classification, OR
- Stripe Connect risk-restriction.

Downgrade is logged in `CreatorProfile.audit` and surfaced to the creator.

### 6.5 Auto-quarantine SLA

If a submission sits UNDER_REVIEW for >7 days without adjudication:

- If submitted by a tier-3 (manual-only) creator: stays UNDER_REVIEW indefinitely.
- Otherwise: auto-rejects with reason `SLA_BREACHED_NO_REVIEWER` and notifies coach + creator. Creator may re-submit once.

---

## 7. Leaderboard rules (TGP doctrine compliance)

Per Wave 2 + Wave 10 doctrine: **no public dollar exposure**, **no shame mechanics**, **quiet reinforcement only**.

### 7.1 Public leaderboard surface

For a given `ContentReward`, the public leaderboard exposes:

- **Rank** (1, 2, 3, ...) — only top 10 publicly visible.
- **Creator displayHandle** — if `publicLeaderboardOptIn = true`. Otherwise `Creator #4823` (anonymised stable ID).
- **Approved clip count**.
- **Verified view count, bucketed** (`<10k`, `10k-50k`, `50k-100k`, `>100k`). Exact view counts NOT exposed.
- **NO dollar amounts.**

### 7.2 Private (creator self-view) surface

A creator can see their own:

- Exact verified views.
- Exact dollar accrual.
- Per-submission breakdown.
- Trust tier and fraud score (creator's own, not others').

### 7.3 Coach (pool owner) surface

The coach owning the pool sees:

- All submissions, all dollar amounts, all creator handles.
- Aggregate pool burn-down chart.
- Cost per acquired buyer (cross-link to `buyer-discovery.md`).

### 7.4 Refresh cadence

- On submission state-change: enqueue leaderboard recompute job (debounced 60s per `rewardId`).
- Hourly cron: recompute all ACTIVE rewards.
- Daily cron: recompute closed rewards within last 30 days for tax/reconciliation purposes.

### 7.5 Leaderboard audit + integrity

Every leaderboard recompute snapshot is hashed (sha256 of canonical JSON) and stored. Disputes are adjudicated against the snapshot at the disputed time, not the live state.

---

## 8. Failure modes (>=6, with detection + recovery)

### 8.1 Failure: Platform API outage during tier-2 fetch

**Detection:** Fetch returns 5xx for >50% of calls in a 15-minute window. Circuit breaker opens.

**Recovery:**
- Pause polling for that platform; backoff exponentially up to 6 h.
- Continue accruing on tier-1 short-link if `submission.payoutAmountCents < $50`.
- For >$50 submissions: hold payout (`PayoutInstruction.status = PENDING`); notify creator via async banner ("verification temporarily delayed"); recompute when platform restored.
- Reconciliation job (daily) replays missed windows and back-fills.

### 8.2 Failure: Coach over-funds pool then disputes Stripe charge

**Detection:** Stripe webhook `charge.dispute.created` for the funding charge.

**Recovery:**
- Immediately move reward to `PAUSED`.
- Freeze all pending payouts on submissions in the pool.
- Existing paid-out transfers stand temporarily (we eat the cost short-term to protect creators); coach is liable per ToS.
- If dispute resolved in TGP's favour: resume reward, no refund.
- If dispute lost: pursue collections under coach contract; if uncollectible, file as fraud loss.
- After 7 days paused without resolution: convert to `CLOSED`, refund unpaid balance to creators where ethically defensible.

### 8.3 Failure: Creator's Stripe Connect account fails KYC mid-campaign

**Detection:** Webhook `account.updated` with `requirements.disabled_reason != null` or `payouts_enabled = false`.

**Recovery:**
- Set `CreatorProfile.kycStatus = RESTRICTED`.
- Halt all `PayoutInstruction` emission for that creator.
- Allow continued accrual (so creator doesn't lose retroactively if KYC clears).
- If KYC fails permanently after 30 days: forfeit accrual per ToS; views attributed to that creator are removed from pool burn-down (NOT redistributed; pool simply has less efficient burn).
- Notify creator with explicit remediation steps.

### 8.4 Failure: Viral clip but creator's link de-indexed by platform

**Detection:** Sudden tier-1 short-link click drop to ~0 while tier-2 platform views still rising.

**Recovery:**
- Trigger `PLATFORM_VIEWS_VS_LINK_CLICKS_DIVERGENCE` flag.
- Treat tier-2 as authoritative; do NOT apply tier-1-floor under-count penalty.
- Notify creator they may have been shadow-de-linked; suggest alternate distribution (comment, pinned reply).

### 8.5 Failure: Bot-driven view inflation post-payout

**Detection:** Reconciliation job (daily) compares historical vs current platform view count; if delta is impossibly large given a clip's typical decay curve, raise `VIEW_BURST_PATTERN` flag retroactively.

**Recovery:**
- Move submission to `UNDER_REVIEW`.
- Pause future accrual.
- Tier-3 manual review.
- If fraud confirmed: emit negative `PayoutInstruction` (clawback). Submission state = `CLAWED_BACK`.
- If creator account had no prior fraud: warning + trust-tier downgrade; no permanent ban.
- If creator has a prior confirmed fraud: ban + Stripe Connect closure + report to platform-of-origin if ToS-violating.

### 8.6 Failure: Banned-category content reaches APPROVED before classifier catches it

**Detection:** Async classifier batch job (4x/day) re-scans ALL APPROVED submissions; raises `CONTENT_POLICY_VIOLATION` flag retroactively. Also human-reported.

**Recovery:**
- Move to `UNDER_REVIEW` immediately.
- Halt accrual.
- Manual review within 24 h.
- If upheld: REJECTED; clawback for amounts already paid (>$0); notify creator with reason; reduce coach's cost-per-view ledger entry to 0 for the affected views.
- If false positive: APPROVE; resume accrual; accumulate classifier confusion-matrix data for retraining.

### 8.7 Failure: Pool double-spent due to race condition

**Detection:** `remainingPoolCents` goes negative after concurrent payout-instruction emission.

**Recovery:**
- Database constraint `CHECK (remainingPoolCents >= 0)` should prevent this; if it ever fires, the failing transaction rolls back.
- Implementation MUST use serializable isolation for any update to `remainingPoolCents`.
- If the constraint fires in production: alarm fires; pause all payout emission for that reward; ops investigates ledger.
- Contingency: TGP eats the short overage from float; corrects in post-mortem.

### 8.8 Failure: Coach changes pool perViewCents mid-campaign trying to game payouts

**Detection:** Update API rejects the change for fields locked post-ACTIVE (`perViewCents`, `capCents`, `currency`, `platformFeeBps`).

**Recovery:** Update API returns 422 with `code: 'FIELD_IMMUTABLE_POST_ACTIVE'`. Allowed: `endsAt` extension, `description` update, `tagsRequired` extension (but not removal). Audit log records every attempted change.

### 8.9 Failure: Creator submits stolen/copyright-violating clip

**Detection:** Platform takedown notice (DMCA) → automated webhook from platform OR coach manual report.

**Recovery:**
- Submission → `UNDER_REVIEW`.
- Halt accrual.
- Notify creator; require creator to provide source attribution within 7 days.
- If fails: REJECTED + clawback.
- If creator escalates and dispute is platform-side (not TGP's): we maintain neutrality; reject is final on platform takedown.

---

## 9. API contracts

### 9.1 Common envelope

```ts
// Success envelope
type Ok<T> = { ok: true; data: T };

// Error envelope (consistent across the wave)
type Err = {
  ok: false;
  error: {
    code: string;             // SCREAMING_SNAKE_CASE
    message: string;          // human-readable
    details?: Record<string, unknown>;
    requestId: string;
  };
};

// All endpoints accept Idempotency-Key header on POST/PATCH.
// All endpoints return X-Request-Id header.
```

### 9.2 Reward CRUD

```ts
// POST /api/v1/content-rewards
// Auth: COACH or SUB_COACH (with capability) or OWNER
// Rate-limit class: WRITE_LOW (10/min/user)
// Idempotency: required

interface CreateRewardRequest {
  orgId: string;
  title: string;
  description: string;
  totalPoolCents: string;          // decimal string ("1000.00")
  currency: string;                // ISO-4217
  perViewCents: string;            // decimal string, micro precision
  capCents?: string;               // optional per-creator cap
  startsAt: string;                // ISO
  endsAt: string;                  // ISO
  tagsRequired: string[];
  platforms: ContentPlatform[];
  bannedCategories?: BannedCategory[];
  minAccountAgeDays?: number;
  minFollowers?: number;
  trustTierFloor?: 1 | 2 | 3;
}
// Response: Ok<{ rewardId: string; status: 'DRAFT' }>
// Errors: VALIDATION_FAILED, INSUFFICIENT_FUNDS_AT_FUNDING (deferred), CAPABILITY_DENIED

// POST /api/v1/content-rewards/:id/publish
// Auth: COACH (owner) or OWNER
// Rate-limit class: WRITE_LOW
// Idempotency: required
// Side effect: triggers Stripe charge for `totalPoolCents`. 200 only if charge confirmed.

// PATCH /api/v1/content-rewards/:id
// Allowed fields pre-ACTIVE: all
// Allowed fields post-ACTIVE: { description, endsAt (extension only), tagsRequired (additive only) }
// Errors: FIELD_IMMUTABLE_POST_ACTIVE

// POST /api/v1/content-rewards/:id/pause
// POST /api/v1/content-rewards/:id/resume
// POST /api/v1/content-rewards/:id/close
// All: idempotency required.

// GET /api/v1/content-rewards
// Query: ?orgId=&coachId=&status=&platform=&page=&pageSize=
// Auth: any role; results filtered by capability
// Rate-limit: READ_PUBLIC
```

### 9.3 Submission CRUD

```ts
// POST /api/v1/content-submissions
// Auth: CREATOR
// Rate-limit class: WRITE_HIGH (60/min/user, with burst protection)
// Idempotency: required

interface CreateSubmissionRequest {
  rewardId: string;
  platform: ContentPlatform;
  platformPostUrl?: string;
  shortLinkSlug?: string;          // server-generated if absent
  title?: string;
}
// Response: Ok<{ submissionId: string; status: 'PENDING'; trustTier: number }>
// Errors: REWARD_NOT_ACTIVE, CREATOR_KYC_NOT_VERIFIED (warn-only at submit; block at payout),
// REWARD_PLATFORM_NOT_SUPPORTED, DUPLICATE_SUBMISSION_FOR_URL, BANNED_CATEGORY_PRESCREEN_FAIL

// GET /api/v1/content-submissions/:id
// GET /api/v1/content-submissions?creatorProfileId=&rewardId=&status=

// PATCH /api/v1/content-submissions/:id  // creator self-edit pre-approval
// DELETE /api/v1/content-submissions/:id  // creator self-withdraw pre-approval

// POST /api/v1/content-submissions/:id/approve   // coach/admin
// POST /api/v1/content-submissions/:id/reject    // coach/admin
// POST /api/v1/content-submissions/:id/flag      // anyone (creator-self, coach, admin)
```

### 9.4 Verification webhooks (inbound from platforms)

See `payout-pipeline.md` §6 for full webhook contract; cross-link only.

### 9.5 Creator profile

```ts
// POST /api/v1/creator-profiles  // self-create (opt-in)
// GET /api/v1/creator-profiles/me
// PATCH /api/v1/creator-profiles/me
// POST /api/v1/creator-profiles/me/connect-onboarding   // initiate Stripe Connect Express
// GET /api/v1/creator-profiles/me/payouts               // self payout history
```

### 9.6 Leaderboard

```ts
// GET /api/v1/content-rewards/:id/leaderboard
// Auth: any role
// Returns: top 10 entries, public-safe view (rank, handle-or-anon, clip count, view bucket)
// Coach owner gets full view including dollar amounts.
// Creator gets full view of their own row only.
```

---

## 10. Audit, GDPR, PII

### 10.1 Audit logging

Every mutation (reward create/update/state-transition, submission create/update/state-transition, flag raise/resolve, payout emit/clawback) emits an `AuditLog` row:

```prisma
model AuditLog {
  id              String     @id @default(cuid())
  orgId           String?
  actorUserId     String?
  actorIsSystem   Boolean    @default(false)
  entityType      String     // 'ContentReward' | 'ContentSubmission' | ...
  entityId        String
  action          String     // 'create' | 'update' | 'state.PAUSED' | ...
  beforeJson      Json?
  afterJson       Json?
  requestId       String
  ip              String?    // hashed
  userAgent       String?
  createdAt       DateTime   @default(now())

  @@index([entityType, entityId, createdAt])
  @@index([orgId, createdAt])
  @@map("audit_logs")
}
```

### 10.2 GDPR delete contract

`CreatorProfile`:
- On hard-delete (creator-initiated GDPR delete): scrub `displayHandle`, `bio`, `socialHandles`, `externalEmail`, `externalName`. Retain anonymised aggregate row (id + `lifetimePaidCents` + `flagCount`) for fraud-history purposes for 5 years (legitimate interest under GDPR 6(1)(f)). Disclose this in privacy policy.
- `submissions`, `views`, `flags`, `payoutInstructions` remain (financial records, 7-year retention obligation).
- Deletion event logged.

`ContentSubmission`:
- Tied to `CreatorProfile`. No independent GDPR profile.

`ContentReward`:
- Coach-owned. On coach delete: cascade soft-delete; coach gets export of pool ledger before delete.

### 10.3 PII exclusions from PostHog

The following are NEVER sent to PostHog event payloads:
- IP address (raw or hashed).
- Email.
- Stripe IDs.
- Creator legal name.
- Bank account / payout details.

Allowed in PostHog: `creatorProfileId`, `submissionId`, `rewardId`, `orgId`, anonymised metric counts, state transitions.

### 10.4 Encryption at rest

- `CreatorProfile.externalEmail`, `socialHandles`, `taxYear1099Cents`: encrypted at rest via Postgres TDE + application-layer envelope encryption for highly sensitive fields (emergent KMS pattern from Wave 5).
- `SubmissionView.raw`: redacted (PII stripped) before persistence.

### 10.5 Right to export

Creator can request export. JSON export contains:
- `CreatorProfile` row (their own).
- All their `ContentSubmission` rows + view summaries.
- All their `PayoutInstruction` rows.
- Audit logs where `actorUserId = creator.userId`.

Export is generated within 30 days per GDPR. Delivered via signed S3 link expiring in 7 days.

---

## 11. Performance budgets

### 11.1 At 100 coaches

- ~50 active rewards. ~500 submissions/day. ~200k tier-1 short-link clicks/day.
- p50 `POST /content-submissions` < 80ms; p95 < 250ms.
- p50 `GET /content-rewards/:id/leaderboard` < 40ms (cached); p95 < 120ms.
- Anti-fraud rule eval p50 < 30ms per click event.
- Reconciliation job runtime <5 min nightly.

### 11.2 At 1k coaches

- ~500 active rewards. ~5k submissions/day. ~2M short-link clicks/day.
- p50 `POST /content-submissions` < 100ms; p95 < 350ms.
- p50 `GET /content-rewards/:id/leaderboard` < 60ms (cached, 60s TTL); p95 < 200ms.
- Anti-fraud rule eval p50 < 40ms.
- Tier-2 OAuth poller throughput: 50 fetches/sec sustained, 200/sec burst.
- Reconciliation job runtime <30 min.

### 11.3 At 10k coaches

- ~5k active rewards. ~50k submissions/day. ~20M short-link clicks/day.
- Read-replica required for leaderboard reads.
- Materialised leaderboard tables refreshed via dedicated worker pool.
- Anti-fraud rule eval moves to dedicated service (still <50ms p50).
- Tier-2 OAuth poller: sharded by `creatorProfileId % N`, 500 fetches/sec sustained.
- Reconciliation job: parallelised, runtime <90 min.
- Short-link redirect endpoint: edge-cached at CDN; click logging via async queue (Kafka or equivalent).

### 11.4 Cache TTL summary

| Surface | TTL | Read source |
|---------|-----|-------------|
| `GET /content-rewards/:id` (public fields) | 60s | replica |
| `GET /content-rewards/:id/leaderboard` (public) | 60s | replica + materialised |
| `GET /content-rewards` (list, public filters) | 30s | replica |
| `GET /creator-profiles/me` | no-cache | primary |
| `GET /content-submissions/:id` (creator self) | no-cache | primary |
| `GET /content-rewards/:id/ledger` (coach owner) | no-cache | primary |

### 11.5 Read-replica vs primary

| Endpoint | Source |
|----------|--------|
| Public reads (rewards list, leaderboards) | replica |
| Coach-owner ledger | primary |
| Creator self payouts | primary |
| Submission state transitions | primary |
| Anti-fraud feature lookups | replica + Redis cache |

---

## 12. Day-1 implementation order

1. Schema migrations: `ContentReward`, `ContentSubmission`, `CreatorProfile`, `SubmissionView`, `SubmissionFlag`, `RewardLeaderboardEntry`, `PayoutInstruction`. (1 day)
2. Reward CRUD + state machine + audit logging. (2 days)
3. Submission CRUD + state machine + tier-1 short-link wrapper. (2 days)
4. Stripe Connect Express integration for `CreatorProfile`. (1 day, leverages Wave 5)
5. Tier-2 OAuth integration: TikTok + IG first; YouTube + X second. (4 days)
6. Anti-fraud rule engine + manual review queue. (3 days)
7. Leaderboard materialisation. (1 day)
8. Reconciliation job + payout instruction emission (handoff to finance-app). (2 days)
9. Tier-3 manual review UI. (1 day)
10. Performance hardening + cache layer. (1 day)
11. Test plan execution. (3 days)

Total: ~21 engineer-days. With 2 backend engineers + 1 frontend stub, ~3 weeks.

---

## 13. Test plan

### 13.1 Unit

- State-machine guards for `ContentRewardStatus` and `SubmissionStatus`.
- Money arithmetic (decimal arithmetic correctness, rounding mode = banker's).
- Anti-fraud rule eval for each rule type.
- Trust-tier escalation rules.
- Permission matrix per persona × action.

### 13.2 Integration

- Reward create → publish → submission → tier-1 verify → approve → payout-instruction emit (using fake Stripe).
- Reward funding charge → dispute → pause flow.
- Submission flag → review queue → adjudicate → resume / reject / clawback.
- KYC pending → submission accrue → KYC verified → backlog payout-instruction emit.
- GDPR delete: creator profile → cascade scrub → financial records retained.

### 13.3 End-to-end

- Coach creates pool → 5 creators submit → 3 approved → 2 rejected → pool exhausts → all paid → leaderboard correct → 1099 figure correct.

### 13.4 Load

- Short-link redirect endpoint at 10k req/sec; verify async logging keeps up.
- Tier-2 OAuth fetcher at 500 fetches/sec across mixed platforms with 10% rate-limit injection.
- Anti-fraud rule eval at 5k clicks/sec.

### 13.5 Security

- Authorization fuzzing: every endpoint, every persona × resource combination.
- IDOR scan: ensure `submission.viewPayout` rejects cross-creator reads.
- Webhook replay attack tolerance.
- SQL injection scan on `tagsRequired`, `description`, free-form fields.

---

## 14. Migration / backfill plan

This wave introduces net-new tables. **No backfill is required** because no prior content-reward data exists. State this explicitly.

If the feature ships in stages:

- Stage 1: schema + reward CRUD (no submissions endpoint yet) — internal-only.
- Stage 2: submission endpoint + tier-1 — beta with allow-listed coaches.
- Stage 3: tier-2 OAuth — closed beta with allow-listed creators.
- Stage 4: anti-fraud rule engine — full enable.
- Stage 5: GA.

---

## 15. Rollback plan

If catastrophic post-deploy issue:

1. Feature-flag (Org level): `org.contentRewardsEnabled = false` disables all new reward creation and submission ingest.
2. Existing rewards: pause via admin tool (`POST /admin/content-rewards/:id/pause`).
3. Roll back app deploy via standard pipeline (separate from data; data tables remain).
4. If schema rollback ever required: only feasible while no data has been written. Once any pool is funded, schema is forward-only.
5. Comms: notify affected coaches and creators within 1 hour of decision.

---

## 16. Cross-repo dependency map

| Repo | Touchpoint | Owner |
|------|------------|-------|
| `growth-project-backend` (this) | Data model, business rules, payout instruction emission | Backend |
| `tgp-finance-app` | Stripe Connect transfer execution, 1099 reporting handoff | Finance |
| `growth-project-mobile` | Creator submission UI, tier-1 share-sheet, leaderboard view, pool browse | Mobile |
| `tgp-classifier-service` (existing) | Banned-category vision/text classifier | ML |
| `tgp-shortlink-edge` (existing) | `/r/:slug` redirect + click logging | Platform |

---

## 17. Open implementation questions (non-OWNER_DECISION)

These are engineering questions, not policy:

- **Q1:** Should `SubmissionView` rollup live in Postgres or TimescaleDB? Recommend Postgres + monthly partition; revisit at >50M rows/month.
- **Q2:** How do we handle TikTok's evolving API? Recommend platform-fetcher abstraction with versioned adapters; bake in graceful degradation when an adapter fails.
- **Q3:** Where do device fingerprints come from in mobile? Recommend hashed `installId + deviceModel + osVersion` from mobile SDK (Wave 4).
- **Q4:** Should we expose a webhook to coaches (for their own automations)? Defer to Wave 11 (integrations).

---

End of `rewards-spec.md`.
