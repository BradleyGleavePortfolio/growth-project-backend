# Wave 10 — Native Chat / Community

Status: DRAFT spec, docs-only. No runtime, no migrations, no schema applied.

This wave is the highest-stakes owner question across the parity set. It
defines whether TGP ships a native chat / community surface, and if so,
which shape — because the most obvious shape (Whop-style, Discord-style)
collides directly with the TGP psych doctrine ratified in PR #90.

## Purpose

Coaches running cohort programs need a community surface inside TGP.
Without one, they push clients into Discord / Slack / Telegram, splitting
the operating system, splintering retention signal, and breaking the
admin data-feed promised in Wave 3 (no inbound message events from
external chat platforms).

The parity benchmark — Whop's native community — provides:

- Public reactions (heart, fire, clap, etc) with visible counts.
- Presence indicators ("12 online now").
- Feed-style chronological streams with public engagement metrics.
- Public streak / activity surfacing as social proof.
- Group DMs with no structural separation between coach and client.

Direct adoption of those primitives **violates TGP doctrine** (see PR
#90 — quiet reinforcement, no shame-based loss surfacing, no parasocial
amplification, no manufactured social proof). Direct rejection leaves
TGP without native community and forces the Discord / Slack split.

This wave surfaces three options, recommends one, and ships a complete
spec for the recommended path so a senior engineer can begin
implementation Monday morning if the owner approves Option B.

## Non-goals

This wave will **not** ship:

- Public streak counters or any shame-based loss exposure inside chat.
  The retention engine surfaces streaks privately to the client and
  privately to the coach. Chat has no surface for them.
- Public reaction counts of any kind under Option B. A single
  acknowledgement tick (received) is permitted; aggregate counts are
  not.
- Social-proof manipulation. No fake "X people active now". Presence,
  if shipped under Option A, is real or absent — never inflated.
- Group DM in v1. DM is strictly 1:1, scoped to coach ↔ client or
  client ↔ assigned sub-coach. Group chat lives in rooms / cohorts with
  explicit membership.
- Parasocial replacement of coach 1:1. Chat amplifies the coach
  relationship; it does not substitute for the structured 1:1 surface
  defined in Wave 2.
- Inbound message ingestion from arbitrary external platforms. The only
  external chat integration in scope is Discord (see
  `integration-with-discord.md`), and v1 is read-only.
- Voice or video calling. Voice **notes** (asynchronous, recorded) are
  in scope; live voice / video is not.
- AI-generated reply suggestions inside chat in v1. Coach replies are
  human-authored. AI assist may be evaluated in a later wave behind a
  separate consent gate.
- A public discoverability surface (cross-org "explore communities").
  Communities live inside the coach's org, period.

## OWNER decisions

Listed in priority order. **Decision 1 is the single highest-stakes
choice across the entire parity set** and gates all subsequent
decisions in this wave.

### OWNER_DECISION 1 — Doctrine collision: A vs B vs C

The shape of native community.

- **Option A — Full Whop-style.** Reactions with public counts,
  presence indicators, public feed with engagement metrics, public
  streak surfacing inside chat, group DMs. Maximum stickiness.
  **Violates doctrine.** Directly contradicts PR #90.
- **Option B — Doctrine-compatible community (RECOMMENDED).** Limited
  acknowledgement-only reaction (single received tick, no public
  counts). Structured rooms + cohort channels. Member directory with
  explicit consent. Voice notes (async). Coach announcements.
  Moderation tooling. No public streaks, no public feed metrics, no
  group DM. Reversible upward to A if doctrine softens; doctrine-pure
  by default.
- **Option C — Maximally pure.** Text + threads only. No reactions of
  any kind. No presence. No directory. No voice. May underperform
  retention vs Discord defection.

Recommendation: **B**. Full A/B/C analysis with feature matrix, risk
analysis per option, reversibility analysis, and data-model
implications: see `doctrine-decision-rfc.md`.

### OWNER_DECISION 2 — Voice-note retention window

How long voice-note audio is retained before purge. Recommendation:
**90 days** with transcript retained per the standard message retention
window. Detail and storage-cost rough budget: see
`voice-notes-spec.md`.

### OWNER_DECISION 3 — Voice-note maximum length

Per-note recording cap. Recommendation: **5 minutes**. Longer notes
push toward asynchronous video / coach 1:1 territory. Detail: see
`voice-notes-spec.md`.

### OWNER_DECISION 4 — Discord bridge depth

For coaches already running Discord, whether the bridge is read-only
(TGP reads Discord and surfaces messages inside admin data-feed) or
bidirectional (TGP and Discord stay in sync, two-way). Recommendation:
**read-only v1, bidirectional v2** behind a separate flag. Detail:
see `integration-with-discord.md`.

### OWNER_DECISION 5 — Moderation queue ownership

Whether the moderation queue is platform-owned (TGP staff / a future
trust-and-safety function review flagged content first, with per-coach
escalation) or per-coach owned (each coach runs their own queue).
Recommendation: **platform-owned with per-coach escalation**, mirrored
to coach for visibility, owned operationally by TGP. Detail: see
`moderation-and-safety.md`.

### OWNER_DECISION 6 — DM scope in v1

Recommendation: **1:1 only**, coach ↔ client or client ↔ assigned
sub-coach. No group DM, no client ↔ client DM. This is a non-goal
above and is reiterated here as an explicit owner choice because it
shapes the Membership model. Detail: see `channel-and-thread-spec.md`.

### Open sub-decisions deferred until A/B/C is selected

The following are tagged `OWNER_DECISION_DEFERRED:` inside the relevant
files and only become live questions once Decision 1 is resolved:

- Reaction palette (Option B only): single tick (recommended) vs single
  tick + read-receipt (richer but adds presence-adjacent surface).
- Cohort channel default visibility on cohort end (archive read-only
  vs full freeze vs purge).
- Discord identity reconciliation strictness (strict — explicit linking
  required — vs heuristic — email-match auto-link).

## File map

| File | Purpose | Lines (target) |
| ---- | ------- | --- |
| `README.md` | This file. Wave overview, non-goals, owner decisions, dep graph. | ~220 |
| `doctrine-decision-rfc.md` | The A/B/C decision. Feature matrix, risk analysis, reversibility, data-model implications, recommendation rationale. **Most important file in this wave.** | 1000-1200 |
| `channel-and-thread-spec.md` | Channel taxonomy, message / thread / reaction Prisma deltas, permission matrix, state-transition tables, rate limits, search, failure modes. | 1400-1600 |
| `voice-notes-spec.md` | Recording, transcription, accessibility, retention, moderation, storage cost, failure modes. | 900-1100 |
| `moderation-and-safety.md` | Auto-flag rules, manual review queue, ban ladder, audit, right-to-be-forgotten, EU/US compliance. | 850-1000 |
| `integration-with-discord.md` | Federated bridge spec. OAuth, rate limits, ToS compliance, identity reconciliation, failure modes. | 800-1000 |
| `PERP_HANDOFF.md` | Session log + handoff notes for the next agent or human reviewer. | ~200 |

## Dependency graph

This wave depends on, and extends, the following already-shipped (draft)
foundation:

- **Wave 2** — sub-coach hierarchy + retention engine + cohort entity.
  - Channel `Cohort` membership reuses Wave 2 cohort membership; chat
    permissions resolve through the same scope-stack as Wave 3.
  - Retention engine is the single source of truth for streak data;
    chat **must not** create a parallel streak surface, and **must not**
    surface streak loss publicly.
- **Wave 3** — admin data-feed + scope-stack + capability hash cache
  keys + SSE envelope.
  - Chat events emit into the admin data-feed using the existing SSE
    envelope. New event types are listed in
    `channel-and-thread-spec.md`.
  - Cache keys for unread-counts, channel-list, member-directory all
    reuse the Wave 3 capability-hash scheme.
- **Wave 5** — Stripe Connect for sub-coach billing.
  - Voice-note storage cost (R2 / S3 + CDN egress) is sized below in
    `voice-notes-spec.md`. No money movement here, but the cost
    appears in the coach's per-org bill computed in Wave 5.
- **Audit + GDPR** (already shipped, see `docs/audit-and-gdpr.md`).
  - Every mutation in chat writes an `AuditLog` entry per the existing
    `AuditService.write` contract. Right-to-be-forgotten cascade is
    specified in `moderation-and-safety.md`.

This wave is depended on by:

- **Wave 4 (mobile)** — mobile app must mirror the chat surface. Mobile
  PR will follow this PR; mobile-specific deltas (push notifications,
  voice-note recording via native APIs) will reference this spec by
  filename.
- **Future retention extensions** — when the retention engine is
  extended to consume signal from chat (message frequency, response
  latency), it consumes from the admin data-feed events listed here,
  not from raw `Message` rows.

## Merge order

1. This PR (Wave 10 — community decision RFC + spec). Draft until owner
   resolves Decision 1.
2. Owner resolves OWNER_DECISION 1 (A/B/C). Update this PR's RFC with
   the decision; mark RFC `STATUS: DECIDED`.
3. Owner resolves OWNER_DECISIONs 2-6 in any order. Update relevant
   files; mark each `OWNER_DECISION:` block `RESOLVED`.
4. Convert PR from draft to ready-for-review. Senior engineer review.
5. Mobile mirror PR (Wave 4 follow-up) consumes this spec.
6. Implementation PRs follow per the Day-1 implementation order in
   `channel-and-thread-spec.md`.

## How to read this wave

If you have 5 minutes, read `doctrine-decision-rfc.md`. That is the
file the owner must decide.

If you have 30 minutes, read this file plus the RFC plus the
permission-matrix and channel-taxonomy sections of
`channel-and-thread-spec.md`.

If you are the senior engineer who will implement: read all 7 files in
the order listed in the file map. The Day-1 implementation order is at
the end of `channel-and-thread-spec.md`.
