# Moderation and Safety

Status: DRAFT spec, docs-only. Applies to all of Options A/B/C; the
specifics differ in surface (Option A multiplies moderation load via
public reactions). This file is written for the recommended Option B
and notes deltas where relevant.

This document defines: auto-flag rules, manual review queue, ban
ladder, audit trail, right-to-be-forgotten cascade, and EU/US legal
compliance. The contract is enforced uniformly across text, voice-note
transcripts, attachments (images), and Discord-mirrored content.

---

## 1. Doctrine

Two rules govern the moderation surface:

1. **Platform-owned with per-coach escalation** (OWNER_DECISION 5,
   recommended). The TGP platform team owns the moderation queue
   centrally. Coaches see a per-org mirror of their flags and can
   escalate to TGP. TGP has final authority on platform-violating
   content.
2. **Tombstone, not hard-delete, by default.** Redacted messages
   preserve the row (cleared body) for thread integrity. Hard delete
   is reserved for the GDPR purge job (90-day cycle) and for
   immediate purge of safety-critical content (CSAM, threats).

---

## 2. Auto-flag rules

### 2.1 Rule classes

| Class | Detection method | Severity |
| --- | --- | --- |
| `banned_words` | string match against per-org banned-word list + a platform global list | configurable |
| `link_spam` | message contains 2+ URLs from non-allowlisted domains, or any shortener | medium |
| `nsfw_image` | Cloudflare Images NSFW detection on attachment | high |
| `csam_detection` | Cloudflare Images CSAM signal | critical (immediate hard delete + report) |
| `threat_detection` | sonar-pro classifier on text and transcripts | high |
| `duplicate_burst` | identical content posted N times in 60s (see F-1 in `channel-and-thread-spec.md`) | medium |
| `excessive_caps` | >70% uppercase in messages > 30 chars (heuristic; advisory only) | low |
| `slur_detection` | curated slur lexicon match (multi-language for slurs that don't translate) | high |

### 2.2 Severity → action

| Severity | Default action |
| --- | --- |
| `low` | Add `ModerationFlag` row, advisory; message remains visible. |
| `medium` | Add `ModerationFlag`; message visible; queued for human review within 24h. |
| `high` | Add `ModerationFlag`; message redacted (tombstoned); queued for human review within 1h. |
| `critical` | Add `ModerationFlag`; message redacted; audio/image hard-deleted immediately; reported to legal/CSAM pipeline; queued for human review within 5min. |

Severity is reviewable; on review, the moderator can downgrade or
upgrade. Downgrading a `critical` flag (e.g., a false-positive on
CSAM) requires two-person sign-off.

### 2.3 Per-org overrides

Coaches can:

- **Add to** the banned-word list (more strict).
- **Cannot remove from** the platform global list (less strict
  forbidden — platform standards are a floor).
- **Adjust** severity thresholds within bounds (a coach may set
  `excessive_caps` to severity `medium` instead of `low`; cannot lower
  `csam_detection` below `critical`).
- **Whitelist** specific domains for `link_spam`.

Per-org override changes are audit-logged with `community.moderation
.config_changed`.

---

## 3. Manual review queue

### 3.1 Surface

`GET /api/community/moderation/queue` — paged list of open flags,
per-org-scoped (or platform-wide for OWNER role). Default sort: severity
desc, then created_at asc.

```ts
type ModerationFlagResponse = {
  flag_id: string;
  message_id: string | null;       // null if standalone (e.g., user report)
  voice_note_id: string | null;
  channel_id: string;
  rule_class: string;              // 'banned_words' | 'nsfw_image' | etc
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_review' | 'resolved' | 'escalated';
  reporter: 'system' | 'user';     // system = auto-flag; user = reported by member
  reporter_user_id: string | null;
  excerpt: string;                 // for context; redacted-at-rest until reviewer opens
  created_at: string;
  sla_deadline: string;            // computed from severity
};
```

### 3.2 Decision API

```
POST /api/community/moderation/decisions
  body: {
    flag_id: string;
    decision: 'redact' | 'restore' | 'mute_user' | 'ban_user' | 'escalate' | 'no_action';
    duration_hours?: number;       // for mute_user
    note?: string;                 // free-text reasoning, audit-logged
  }
```

The decision is recorded as `ModerationDecision`, which mutates the
target message + the actor's audit-log + the target user's
`MembershipBanLadder` if applicable.

### 3.3 SLAs

| Severity | SLA |
| --- | --- |
| `critical` | < 5 min from flag creation to decision |
| `high` | < 1 hour |
| `medium` | < 24 hours |
| `low` | < 7 days |

SLA breaches are paged to the on-call platform moderator (TGP staff,
not coach). Coach-mirror queue surfaces SLA breaches with a banner.

---

## 4. Ban ladder

Progressive enforcement across a member's history in a channel (and,
for severe actions, across an org or the platform).

| Step | Trigger | Action |
| --- | --- | --- |
| 1 — Warn | First moderation incident at severity `medium`+ | In-app warning DM + audit-log; no membership change |
| 2 — Mute 24h | Second incident, or first incident at `high` | `Membership.muted_until = now + 24h` |
| 3 — Mute 7d | Third incident in 30d, or repeat `high` | `muted_until = now + 7d` |
| 4 — Channel ban | Fourth incident, or first `critical` (non-CSAM) | `Membership.role_in_channel = 'banned'` |
| 5 — Org ban | Repeat banned across multiple channels in same org | `User.org_banned_at_org_id` set |
| 6 — Platform ban | CSAM / explicit threat / repeat org bans | `User.platform_banned_at` set; account suspended |

Ladder is **per channel** for steps 1-4, **per org** at step 5,
**platform-wide** at step 6.

Reset: incidents older than 90 days drop from the count for purposes
of progression. (They remain in the audit log forever.)

Manual override: COACH+ can apply any step directly without progressing
through earlier ones, with audit reason required. OWNER (TGP staff) can
override coach decisions in either direction (platform standards are
a floor).

---

## 5. Audit trail

All moderation actions are append-only `AuditLog` entries (per
`docs/audit-and-gdpr.md`). The actions:

| Action | actor | target | metadata |
| --- | --- | --- | --- |
| `community.moderation.flag_created` | system or user | flag.id | `{rule_class, severity, message_id?, voice_note_id?}` |
| `community.moderation.flag_assigned` | actor | flag.id | `{assignee}` |
| `community.moderation.decision_made` | actor | flag.id | `{decision, note_hash}` |
| `community.moderation.escalated_to_platform` | actor | flag.id | `{from_org_id, to_owner: true}` |
| `community.moderation.config_changed` | actor | org.id | `{rule_class, old_threshold, new_threshold}` |
| `community.ban_ladder.advanced` | actor | user.id | `{from_step, to_step, scope: channel|org|platform}` |
| `community.ban_ladder.reset` | actor (always OWNER) | user.id | `{reason_hash}` |

Audit fields: actor_id (FK ON DELETE SET NULL), actor_email_snapshot,
tenant_coach_id (scope), ip, user_agent, created_at.

The audit chain is **tamper-evident** in the sense that:
- AuditLog has no UPDATE/DELETE endpoints (per existing
  `docs/audit-and-gdpr.md`).
- Each entry's primary key is set at insert, never reassigned.
- The 30-day legal-hold cron (out of scope for this spec; see
  platform-wide compliance docs) moves a copy to immutable
  cold-storage.

The moderator's note is hashed (SHA-256) into `note_hash` and the raw
text is stored on `ModerationDecision.note` separately, with the same
audit-survivor pattern as `actor_email_snapshot`. This lets PII be
scrubbed from the decision row while leaving the audit chain
verifiable.

---

## 6. Right-to-be-forgotten cascade

When a user invokes their GDPR delete (existing
`DELETE /users/me/account` per `docs/audit-and-gdpr.md`), the
moderation pipeline must respect the cascade.

### Order of operations

1. User requests delete; `data_deletion_request` row created
   (existing platform contract).
2. Cooling-off period (existing platform contract; typically 7 days).
3. Hard-delete cron runs:
   - **Memberships**: cascade delete (FK cascade).
   - **Reactions**: cascade delete (FK cascade).
   - **VoiceNotes authored by user**: hard-delete row + purge audio
     immediately (not on the standard 90-day timer) + clear transcript.
   - **Messages authored by user**:
     - If `created_at < 90 days ago`: hard-delete (purge already
       imminent).
     - Otherwise: **redact** (tombstone). Body, voice_note_id,
       attachment_ids cleared. Row preserved for thread integrity.
       Set `deleted_at` for the standard 90-day post-redaction purge.
   - **Channels owned by user**: ownership reassigned to org admin
     or archived (see channel state-transition table in
     `channel-and-thread-spec.md`).
4. **AuditLog** entries: `actor_id` set NULL (FK ON DELETE SET NULL);
   `actor_email_snapshot` retained per platform pattern.
5. **ModerationFlag rows where user is reporter or target**:
   - Reporter side: `reporter_user_id` set NULL; flag context retained
     for queue continuity.
   - Target side: target FK set NULL; flag retained because the
     moderation decision must remain auditable.
6. **ModerationDecision rows**: actor FK preserved (the moderator is
   not the deleted user, in normal cases); note text cleared if it
   contained the deleted user's PII (best-effort scrub).
7. **MembershipBanLadder**: hard-delete the user's progression row
   (no longer relevant).

### 90-day full purge

90 days post-redaction, a second cron pass hard-deletes the tombstoned
messages. AuditLog entries persist beyond this; they are the
permanent compliance record.

If the message is in an active legal hold (e.g., subpoena, ongoing
investigation), the 90-day purge is paused for that row. The legal-hold
flag is `Message.legal_hold_until` (DateTime?, set by OWNER role only).

---

## 7. CSAM detection (US/EU compliance)

Cloudflare Images is the current attachment storage layer (existing
platform). Cloudflare's CSAM detection is enabled. On any positive
signal:

1. Image is **immediately** purged from Cloudflare Images.
2. `Message.redacted_at` set; body cleared; attachment FK removed.
3. Report filed to NCMEC (US) per Cloudflare's reporting partnership.
4. AuditLog entry `community.moderation.csam_detected` written
   with metadata `{cloudflare_signal_id, ncmec_report_id?}`.
5. The originating user account is auto-platform-banned (step 6 of
   ban ladder). Manual review by TGP legal within 24h.
6. Affected channels — moderator notified (no detail of the content,
   only that an action was taken). Channel members not notified
   directly.

Voice-note CSAM (extremely rare; voice content describing CSAM): the
transcript flag triggers the same path. Audio purged immediately;
NCMEC reporting depends on the specifics (audio + transcript provided).

EU compliance:

- DSA (Digital Services Act): the moderation queue's SLAs and the
  audit trail satisfy DSA's "diligent moderation" obligation.
- GDPR: right-to-be-forgotten is the cascade above.
- Special-category data (sensitive personal data): not in scope for
  community v1; coaches who use TGP for health-coaching have separate
  consent surfaces in Wave 2.

US compliance:

- Section 230: standard platform safe-harbour; the per-coach mirror
  does not change platform liability because TGP retains final
  authority on platform-violating content (OWNER_DECISION 5).
- State laws (CCPA, NY SHIELD, Texas DPA): GDPR cascade covers the
  data-deletion obligations; per-state nuances tracked separately.

---

## 8. Coach-vs-platform escalation

Disagreement scenarios:

### Scenario A — Platform redacts; coach disagrees

The platform moderator redacts a message under `banned_words` rule
because the message contains a word that is on the platform global
list. The coach views the audit and disagrees (e.g., the word is
clinical terminology relevant to their coaching).

- Coach can request an escalation review:
  `POST /api/community/moderation/decisions/:id/escalate`.
- Escalation goes to OWNER role (TGP staff). Decision within 7 days.
- If OWNER overturns: message is restored (un-redacted). AuditLog
  records the reversal. The platform-global list may be amended if
  the case warrants (separate process; out of scope for this spec).
- If OWNER affirms: redaction stands. Coach is informed. Coach can
  appeal once more, after which the decision is final.

### Scenario B — Coach redacts; client disagrees

The coach redacts a client message under per-org override rules. The
client believes the redaction is unjust.

- Client can report the redaction:
  `POST /api/community/reports`. The report goes to the coach's queue
  first (the coach made the call); the coach can affirm or reverse.
- If the coach affirms and the client is unsatisfied, the client can
  escalate to platform: `POST /reports/:id/escalate`. Platform reviews
  within 7 days.
- Platform's decision is final.

### Scenario C — Coach refuses to enforce a platform redaction

The coach removes a coach-only override that would re-show platform-
redacted content (outside the rules; a hypothetical breach attempt).

- Per the platform-standards-as-a-floor rule, the override would be
  rejected at config save time. AuditLog records the attempt. Repeat
  attempts trigger an alert to TGP platform team.

---

## 9. User-initiated reports

Members can report a message, a voice note, or another member.

```
POST /api/community/reports
  body: {
    target_type: 'message' | 'voice_note' | 'user';
    target_id: string;
    reason_class: string;       // 'spam' | 'harassment' | 'csam' | etc
    note?: string;              // free-text; max 1000 chars
  }
```

A report creates a `ModerationFlag` with `reporter='user'`, severity
auto-set per `reason_class` (a `csam` report immediately escalates
to `critical`).

Rate limit: 10 reports / hour / user. False-flag detection: a user
with > 5 false reports in 30 days is flagged for review (their reports
are still queued but de-prioritised).

---

## 10. ModerationFlag schema (illustrative)

```prisma
model ModerationFlag {
  id              String   @id @default(cuid())
  org_id          String
  channel_id      String
  message_id      String?
  voice_note_id   String?
  rule_class      String   // 'banned_words' | 'nsfw_image' | etc
  severity        String   // 'low' | 'medium' | 'high' | 'critical'
  status          String   // 'open' | 'in_review' | 'resolved' | 'escalated'
  reporter        String   // 'system' | 'user'
  reporter_user_id String?
  target_user_id  String?
  excerpt_hash    String?  // hash of excerpt (PII-scrubbable)
  excerpt         String?  // raw excerpt (PII-scrubbable on user delete)
  sla_deadline    DateTime
  assigned_to     String?  // moderator user id
  created_at      DateTime @default(now())
  resolved_at     DateTime?

  @@index([org_id, status, severity, created_at])
  @@index([sla_deadline])
}

model ModerationDecision {
  id              String   @id @default(cuid())
  flag_id         String   @unique
  decided_by      String   // moderator user id
  decision        String   // 'redact' | 'restore' | 'mute_user' | etc
  duration_hours  Int?
  note            String?  // PII-scrubbable
  note_hash       String   // SHA-256 of note (audit-survivor)
  created_at      DateTime @default(now())

  @@index([decided_by, created_at])
}

model MembershipBanLadder {
  id              String   @id @default(cuid())
  user_id         String
  channel_id      String?  // null for org-scope and platform-scope
  org_id          String?  // null for platform-scope
  scope           String   // 'channel' | 'org' | 'platform'
  current_step    Int      // 1..6
  last_advanced_at DateTime
  reset_at        DateTime? // 90-day reset

  @@unique([user_id, channel_id, org_id, scope])
  @@index([user_id])
}
```

GDPR cascade: `ModerationFlag.target_user_id` and
`ModerationFlag.reporter_user_id` are FKs with `ON DELETE SET NULL`;
the row is preserved for moderation history. `ModerationDecision`
preserves the `decided_by` FK with the same pattern.

---

## 11. Failure modes

### F-1. Auto-flag false positive

A legitimate clinical term matches a banned word.

- **Detection**: user reports the redaction; coach reviews; or
  platform review during routine SLA work.
- **Recovery**: decision `restore`; AuditLog records reversal. Banned-
  word list reviewed for the per-org override surface; if the term is
  benign in this org, coach can whitelist it.

### F-2. Auto-flag false negative

A bad message slips past auto-flag because rule did not match (e.g.,
deliberately misspelled slur).

- **Detection**: user report.
- **Recovery**: standard review queue; platform team reviews and
  updates rules (e.g., adds the misspelled variant to the slur
  lexicon).

### F-3. Moderator collusion

A coach moderator approves their own friend's policy-violating
content (or vice versa).

- **Detection**: routine audit sampling (out of scope for this spec
  — the audit-log is the substrate; the sampling is operational).
- **Recovery**: platform reviews. Pattern of misuse triggers
  platform-side override of the coach's moderator privileges in their
  org.

### F-4. SLA breach

`critical` flag exceeds 5min SLA; on-call moderator unavailable.

- **Detection**: SLA cron paged the on-call; no acknowledgement.
- **Recovery**:
  - Escalation tier 2 paged automatically at SLA + 5min.
  - Escalation tier 3 (platform leadership) paged at SLA + 30min.
  - Worst case: the affected message remains redacted (the auto-action
    has already redacted it for `critical`); the human review is the
    follow-through, not the safety action.

### F-5. CSAM pipeline failure

Cloudflare reports a CSAM signal but the NCMEC report API is down.

- **Detection**: report submission fails.
- **Recovery**:
  - Image is purged regardless (immediate purge does not depend on
    NCMEC).
  - Report queued for retry (exp backoff up to 24h).
  - On 24h failure: page TGP legal directly.
  - AuditLog entry `community.moderation.csam_report_failed` written
    with error detail.

### F-6. Right-to-be-forgotten edge: user deletes during open flag

User invokes delete while a moderation flag against their content is
open.

- **Detection**: GDPR purge job finds open flags referencing the user.
- **Recovery**:
  - Flag is **not blocked** by the open status; the cascade above
    runs.
  - Flag's target FK is set NULL; the flag is closed with decision
    `no_action_user_purged` (system-generated decision).
  - AuditLog records both the moderation closure and the user purge,
    preserving the chain for compliance review.

### F-7. Cross-org leakage

A flag in one org is mistakenly visible to a moderator in another org.

- **Detection**: moderation queue route returns flags out of org
  scope. Caught by integration test `mod_queue_scope_isolation`.
- **Recovery**: scope-stack check is asserted twice (route guard +
  service); a single failure cannot leak. If both fail: incident,
  audit, post-mortem.

---

## 12. Performance budgets

| Operation | p50 | p95 |
| --- | --- | --- |
| Auto-flag rule evaluation per message | < 20ms | < 50ms |
| `GET /moderation/queue` | < 80ms | < 250ms |
| `POST /moderation/decisions` | < 100ms | < 300ms |
| CSAM pipeline (Cloudflare → purge) | < 1s | < 3s |

---

## 13. Test plan

### Unit
- Banned-word matcher (exact + regex variants).
- Severity → action map.
- Ban-ladder progression rules + 90-day reset.
- SLA deadline calculator.

### Integration
- Auto-flag fires on banned-word post; redacts at severity `high`.
- User report increments queue; moderator decision persists.
- Coach override permitted within bounds; rejected outside bounds.
- GDPR cascade: deleted user → flags' FKs NULL, decisions preserved.
- Moderation queue scope isolation: cross-org access denied.

### E2E
- Coach creates a banned word; client posts it; message redacts;
  coach views queue; coach restores.
- Client reports a message; coach reviews; coach mutes author 24h.
- Client uploads NSFW image; auto-flag redacts; queue surfaces;
  resolved.

### Load
- 10k coaches × ~10 flags / coach / day → 100k flags / day. Queue p95
  must hold; cron runs SLA timer cleanup nightly.

---

## 14. Senior-engineer onboarding checklist

- [ ] Auto-flag rule engine deployed; rules versioned in code.
- [ ] Per-org override surface in admin console.
- [ ] Manual review queue UI (in admin console; consumed via
      `GET /moderation/queue`).
- [ ] SLA timer cron + paging integration (PagerDuty or equivalent).
- [ ] CSAM pipeline tested with Cloudflare staging signals; NCMEC
      sandbox integration verified.
- [ ] Ban-ladder progression tested across the 6 steps.
- [ ] GDPR cascade tested end-to-end with a synthetic deleted user.
- [ ] Cross-org scope isolation test green.
- [ ] Audit-log entries for all 7 moderation action types written and
      verified.

---

## 15. Operational runbook (excerpt)

For the on-call platform moderator. Full runbook lives separately
under `docs/runbooks/community-moderation.md` (to be authored when
implementation lands).

### 15.1 Daily duties

- Review yesterday's resolved-flag distribution by rule_class. Spike
  in any single class is a leading indicator of a coach-org issue
  (org-targeted spam) or a rule-tuning issue (false-positive surge).
- Check SLA breach count. Goal: zero SLA breaches per day at
  `critical` severity, < 2 / week at `high`.
- Sample 5 random resolved flags; sanity-check that the decision
  matches the policy.

### 15.2 Pages and triggers

| Trigger | Tier | Action |
| --- | --- | --- |
| `critical` flag SLA-deadline approaching (< 2min remaining) | T1 (on-call) | Acknowledge in queue; resolve |
| CSAM signal | T1 + Legal | Auto-purge has run; review for completeness; verify NCMEC report queued |
| Coach-vs-platform escalation > 7 days unresolved | T2 (lead) | Triage; assign reviewer |
| Rule-evaluation engine error rate > 1% | T2 | Roll back rule update |
| Bridge-paused (Discord) > 24 hours | T2 | Coordinate with Discord developer support |

### 15.3 Common runbook items

#### 15.3.1 Coach reports their org's queue is empty (suspicious)

- Verify scope-stack from `GET /moderation/queue?org_id=...` as
  OWNER. Compare to `audit_log` for ModerationFlag creates in the
  org's window.
- If counts mismatch: investigate auth scope mis-routing.
- If counts match: confirm with coach that no real flags exist
  (perhaps quiet day).

#### 15.3.2 Member reports a moderation decision is unjust

- Pull `ModerationDecision` row + `ModerationFlag` source.
- Pull AuditLog entries for the timeline.
- Determine whether the decision was at the platform's discretion
  (overturnable) or under platform-floor rules (final).
- Communicate the decision back via the user-report queue.

#### 15.3.3 Suspected coach abuse of moderation tools

A coach is using moderation tools to silence dissent rather than
enforce policy.

- Triggered by: members of one org filing > 10 reports in 30 days
  about coach-driven mutes.
- Action: pull ban-ladder events for the org; review for
  disproportionate use against specific user IDs; confer with
  founder; if confirmed, restrict the coach's moderator privileges.

---

## 16. Edge cases not covered above

### 16.1 Voice-note transcript with mixed-language content

A coach in a multilingual region may have voice notes with English +
another language. The slur lexicon is multi-language; the banned-word
list is per-org and may be English-only. Edge: a slur in the
non-English language slips past the banned-word list but is caught by
the slur lexicon. This is the design (slur lexicon is the floor;
banned-word list is layered on).

### 16.2 Threading with deleted parent

Already covered in `channel-and-thread-spec.md` failure mode F-3.

### 16.3 Moderation actions on Discord-mirrored content

Read-only mirror means TGP cannot moderate Discord-side. If a
Discord-mirrored message is auto-flagged on TGP side, TGP marks the
mirror as redacted (TGP-side only); the original on Discord remains.
Coach can choose to take action on Discord directly. Documented in
the coach-facing help copy.

In v2 (bidirectional), TGP can propagate redactions to Discord; this
is part of why v2 is more legally sensitive (TGP becomes a moderator
of Discord content from the bot's perspective).

### 16.4 Coach deletes their own moderation note

Coaches may want to delete their own moderation notes (privacy
concern: the note may contain quotes that the coach later regrets
including).

- Allowed: yes. The note text is PII-scrubbable (per section 5,
  audit chain preserved via `note_hash`).
- Audit: a `community.moderation.note_redacted` action is logged.
- Visibility: other moderators reviewing the flag see "[note
  redacted]" in place of the text.
