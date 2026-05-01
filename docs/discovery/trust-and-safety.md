# Trust & Safety

Status: DRAFT spec. Docs only. Schema deltas illustrative.

This file owns the trust-signal layer: verified achievements, testimonial consent, transformation photo policy, banned-claim list, refund-rate suspension threshold (OWNER_DECISION 4), transformation photo retention (OWNER_DECISION 5), manual review queue.

NO fake reviews. NO fake testimonials. NO fabricated transformation photos. Trust must be earned and verifiable.

## Table of contents

1. Verified achievement system
2. Testimonial consent flow
3. Transformation photo policy
4. Transformation photo retention (OWNER_DECISION 5)
5. Refund-rate auto-suspend (OWNER_DECISION 4)
6. Banned-claim list
7. Manual review queue
8. Failure modes
9. Schema deltas
10. Test plan
11. Day-1 implementation order

---

## 1. Verified achievement system

A verified achievement is a chip displayed on a coach card and profile that asserts a specific, time-bound, evidenced outcome. Examples: "USAPL National Qualifier 2024", "Boston Marathon Finisher 2023", "ACSM Certified 2022", "500+ Program Completions on TGP (Wave 8 ledger)".

NO ambient achievements ("expert in nutrition"). NO uncategorised achievements.

### 1.1 Categories

Closed enum:

- `competition_result` — placing or qualifying at a sanctioned event.
- `certification` — credential from a recognised body.
- `media_appearance` — published feature or interview.
- `book_publication` — authored book with verifiable publisher.
- `professional_credential` — degree, license.
- `platform_milestone` — TGP-internal (e.g. completion ledger).
- `client_outcome_aggregate` — aggregated client outcome (no individual client identity surfaced).

### 1.2 Proof requirements

| Category                       | Required proof                                                            |
| ------------------------------ | ------------------------------------------------------------------------- |
| competition_result             | event listing URL OR scanned result PDF; coach name + event date verifiable |
| certification                  | certifying body lookup OR scanned certificate; expiry checked              |
| media_appearance               | URL to publication; verified domain                                        |
| book_publication               | ISBN; author name match                                                    |
| professional_credential        | scanned diploma/license + jurisdiction lookup if available                 |
| platform_milestone             | computed from internal ledger; auto-issued                                 |
| client_outcome_aggregate       | sample-size threshold (>= 30 clients), median outcome, opt-in consents     |

### 1.3 Submission flow

```
Coach submits achievement via console
   ↓
Submission stored in PENDING_REVIEW
   ↓
Auto-checks (URL reachability, ISBN lookup, certifying body API)
   ↓
ADMIN reviewer (SLA: 48h business hours)
   ↓
Approve → chip activated; appears on card
Reject → reason logged; coach notified
```

### 1.4 Issuer + signing

- Each verified achievement has an `issuer` field: `tgp_admin` (manual), `tgp_platform_auto` (computed), or `third_party_attest:{vendor}`.
- For computed achievements (e.g. completion count), recomputed nightly; chip removed if metric drops below threshold.
- Issuer record is signed (HMAC over achievement payload); tamper detection.

### 1.5 Display rules

- Up to 4 chips on card; up to 8 on profile.
- Selection: by `priority_score = recency * 0.5 + category_weight * 0.5`.
- Chips never invented for marketing copy. Card text "Verified" placeholder forbidden.

### 1.6 Revocation

- Coach can hide a chip on profile (UI); does not revoke the verification.
- ADMIN can revoke a chip if proof is invalidated (e.g. lapsed certification).
- Revocation triggers card refresh + audit.
- Revoked chips not deleted; history preserved for transparency.

### 1.7 Anti-fabrication

- Re-submission of same achievement detected by hash of proof URL/ISBN/file.
- Cross-coach sharing of same proof (e.g. same certificate referenced) flagged at ingestion.
- Forensic image analysis for pasted certificates (out of v1; manual review only).

---

## 2. Testimonial consent flow

Testimonials require explicit, documented consent from the client, with displayed-name policy and GDPR delete cascade.

### 2.1 Consent capture

- Client receives in-app prompt: "Coach X would like to feature your testimonial on their public page."
- Required: client types testimonial OR confirms coach-drafted text VERBATIM.
- Required: explicit consent toggle for "Display this testimonial publicly".
- Required: name display preference (full name, first-only, initials, anonymous).
- Required: photo display preference (none, avatar only, no photo).

### 2.2 Storage

- Testimonial text stored in `Testimonial` table.
- Consent record stored separately in `TestimonialConsent` with audit timestamps.
- Coach cannot edit testimonial post-consent. Coach can request edit; client must re-consent.

### 2.3 Display

- Profile shows testimonials only with `consentValid = true`.
- Truncation: 200 chars on card preview; full text on profile.
- "Verified" label only if client matches a coach-program enrolment record (linked, not displayed).

### 2.4 GDPR delete cascade

- Client can revoke consent at any time via own console.
- Revocation: testimonial hidden within 5 minutes; hard-deleted from storage within 24h.
- Cascade: coach card refresh; cache invalidated.
- ADMIN can force-delete testimonials reported as fabricated.

### 2.5 Anti-coercion

- Coaches cannot offer compensation for testimonials. Detected via outbound transaction monitoring on Wave 5 finance side; out of scope here but referenced.
- Testimonials cannot be conditioned on program access (e.g. "leave testimonial to unlock content"). Detected via in-app behavioural flag.

### 2.6 Public testimonial-source page

- `/discover/c/{slug}#testimonials` shows testimonials with display-name policy applied.
- No "view all" public listing for non-consented.
- No testimonial badges that imply count when count is small (< 5 testimonials → no count surfaced).

### 2.7 Aggregation rules

- Coach card may surface count as `30+ testimonials` if >= 30; else not displayed.
- No "5-star rating" or numeric rating in v1 (would invite gaming).
- v2 may add a structured outcome rating; out of scope.

---

## 3. Transformation photo policy

Transformation photos (before/after) are a high-risk category. Strict policy:

### 3.1 Allowed content

- Client-provided, with explicit consent (see Section 3.2).
- Coach-published only with separate per-photo consent record.
- No medical-procedure photos (post-surgery, before-after weight-loss-surgery without disclosure).
- No nudity. Standard fitness modesty (sports bra, athletic shorts) acceptable.

### 3.2 Consent

- Per-photo consent capture: client confirms each photo individually.
- Consent record includes: client identity, photo hash, intended use ("public profile", "social"), expiration (if any), revocation right.

### 3.3 Disclosure

- Transformation photos must include a "Result not typical" or "Individual results vary" disclaimer rendered as text overlay or caption.
- Time-frame disclosure required: "X weeks" or "X months" displayed.
- Program/methodology disclosure required: coach must list what the client did.

### 3.4 No medical claims

- Captions cannot say "cure", "treat", "diagnose", "prevents disease", "weight loss without diet/exercise", "guaranteed results".
- See banned-claim list (Section 6).

### 3.5 Forensic checks

- Every uploaded transformation photo passes:
  - reverse-image search (third-party service) to detect stock photo / web reuse.
  - EXIF metadata check (date plausibility).
  - duplicate-hash check across coaches.
- Failures route to ADMIN review.

### 3.6 Display

- Coach can surface up to 6 transformation photos on profile.
- No transformation photo on card (cards must remain neutral).
- Lazy-loaded; consent-revocation triggers immediate hide.

### 3.7 Revocation

- Client revokes consent → photo deleted from CDN within 24h.
- 30-day soft-delete (per OWNER_DECISION 5) before hard-delete; recoverable in error cases by ADMIN.

---

## 4. Transformation photo retention (OWNER_DECISION 5)

OWNER_DECISION 5: GDPR-aligned 30-day post-revocation hard delete (recommended).

### 4.1 Policy

- Active photos: retained while client consent active.
- Revoked: 30-day soft-delete window; client can re-consent without re-upload.
- After 30 days: hard delete from primary CDN + backups + cold archive.
- On coach offboarding: all transformation photos hard-deleted within 30 days.
- On client account deletion: cascade-delete all photos within 30 days.

### 4.2 Audit trail

- Soft-delete and hard-delete events recorded in `TransformationPhotoAuditLog`.
- Storage location includes signed-URL fingerprints; no recoverability after hard delete.

### 4.3 Backup retention

- Backups retain photos for max 30 days (aligned with revocation window).
- Cold archive: NOT used for transformation photos. (Risk-reduction policy.)

### 4.4 Alternatives (not selected)

- (a) "delete on coach offboarding only" — too broad, retains client photos indefinitely while coach is active. Rejected.
- (b) "7-year hold per US tax-substantiation" — disproportionate for personal images. Rejected.
- (d) "tombstone for 90 days then hard delete" — 30 days is the GDPR-aligned bench. 90 too long. Rejected.

OWNER may override; if so, document decision in PERP_HANDOFF.

---

## 5. Refund-rate auto-suspend (OWNER_DECISION 4)

OWNER_DECISION 4: 8% trailing 90 days (recommended).

### 5.1 Threshold

- Refund-rate = `refunds / completed_checkouts` over trailing 90 days.
- If `refund_rate >= 8%` AND `completed_checkouts >= 20` (sample-size guard), auto-suspend featured-slot eligibility.
- Suspension does not cancel currently active organic listing (only featured slots).

### 5.2 Why 8% (research note)

- Stripe industry guidance for high-touch services: 5-10%.
- Coaching industry varies; small coaches noisy.
- 8% with 20-sample minimum balances signal/noise.
- ADMIN may override per coach with documented rationale.

### 5.3 Computation

- Daily cron at 03:00 UTC.
- Per-coach: count refunds and completed_checkouts in [now - 90d, now).
- Refund linkage via `attributionId` (Section 3 of `buyer-funnel-and-attribution.md`).
- Refunds within 14 days of checkout count; later refunds (> 14 days) flagged but counted at 50% weight (likely chargeback-driven).

### 5.4 Suspension actions

- Featured slots: suspended (state `SUSPENDED`); pro-rata refund.
- Card: remains visible (organic).
- Coach console: warning banner.
- Eligibility for new featured purchase: blocked until refund-rate drops below 5% trailing 90d.

### 5.5 Coach notification

- Email + in-app notification.
- Notification specifies metric, threshold, days to remediate, support contact.

### 5.6 Appeal

- Coach can appeal via ADMIN console.
- ADMIN reviews each refund's reason; can manually exclude clearly-non-coach-fault refunds (e.g. payment fraud, accidental purchase).
- Appeal outcome audited.

### 5.7 Alternatives (not selected)

- (a) 5% — too aggressive; small-sample noise.
- (c) 10% — too lenient; allows poor-quality coaches sustained featured presence.
- (d) 12% — definitely too lenient.

---

## 6. Banned-claim list

Closed regex set + LLM moderation (sonar-pro). Hits block listing publish.

### 6.1 Banned categories

- **Income guarantees**: "guaranteed $X", "make X dollars", "X-figure income", "passive income guaranteed".
- **Medical cures**: "cure", "treat", "heal", "reverse disease", "prevent cancer", "diabetes cure".
- **Weight-loss guarantees**: "lose X lbs guaranteed", "guaranteed transformation".
- **Performance guarantees**: "guaranteed PR", "guaranteed gains".
- **Drug references** (without disclosure): "PED-friendly", "TRT", "anabolic" (require explicit disclosure context).
- **Unverified credentials**: "Dr." prefix without verified MD/PhD; "certified" without verified body.
- **Unauthorised celebrity association**: "trained by [celebrity]" without provable record.

### 6.2 Detection

- Layer 1: regex pattern set (fast, deterministic) against profile text + card text.
- Layer 2: sonar-pro classifier on flagged candidates with > 60% match probability (LLM tiebreaker).
- Layer 3: ADMIN human review for ambiguous cases.

### 6.3 Action on hit

- Listing cannot transition to ACTIVE state.
- Coach notified with specific phrase + suggested rewrite.
- 3 strikes / 30 days → ADMIN review of coach overall.

### 6.4 Edge cases

- "Lost 20 lbs in 12 weeks" (factual coach result) — allowed if coach-personal (not promise to client).
- "Guaranteed money back if not satisfied" — allowed if explicit refund policy linked.
- Quoting a client testimonial that says "lost X lbs" — allowed; testimonial subject to consent rules.

### 6.5 Localisation

- Banned-claim regex set localised by language.
- Top languages v1: en, es, fr, de, pt-br.
- Other languages: human review until regex set built.

### 6.6 Audit

- Every claim hit logged with text, regex matched, action.
- Quarterly review of false-positive rate; regex tuned.

---

## 7. Manual review queue

### 7.1 Queue ingress

- Flagged content from auto-checks.
- User reports (Section 7.2).
- Coach appeals.
- Periodic random audits (10% sample of new listings).

### 7.2 User reports

- "Report" link on every coach card and profile.
- Anonymous-allowed with rate-limit (5 per IP / day).
- Auth report: tied to user.
- Categories: `fake_testimonial`, `medical_claim`, `income_guarantee`, `inappropriate_content`, `impersonation`, `other`.

### 7.3 Queue management

- Priority by severity: medical/income claims highest; minor copy issues lowest.
- SLA: 4h for medical/income; 48h business for others.
- Reviewer assignment: round-robin within ADMIN team; conflicts of interest blocked.

### 7.4 Reviewer console

- Review interface: card preview, full profile, flagged text highlighted, audit history.
- Actions: approve, request edit, suspend, escalate to legal.
- Decision recorded with notes; coach notified with reason.

### 7.5 Feedback loop

- Reviewer notes flow to regex / LLM tuning.
- False-positive rate target < 5%.
- Reviewer accuracy audited monthly.

---

## 8. Failure modes

### 8.1 Forged certificate uploaded

- **Detection**: certifying body lookup; manual review on no-API verification.
- **Recovery**: rejection; coach notified; appeal allowed.
- **Audit**: forgery attempts tracked for fraud detection.

### 8.2 Recycled testimonial across coaches

- **Detection**: text-similarity scan (n-gram overlap > 80%) across `Testimonial` table.
- **Recovery**: both flagged; ADMIN review.
- **Audit**: cross-coach text reuse logged.

### 8.3 Stock-photo transformation upload

- **Detection**: reverse-image-search on every upload.
- **Recovery**: rejected; coach notified.
- **Audit**: stock-image attempt counts.

### 8.4 Banned-claim regex false positive

- **Detection**: monthly review of rejected items.
- **Recovery**: regex tuning; coach can re-submit revised text.
- **Audit**: false-positive rate metric.

### 8.5 Refund-rate auto-suspension on legitimate coach

- **Detection**: appeal flow + ADMIN review.
- **Recovery**: per-refund exclusion if non-fault; reinstate.
- **Audit**: appeal outcomes tracked.

### 8.6 Testimonial consent revocation race

- **Detection**: revocation timestamp; testimonial display query joins `consentValid = true`.
- **Recovery**: 5-min cache TTL; revocation propagation < 5 min.
- **Audit**: revocation latency metric.

### 8.7 Photo retention bug (still on CDN past 30 days)

- **Detection**: nightly job verifies CDN list against `TransformationPhotoAuditLog`.
- **Recovery**: orphan delete.
- **Audit**: orphan count metric; > 0 is P1.

### 8.8 LLM hallucinated banned-claim violation

- **Detection**: LLM tiebreaker prediction reviewed by ADMIN.
- **Recovery**: false-positive overturned.
- **Audit**: LLM accuracy metric monthly.

### 8.9 User-report abuse (mass false reports)

- **Detection**: per-IP rate-limit; report-quality classifier.
- **Recovery**: low-quality reports auto-deprioritised.
- **Audit**: report-abuse metric.

---

## 9. Schema deltas (illustrative)

```prisma
model VerifiedAchievement {
  id              String   @id @default(cuid())
  coachId         String
  coach           Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  category        AchievementCategory
  title           String   @db.VarChar(160)
  occurredAt      DateTime?
  proofUrl        String?
  proofFileKey    String?
  proofHash       String   // sha256 of proof for dedupe
  issuer          String   // "tgp_admin" | "tgp_platform_auto" | "third_party_attest:{vendor}"
  state           AchievementState @default(PENDING_REVIEW)
  signedPayload   String   // hmac signed
  reviewedBy      String?
  reviewedAt      DateTime?
  revokedAt       DateTime?
  revocationReason String?
  createdAt       DateTime @default(now())
  @@index([coachId, state])
  @@index([proofHash])
}

enum AchievementCategory {
  COMPETITION_RESULT
  CERTIFICATION
  MEDIA_APPEARANCE
  BOOK_PUBLICATION
  PROFESSIONAL_CREDENTIAL
  PLATFORM_MILESTONE
  CLIENT_OUTCOME_AGGREGATE
}

enum AchievementState {
  PENDING_REVIEW
  ACTIVE
  REJECTED
  REVOKED
}

model Testimonial {
  id              String   @id @default(cuid())
  coachId         String
  coach           Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  clientId        String
  text            String   @db.VarChar(1500)
  displayNamePolicy DisplayNamePolicy
  photoDisplay    PhotoDisplayPolicy
  consentId       String   @unique
  consentValid    Boolean  @default(true)
  reviewState     ReviewState @default(PENDING_REVIEW)
  createdAt       DateTime @default(now())
  hiddenAt        DateTime?
  @@index([coachId, consentValid])
}

enum DisplayNamePolicy {
  FULL
  FIRST_ONLY
  INITIALS
  ANONYMOUS
}

enum PhotoDisplayPolicy {
  NONE
  AVATAR_ONLY
}

model TestimonialConsent {
  id            String   @id @default(cuid())
  testimonialId String   @unique
  clientId      String
  consentedAt   DateTime
  revokedAt     DateTime?
  textVersion   String   // hash of text at consent time
  ipHashed      String
  userAgentHashed String
}

enum ReviewState {
  PENDING_REVIEW
  APPROVED
  REJECTED
}

model TransformationPhoto {
  id              String   @id @default(cuid())
  coachId         String
  coach           Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  clientId        String
  imageHash       String
  cdnKey          String
  caption         String?
  timeframeWeeks  Int?
  consentId       String   @unique
  consentValid    Boolean  @default(true)
  reviewState     ReviewState @default(PENDING_REVIEW)
  createdAt       DateTime @default(now())
  softDeletedAt   DateTime?
  hardDeletedAt   DateTime?
  @@index([coachId, consentValid])
  @@index([imageHash])
}

model TransformationPhotoAuditLog {
  id            String   @id @default(cuid())
  photoId       String
  action        String   // "uploaded" | "consented" | "revoked" | "soft_deleted" | "hard_deleted" | "reviewed"
  actorId       String?
  occurredAt    DateTime @default(now())
  metadata      Json?
}

model BannedClaimHit {
  id            String   @id @default(cuid())
  coachId       String
  coach         Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  source        String   // "card" | "profile" | "testimonial"
  matchedRegex  String
  textSnippet   String   @db.VarChar(280)
  llmConfidence Decimal? @db.Decimal(5, 4)
  action        String   // "block_publish" | "warn" | "human_review"
  occurredAt    DateTime @default(now())
}

model RefundRateSnapshot {
  id              String   @id @default(cuid())
  coachId         String   @unique
  refundCount     Int
  checkoutCount   Int
  ratePercent     Decimal  @db.Decimal(5, 2)
  windowStart     DateTime
  windowEnd       DateTime
  computedAt      DateTime @default(now())
  thresholdBreached Boolean
}

model ReportSubmission {
  id            String   @id @default(cuid())
  reportedCoachId String
  reporterVisitorId String?
  reporterAuthUserId String?
  category      String
  details       String   @db.VarChar(1500)
  state         ReportState @default(OPEN)
  reviewedBy    String?
  reviewedAt    DateTime?
  outcome       String?
  createdAt     DateTime @default(now())
  ipHashed      String
  userAgentHashed String
  @@index([reportedCoachId, state])
}

enum ReportState {
  OPEN
  IN_REVIEW
  RESOLVED_NO_ACTION
  RESOLVED_ACTIONED
  DUPLICATE
}
```

---

## 10. Test plan

### 10.1 Unit

- Achievement category enum + proof requirement matrix.
- Banned-claim regex coverage (positive + negative).
- Refund-rate computation correctness.
- Testimonial display-name policy rendering.

### 10.2 Integration

- Submit achievement → admin approves → chip displays.
- Banned-claim hit → publish blocked.
- Refund-rate breach → featured slot suspended → pro-rata refund.
- Testimonial revocation → hidden in 5 min, hard-deleted in 24h.
- Transformation photo retention: revoked → 30-day countdown → hard delete.

### 10.3 E2E

- User reports a card → ADMIN review → outcome.
- Coach appeals refund-rate suspension → ADMIN reviews.
- Crawler does not see hidden testimonials.

### 10.4 Load

- Banned-claim regex over 10k coach profiles in < 5 min batch.
- Reverse-image-search vendor latency < 800ms; failures retry with backoff.

### 10.5 Privacy

- GDPR delete cascade on coach: achievements, testimonials, photos all removed.
- GDPR delete on client: testimonials anonymised, photos hard-deleted.

---

## 11. Day-1 implementation order

1. `VerifiedAchievement` + admin review console.
2. Proof verification service (URL reachability, ISBN lookup).
3. Achievement chip projection.
4. `Testimonial` + `TestimonialConsent` + display policy.
5. Banned-claim regex set + LLM tiebreaker.
6. Refund-rate cron + auto-suspend.
7. `TransformationPhoto` + retention job.
8. User report submission + ADMIN queue.
9. Audit log integration.

---

## 12. Cross-repo

- `growth-project-mobile`: testimonial consent + photo upload flows mirror web. Same consent records.
- `tgp-finance-app`: refund-rate metric reads from finance event stream.

---

## 13. Audit log

Every trust-and-safety mutation audited:
- achievement submitted/approved/rejected/revoked
- testimonial consented/revoked
- photo uploaded/revoked/soft-deleted/hard-deleted
- banned-claim hit
- refund-rate snapshot
- report submitted/resolved
- coach appeal outcomes

7-year retention. GDPR delete tombstones audit rows but preserves action history.

---

## 14. Senior-engineer onboarding

1. Read Section 1 (verified achievements).
2. Read Section 2 (testimonial consent) — non-negotiable.
3. Read Section 3-4 (transformation photos + retention).
4. Read Section 5 (refund-rate threshold) — note OWNER_DECISION 4.
5. Read Section 6 (banned claims).
6. Confirm OWNER_DECISIONs 4 and 5 before launch.

---

End `trust-and-safety.md`.
