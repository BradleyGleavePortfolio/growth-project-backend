# RFC: Native community shape — A vs B vs C

Status: **OPEN**. Awaiting OWNER_DECISION 1.

Owner: TGP founder. Author: Wave 10 spec agent. Date: 2026-05-01.

This is the single highest-stakes decision across the parity set. It
gates every other decision in Wave 10. It cannot be made on engineering
grounds alone — it is a product / brand / doctrine decision. This RFC
exists to surface the trade space honestly so the owner can decide
without surprise.

---

## TL;DR

Three options. The recommendation is Option B.

| | Option A — Whop-style | **Option B — Doctrine-compatible (RECOMMENDED)** | Option C — Maximally pure |
| --- | --- | --- | --- |
| Doctrine fit | Violates | Compatible | Pure |
| Retention upside | High | Medium-high | Low-medium |
| Reversibility | Hard to retract | Can extend to A; can shrink to C | Can extend to B |
| Implementation effort | Highest | High | Medium |
| Risk of brand harm | High | Low | Negligible |
| Discord defection risk | Lowest | Low-medium | Medium-high |

**Recommendation: Option B**, because it is the only option that
delivers credible community retention without violating the doctrine
ratified in PR #90, and because reversibility is asymmetric — B can
extend toward A if doctrine softens; A cannot retract reactions /
public counts without enraging users who came to depend on them.

---

## Background

### Why this matters

TGP is positioned (Wave 2) as a Whop-AI-style operating system for
coaches. "Operating system" implies the coach runs their entire
business inside TGP — programs, payments, retention, and **community**.
A coach without a native community surface is forced into Discord /
Slack / Telegram. That:

1. Splits the operating system; coaches juggle two products.
2. Splinters the retention signal; chat-engagement events do not flow
   to the admin data-feed (Wave 3) and the retention engine (Wave 2)
   loses one of the strongest leading indicators of churn.
3. Cedes the relationship to a horizontal platform whose incentives are
   not aligned with the coach's.

So community is not optional. The question is **what shape**.

### The doctrine collision

PR #90 ratified the TGP psych doctrine. The relevant clauses:

- **No public streak counters that shame loss.** Streaks are surfaced
  privately to the client (so they can self-monitor) and privately to
  the coach (so they can intervene). They are never broadcast.
- **No noisy heart / like reactions that cheapen interaction.** Public
  reaction counts manufacture social proof and reduce the cost of
  acknowledgement to a single tap, hollowing out the incentive to
  reply with substance.
- **No social-proof manipulation.** No fake counts. No exposed
  leaderboards by default. No "X people online now" inflation.

Whop's native community is **built on** the surfaces the doctrine
forbids. Direct adoption is incompatible. So is direct rejection
(see above). The honest path is to surface the trade space.

### What "doctrine-compatible" means concretely

A surface is doctrine-compatible if **every** statement below is true
of it:

1. It does not surface streak data publicly. Chat messages do not
   carry a "X-day streak" badge. The directory does not rank by
   streak. There is no chat-room leaderboard sorted by activity.
2. It does not aggregate reaction counts publicly. A reaction may
   exist as a private acknowledgement signal between sender and
   recipient (a single tick) but the count is not displayed and the
   set of reactors is not enumerable to other members.
3. It does not manufacture presence. Either presence is real and
   shipped (Option A) or it is not shipped (Options B and C). It is
   never inflated.
4. It does not replace coach 1:1 with parasocial pseudo-intimacy. The
   directory does not encourage cross-client mass-messaging. Group
   DMs are not in v1.
5. It writes audit + GDPR cascade for every personal-data row. (This
   is a platform requirement, not a doctrine one, but it is enforced
   the same way.)

Options B and C satisfy all five. Option A fails 1, 2, and arguably 4.

---

## Option A — Full Whop-style

### What it is

A direct port of the parity benchmark.

- Reactions: full emoji palette (heart, fire, clap, laugh, +
  custom-uploaded coach emoji), with public counts and reactor list.
- Presence: live "online now" indicator, last-seen timestamps visible
  to all members of the channel.
- Feed view: chronological cross-channel feed for each member showing
  recent activity from all subscribed channels, with engagement
  metrics (replies, reactions) inline.
- Public streak surfacing: a member's current streak (consecutive days
  of program participation) is displayed inline next to their handle
  in chat.
- Group DMs: any member can start a DM with up to 10 other members.
- Member directory: ranked by activity (messages sent, reactions
  received). Coach + sub-coach + clients all visible to all clients in
  the org by default.

### Doctrine fit

**Violates** doctrine on three of the five clauses (1, 2, 4). Does
not violate clauses 3 (presence is real, not inflated) or 5 (audit /
GDPR are still enforceable).

### Retention upside

**High.** This is the parity benchmark for a reason. Reaction
counts and feed engagement are well-understood retention surfaces.
Discord defection risk is at its lowest because the parity gap is at
its smallest.

### Reversibility

**Hard to retract.** Once members come to depend on visible reaction
counts, removing them generates user complaints and engagement metric
crashes. The owner would face a choice between (a) reverting (visible
churn-causing change) or (b) keeping them despite doctrine. Asymmetric
risk.

### Risk analysis

- **Brand risk:** high. The doctrine is the brand. Shipping Option A
  contradicts the explicit positioning of PR #90. If a competitor
  surfaces this contradiction (or a coach does in a teardown), it
  damages the credibility of every other claim TGP makes about psych.
- **User-segment risk:** medium. Some clients enjoy public reaction
  surfaces. Removing them later loses those users. But the doctrine's
  premise is that the median client is harmed by them on net, even if
  some individuals enjoy them.
- **Operational risk:** medium. Public reactions amplify moderation
  load. A single inappropriate reaction (slur emoji, etc) on a
  high-traffic message multiplies harm faster than a single
  inappropriate message would.
- **Engineering risk:** highest of the three options. Reactor lists,
  reaction-count caching, presence service (websocket + heartbeat),
  feed-ranking pipeline. All are non-trivial subsystems.

### Data-model implications

- `Reaction` table with a public count and reactor lookup.
- `Presence` service (likely Redis-backed) with heartbeat protocol.
- `MemberActivityScore` materialised view for directory ranking.
- `FeedEntry` denormalised table, recomputed on message create.

### Why it is not recommended

Doctrine collision is the top-line. Reversibility asymmetry is the
second-line. Even if the owner's psych priors update toward "public
counts are fine, doctrine was wrong," shipping B first and extending
to A is a strictly safer ordering than shipping A first and retracting
to B.

---

## Option B — Doctrine-compatible community (RECOMMENDED)

### What it is

A community surface engineered specifically to satisfy the five
doctrine clauses while delivering the retention surfaces that **don't**
require violating them.

- **Reactions: limited acknowledgement-only.** Single
  "received" tick. Sender sees that the recipient(s) tapped the tick
  (so they know the message landed), but the count is not displayed
  publicly to the channel and the set of tickers is not enumerable
  beyond the sender's own outbound view. No emoji palette. No
  reactor leaderboards.
- **No presence indicator** in v1. Last-seen and online-now are not
  shipped. (Sub-decision deferred: a single private "delivered"
  indicator on outbound DMs is permitted but not yet decided.)
- **Channel taxonomy: structured.** Announcements (coach → all,
  broadcast). Rooms (topic-based, multi-author). Cohorts (time-bound,
  program-aligned, auto-archived on cohort end). DMs (1:1 only, coach
  ↔ client or client ↔ assigned sub-coach).
- **Member directory with explicit consent.** Each client opts in to
  appearing in the directory. The directory is sorted alphabetically
  or by join date — not by activity, not by streak, not by any
  retention metric. Coaches and sub-coaches are listed by default
  (their visibility is part of the coach role).
- **Voice notes (async).** Recording up to 5 minutes (OWNER_DECISION
  3). Transcription via sonar-pro on upload (consent-gated). Audio
  retained 90 days (OWNER_DECISION 2); transcript retained per the
  standard message retention window. Accessibility default: transcript
  visible inline.
- **Coach announcements.** Broadcast-only channel where only the
  coach + sub-coaches can post. Clients can react with the
  acknowledgement tick. No threading on announcements (intentional —
  forces follow-up to the appropriate room).
- **Moderation tooling.** Auto-flag rules. Manual review queue.
  Audit trail. Ban ladder. Right-to-be-forgotten cascade. Detail in
  `moderation-and-safety.md`.
- **No public streak surfacing.** Period. The retention engine's
  streak data is not exposed in chat handles, directory entries,
  reaction surfaces, or anywhere visible.
- **No group DMs in v1** (OWNER_DECISION 6). Group conversation
  happens in rooms or cohorts with explicit Membership.

### Doctrine fit

**Compatible.** All five doctrine clauses are satisfied:

1. No public streak surfacing anywhere.
2. Reaction signal is private (sender ↔ recipient acknowledgement);
   counts are not aggregated publicly; reactor lists are not exposed.
3. No presence inflation; presence is simply not shipped.
4. Coach 1:1 is structurally protected — DM is 1:1, group DM is not in
   scope, the directory is consent-gated and not ranked by activity.
5. Audit + GDPR cascade is enforced on every row (see
   `channel-and-thread-spec.md` and `moderation-and-safety.md`).

### Retention upside

**Medium-high.** Empirically the strongest retention surface in
chat-style communities is "the coach posted, and someone responded
substantively" — which Option B preserves. The thing it gives up
(public reaction counts as social proof) is real but secondary; the
thing it preserves (structured rooms, voice notes, async coach
broadcast) is primary.

Discord defection risk is low-medium. Coaches who already run a
public-engagement-style community on Discord are not the target user
for B; coaches who are new to community or who run a more deliberate
program-aligned community are.

### Reversibility

**Asymmetric in B's favor.** B can extend to A if doctrine softens —
add a reaction palette, add presence, add public counts. Each is an
additive change. B can also shrink to C if doctrine hardens — remove
the acknowledgement tick, remove the directory. Each is a subtractive
change but recoverable.

A cannot retract to B without regression. C cannot extend to A without
two large additive jumps.

### Risk analysis

- **Brand risk:** low. Option B is the doctrine. Shipping it
  reinforces the positioning of PR #90.
- **User-segment risk:** low-medium. Some clients accustomed to
  Whop-style or Discord-style reactions may find Option B sparse. The
  acknowledgement tick reduces this materially. The structured rooms
  + voice notes + announcements reduce it further.
- **Operational risk:** medium. Voice notes add a moderation surface
  (transcribe-then-scan flow, see `voice-notes-spec.md`). Member
  directory adds a consent surface. Both are tractable.
- **Engineering risk:** high but bounded. No presence service. No
  reactor-list cache. No feed-ranking pipeline. The bulk of the work
  is in messages + threads + voice + moderation, all of which are
  well-trodden ground.

### Data-model implications

- `Channel` (announcements / rooms / cohorts / DM).
- `Message` (text + attachments + voice-note pointer).
- `Thread` (max 2 levels of nesting; see `channel-and-thread-spec.md`).
- `Reaction` (single type — acknowledgement tick — with sender and
  recipient FKs; not aggregated publicly).
- `Membership` (per-channel, consent-bearing).
- `VoiceNote` (audio-storage pointer, transcript, retention timer).
- `ModerationFlag` + `ModerationDecision` (see
  `moderation-and-safety.md`).

All tables ship with: audit fields, GDPR delete cascade, scope-stack
keys (org / cohort / coach / client) per Wave 3.

### Why it is recommended

It is the only option that (a) delivers credible native community,
(b) satisfies the doctrine, (c) preserves reversibility in both
directions, and (d) bounds engineering scope to known territory.

---

## Option C — Maximally pure

### What it is

The minimum-viable native community.

- Text + threads only.
- No reactions of any kind.
- No presence.
- No directory.
- No voice notes.
- No coach-announcement-distinct channel (coach posts go in the same
  channels as everyone else, distinguished only by role badge).

Channels: rooms + cohorts + 1:1 DM.

### Doctrine fit

**Pure.** None of the doctrine clauses are even close to violation.

### Retention upside

**Low-medium.** Removing the acknowledgement tick is a real cost — it
is the single retention-relevant surface that Option B kept and Option
C drops. Without it, message authors do not know if the recipient saw
the message. That degrades coach-client trust over time.

Discord defection risk is medium-high. C is austere enough that
coaches running a polished community on Discord will see it as a
downgrade.

### Reversibility

**Easy upward.** C → B is a pure additive jump (add the
acknowledgement tick, add the directory, add voice notes, add
announcements). The order in which C → B extensions land can also
be tuned by user signal.

### Risk analysis

- **Brand risk:** negligible. Option C is the pure doctrine.
- **User-segment risk:** medium. The austerity itself is a
  user-experience cost. Some clients will perceive C as broken or
  unfinished.
- **Operational risk:** low. The smallest moderation surface of the
  three. No voice transcription pipeline.
- **Engineering risk:** medium. Smaller than A or B; the threading
  + permission + audit / GDPR work is still non-trivial.

### Data-model implications

A subset of Option B: `Channel`, `Message`, `Thread`, `Membership`.
No `Reaction`, no `VoiceNote`. Moderation tables are still required
even in C.

### Why it is not recommended

Two reasons. First, the acknowledgement tick is doctrine-compatible
and has a real retention payoff; dropping it concedes ground without
need. Second, voice notes are doctrine-compatible (asynchronous,
transcript-default, no public count aggregation) and dropping them
forecloses a meaningful surface for coach voice / sub-coach voice that
text cannot replicate.

If the owner reads the doctrine to forbid even the acknowledgement
tick, Option C is the right answer; that is a defensible read. The
recommendation here is that the doctrine permits it (the clause is
"noisy" reaction counts, not all reactions), and the retention payoff
is sufficient.

---

## Feature matrix

A row-by-row comparison. "Yes" = shipped in v1. "No" = not in v1.
"Sub-dec" = sub-decision deferred until A/B/C resolves.

| Feature | Option A | Option B (REC) | Option C |
| --- | --- | --- | --- |
| Public reaction palette (heart, fire, clap, etc) | Yes | No | No |
| Acknowledgement tick (private, no count) | Yes (alongside palette) | Yes | No |
| Visible reaction counts | Yes | No | No |
| Reactor lists (who reacted) | Yes | No (sender sees own outbound only) | No |
| Presence indicator (online now) | Yes | No | No |
| Last-seen timestamp | Yes (channel-visible) | Sub-dec (DM only?) | No |
| Public message-count surfacing | Yes | No | No |
| Cross-channel chronological feed | Yes | No | No |
| Public streak surfacing in chat | Yes | No (forbidden) | No (forbidden) |
| Voice notes (async) | Yes | Yes | No |
| Voice-note transcript default visible | (config) | Yes (always) | n/a |
| Coach announcements channel | Yes | Yes | No (folded into rooms) |
| Member directory | Yes (ranked by activity) | Yes (consent-gated, alphabetical / join-date) | No |
| Group DM | Yes | No | No |
| 1:1 DM (coach ↔ client, client ↔ sub-coach) | Yes | Yes | Yes |
| Threads | Yes (depth: unlimited) | Yes (depth: max 2) | Yes (depth: max 2) |
| Rooms (topic-based) | Yes | Yes | Yes |
| Cohort channels (time-bound) | Yes | Yes | Yes |
| Per-channel search | Yes | Yes | Yes |
| Cross-channel search | Yes | Yes (scope-gated) | Yes (scope-gated) |
| Moderation queue | Yes | Yes | Yes |
| Auto-flag rules | Yes | Yes | Yes |
| Ban ladder | Yes | Yes | Yes |
| Right-to-be-forgotten cascade | Yes | Yes | Yes |
| Discord federation (read-only) | n/a | Yes (sep flag) | Yes (sep flag) |
| Discord federation (bidirectional) | n/a | v2 (OWNER_DEC 4) | v2 (OWNER_DEC 4) |
| Audit log on every mutation | Yes | Yes | Yes |
| Admin data-feed event emission | Yes | Yes | Yes |
| Mobile push notifications | Yes | Yes | Yes |

---

## Risk analysis: cross-cutting

Risks that are not specific to one option, but that change shape per
option.

### R-1. Doctrine credibility

If TGP's positioning is built on the doctrine, shipping a community
surface that visibly contradicts it is a credibility hit. Severity
varies: Option A high, Option B low, Option C negligible.

Mitigation under any option: every chat-related public-facing surface
(`/help/community`, in-app onboarding) explicitly states the doctrine.
Under Option B, the help copy frames the acknowledgement tick as
"signal without spectacle."

### R-2. Discord defection

If TGP's chat is too austere, coaches keep using Discord and never
move. The retention engine loses chat signal; the operating-system
positioning weakens. Severity: Option A low, Option B low-medium,
Option C medium-high.

Mitigation under B and C: ship the Discord federation bridge
(`integration-with-discord.md`) so the coach's existing Discord
community can still emit events into the admin data-feed, even if
they do not migrate to native chat.

### R-3. Moderation load

Public reaction surfaces multiply moderation load (a single
inappropriate emoji-reaction on a high-traffic message reaches more
eyes than a single inappropriate message). Severity: Option A high,
Option B low (no public reactions), Option C negligible.

Mitigation under A: invest more heavily in the auto-flag pipeline,
including emoji-level scanning. Under B: the standard pipeline
(`moderation-and-safety.md`) suffices.

### R-4. Voice-note storage cost

Voice notes are 50-300x more storage-expensive per message than text.
At 10k coach scale with ~5 voice notes per coach per day, audio storage
is non-trivial. Detail in `voice-notes-spec.md`. Severity: Option A
medium, Option B medium, Option C none (no voice).

Mitigation: 90-day audio retention (OWNER_DECISION 2). Transcript
retained per text-message retention. Cold-storage tier for older audio
if retention is extended later.

### R-5. Mobile parity drift

Mobile (Wave 4 follow-up) must mirror this surface. If the mobile mirror
lags, coaches and clients see inconsistent behaviour. Severity equal
across options; impact higher under A because there are more surfaces
to mirror.

Mitigation: ship this PR's spec first; mobile PR follows immediately
referencing this spec by filename. Push notifications and voice-note
recording surfaces are explicitly called out in
`channel-and-thread-spec.md` and `voice-notes-spec.md` so the mobile
agent has unambiguous contracts.

### R-6. Coach-vs-platform moderation conflict

A coach may want to permit content the platform considers a violation
(e.g., adult-content coaching programs). Severity equal across options.

Mitigation: the moderation queue is platform-owned with per-coach
escalation (OWNER_DECISION 5). The coach can request escalation; the
platform decision is final. Coaches who want unrestricted moderation
authority are not the target user.

### R-7. International compliance

EU GDPR, US state laws (CCPA, etc), CSAM detection requirements vary.
Severity equal across options.

Mitigation: every personal-data row has GDPR delete cascade; CSAM
detection runs on all uploaded images via Cloudflare Images;
moderation audit trail is tamper-evident (see
`moderation-and-safety.md`).

---

## Reversibility analysis (extended)

Reversibility matters because the owner's read of the doctrine may
update. Engineering should choose the option with the cheapest
recovery path under each plausible update.

### If doctrine softens (owner decides public reactions are fine)

- A → A: no change.
- B → A: additive. Add reaction palette, add public counts, add
  presence service, add reactor lists. Each is a feature flag flip
  + new schema column / new table. Estimated 4-8 weeks of engineering
  per chunk.
- C → A: two additive jumps (C → B → A). Estimated 12-16 weeks total.

### If doctrine hardens (owner decides even acknowledgement tick is too much)

- A → C: subtractive. Remove reactions, remove presence, remove
  feed, remove directory. Each generates user-visible regression.
  Estimated 6-10 weeks of engineering plus user-comms cost.
- B → C: subtractive but smaller. Remove acknowledgement tick.
  Generates user complaint but no regression of structural features.
  Estimated 1-2 weeks.
- C → C: no change.

### If doctrine stays exactly as ratified

- B → B is the dominant strategy. A is over the line; C is needlessly
  austere.

### Asymmetric conclusion

In two of three doctrine-update paths, B is the option with the
cheapest recovery. In the third (doctrine stays), B is the option
that matches.

---

## Data-model implications

This section is illustrative; the binding spec is in
`channel-and-thread-spec.md`.

### Under Option A

```prisma
// Reaction with full palette and public count
model Reaction {
  id           String   @id @default(cuid())
  message_id   String
  user_id      String
  emoji        String   // free-form, validated against palette
  created_at   DateTime @default(now())
  message      Message  @relation(fields: [message_id], references: [id], onDelete: Cascade)
  user         User     @relation(fields: [user_id], references: [id], onDelete: Cascade)

  @@index([message_id, emoji])
  @@unique([message_id, user_id, emoji])
}

model ReactionCountCache {
  message_id   String
  emoji        String
  count        Int
  updated_at   DateTime
  @@id([message_id, emoji])
}

model Presence {
  user_id      String   @id
  last_seen    DateTime
  status       String   // 'online' | 'away' | 'offline'
}
```

### Under Option B

```prisma
// Reaction is acknowledgement-only. Single type. No public count.
model Reaction {
  id           String   @id @default(cuid())
  message_id   String
  recipient_id String   // who acknowledged
  // sender_id is implicit via Message.author_id
  created_at   DateTime @default(now())
  message      Message  @relation(fields: [message_id], references: [id], onDelete: Cascade)
  recipient    User     @relation(fields: [recipient_id], references: [id], onDelete: Cascade)

  @@unique([message_id, recipient_id])
  @@index([message_id])
}

// No Presence model. No ReactionCountCache. No emoji column.
```

### Under Option C

No `Reaction` model at all. No `VoiceNote` model. `Channel`,
`Message`, `Thread`, `Membership` only.

---

## UX implications (described, no images)

The visible chat surface differs across options:

### Option A (illustrative)

```
[announcements]                                       12 online ┃
─────────────────────────────────────────────────────────────────
@Coach Alex                                              09:14 AM
> Big push this week — let's hit our targets.
  [Reactions: heart 12  fire 8  clap 5]            Reply (3)
─────────────────────────────────────────────────────────────────
@Client Jordan  - 47-day streak                          09:21 AM
> I'm in. Posting workouts in #cohort-april.
  [Reactions: heart 6]                             Reply (1)
─────────────────────────────────────────────────────────────────
```

Note the visible streak badge (`47-day streak`), the visible reaction
counts (12, 8, 5), and the presence indicator (`12 online`). All
three are doctrine violations.

### Option B (recommended; illustrative)

```
[announcements]                                                  ┃
─────────────────────────────────────────────────────────────────
@Coach Alex                                              09:14 AM
> Big push this week — let's hit our targets.
  [received]                                       Reply (3)
─────────────────────────────────────────────────────────────────
@Client Jordan                                           09:21 AM
> I'm in. Posting workouts in #cohort-april.
  [received]                                       Reply (1)
─────────────────────────────────────────────────────────────────
```

The acknowledgement tick (`[received]`) is private to the sender's
view; recipients see it as a tappable affordance, not a count. No
streak badge. No presence indicator. No reaction palette.

### Option C (illustrative)

```
[announcements]                                                  ┃
─────────────────────────────────────────────────────────────────
@Coach Alex                                              09:14 AM
> Big push this week — let's hit our targets.
                                                   Reply (3)
─────────────────────────────────────────────────────────────────
@Client Jordan                                           09:21 AM
> I'm in. Posting workouts in #cohort-april.
                                                   Reply (1)
─────────────────────────────────────────────────────────────────
```

No tick. No reactions of any kind. Replies only.

---

## TypeScript shapes (RFC-illustrative)

Binding contracts in `channel-and-thread-spec.md`. These are sketches
for the RFC reader.

### Option B reaction surface

```ts
// API: POST /api/community/messages/:id/ack
// Adds the acknowledgement tick. Idempotent.
type AckRequest = {
  // No body. Recipient is inferred from auth.
};

type AckResponse = {
  message_id: string;
  acknowledged_at: string; // ISO 8601
};

// API: GET /api/community/messages/:id (sender's view)
// Sender sees their own outbound message + which Membership IDs have
// acknowledged. No counts surfaced beyond "your N recipients
// acknowledged" if N > 1 (e.g. an announcement to many clients).
type SenderViewMessage = {
  id: string;
  body: string;
  created_at: string;
  acknowledged_by_count: number;     // private to sender
  acknowledged_recipients: string[]; // private to sender; UI may show
                                     // names only to coach in DMs.
};

// API: GET /api/community/messages/:id (recipient's view)
// Recipient sees the message. The fact that they have or have not
// acknowledged is local UI state plus a private flag.
type RecipientViewMessage = {
  id: string;
  body: string;
  created_at: string;
  acknowledged_by_me: boolean;
};
```

### Option A surfaces (for contrast)

```ts
// Public counts and reactor lists are surfaced to all viewers.
type ReactionAggregate = {
  emoji: string;
  count: number;
  reactors_sample: string[]; // first N user IDs who reacted
};

type PublicViewMessage = {
  id: string;
  body: string;
  created_at: string;
  reactions: ReactionAggregate[];
  author_streak_days: number; // doctrine violation
};

type PresencePayload = {
  online_now: number;
  last_seen_by_user: Record<string, string>; // user_id → ISO ts
};
```

---

## Decision request

The owner is asked to choose **one of A, B, C** and write the choice
into this file as `STATUS: DECIDED — Option <X>`. Once decided:

- `channel-and-thread-spec.md` is updated to remove non-selected
  options' schema deltas.
- `voice-notes-spec.md` is dropped if Option C, kept otherwise.
- `moderation-and-safety.md` is updated with the moderation surface
  appropriate to the option.
- The PR moves from draft to ready-for-review.

Recommendation: **Option B**.

If the owner wants to defer the decision, the PR remains draft, and
the rest of Wave 10 specs are written conditionally (every spec
file states which options it applies to in its header).

---

## Appendix A: how this RFC was constructed

The author surveyed:

- The doctrine clauses ratified in PR #90.
- The Whop community surface (parity benchmark).
- Discord and Slack as the most likely defection destinations.
- The retention engine's signal requirements (Wave 2).
- The admin data-feed event budget (Wave 3).
- The mobile mirror obligations (Wave 4).
- The Stripe Connect cost model (Wave 5) — used only to size voice
  storage cost in the recommendation.

This RFC does not survey:

- Specific competitor coach-platforms beyond Whop, Discord, Slack.
  The doctrine-collision question is invariant across the broader
  competitive set.
- Multi-language / i18n. Out of scope for v1; called out as a follow-up
  in `channel-and-thread-spec.md`.
- Live voice / video. Explicitly out of scope.

---

## Appendix B: clause-by-clause doctrine compatibility check

For each of the five doctrine clauses, this appendix walks Options A,
B, C against a concrete user-visible artifact, so the owner can see
exactly where each option lives.

### Clause 1 — No public streak counters that shame loss

User-visible artifact: when a client sees another client's handle in
chat, is there a "X-day streak" badge next to the handle?

- **Option A**: Yes. Streak surfaces inline. **Violation.**
- **Option B**: No. Handle is just the handle. The retention engine's
  streak data is privately surfaced to the streak owner and to the
  coach. Other clients never see it. **Compatible.**
- **Option C**: No. Same as B. **Compatible.**

A subtler test: is there a "you broke your streak" notice that any
other client can see?

- **Option A**: Yes (in the feed, retention milestones surface
  publicly). **Violation.**
- **Option B**: No. Streak loss is private. Coach can intervene
  privately via DM. **Compatible.**
- **Option C**: No. Same. **Compatible.**

### Clause 2 — No noisy heart / like reactions that cheapen interaction

User-visible artifact: under a message, what reaction surface does the
viewer see?

- **Option A**: A row of emoji with counts (`heart 12`, `fire 8`). The
  count itself manufactures social proof. **Violation.**
- **Option B**: A single tappable tick. The tick is private to the
  acknowledger; the sender sees their own outbound messages with the
  count of recipients who acknowledged but the count is not surfaced
  to other recipients. **Compatible.** (The boundary case: should the
  acknowledgement tick be visible at all to a third-party
  recipient? Decision in B is no — only the sender sees aggregate.
  Recipient sees their own ack as a UI state, not as a count.)
- **Option C**: Nothing. **Compatible.**

A subtler test: is there an emoji palette?

- **Option A**: Yes. **Violation.**
- **Option B**: No palette. Single fixed acknowledgement.
  **Compatible.**
- **Option C**: No surface at all. **Compatible.**

### Clause 3 — No social-proof manipulation

User-visible artifact: does the platform surface "X people online
now", "Y new messages this week", or any aggregate that creates
artificial urgency?

- **Option A**: Yes (presence indicator, message counters, feed
  engagement metrics). **Violation if any are inflated; doctrine-
  compatible if literally accurate.** The PR #90 doctrine reads as
  "no manufactured social proof", which is silent on whether *real*
  social proof is permissible. The current author's read: even real
  presence indicators violate the spirit (they create urgency
  pressure on the viewer to act). The owner may read this differently.
- **Option B**: No presence, no aggregate counters. **Compatible.**
- **Option C**: Same as B. **Compatible.**

### Clause 4 — No parasocial replacement of coach 1:1

User-visible artifact: can a client mass-message other clients without
the coach mediating?

- **Option A**: Yes (group DM, member directory ranked by activity).
  **Violation.**
- **Option B**: No (no group DM; directory is consent-gated,
  alphabetically sorted; rooms / cohorts are coach-curated channels).
  **Compatible.**
- **Option C**: No (no directory). **Compatible.**

A subtler test: does the platform encourage "friend my coach!"-style
parasocial intimacy via reaction streams from coach to mass clients?

- **Option A**: Yes (visible reaction trail of coach engaging with
  clients in the public feed). **Boundary violation.**
- **Option B**: No. Coach replies are visible in the channel, but
  there is no aggregated "coach reacted to N clients today" trail.
  **Compatible.**
- **Option C**: Same as B. **Compatible.**

### Clause 5 — Audit + GDPR cascade

This clause is platform-wide, not doctrine-specific to community.

- **All options**: every personal-data row writes audit, supports
  GDPR delete. **Compatible.**

### Summary table

| Clause | A | B | C |
| --- | --- | --- | --- |
| 1 — Public streak | Violation | Compatible | Compatible |
| 2 — Noisy reactions | Violation | Compatible | Compatible |
| 3 — Social proof | Boundary | Compatible | Compatible |
| 4 — Parasocial | Violation | Compatible | Compatible |
| 5 — Audit / GDPR | Compatible | Compatible | Compatible |
| **Net** | **Violates 3, boundaries 1, compatible on 1** | **Compatible on all 5** | **Compatible on all 5** |

---

## Appendix C: empirical references and assumptions

This RFC makes several empirical assumptions. Listing them so the
owner can challenge each.

### Assumption 1 — Reaction counts are a real retention surface

The claim: under Option A, reactions with public counts contribute
materially to retention vs Option B with the acknowledgement tick.

Source: industry-wide experience with Slack, Discord, Twitter,
Whop. Reaction-with-count surfaces correlate with longer session
times and higher message volume; whether they correlate with
*retention* (90-day or longer activity) is more contested. The
recommendation here is that the retention payoff exists but is
secondary to the structural surfaces (rooms, voice notes, coach
broadcasts).

Falsifying evidence: a controlled A/B in TGP itself, post-launch.
Until then, the recommendation is "B captures the structural
retention; A captures additional surface that is doctrine-costly".

### Assumption 2 — Discord defection is a real risk

The claim: coaches who run a polished Discord today will not migrate
to TGP-native chat unless TGP-native chat reaches some threshold of
parity.

Source: anecdotal coach interviews (out of scope for this spec, but
the founder's product instinct is that Discord-native coaches are
sticky on Discord). The federation bridge mitigates this risk.

### Assumption 3 — The acknowledgement tick is doctrine-compatible

The claim: a single private acknowledgement signal (received tick) is
not a doctrine violation.

Falsifying read: the doctrine forbids "noisy" reactions; if "noisy"
includes any reaction at all, then even the tick is a violation. The
present read is that "noisy" refers to the multiplier effect of public
counts and emoji palettes; a single private tick is signal without
spectacle.

The owner may disagree. If so, Option C is the right choice.

### Assumption 4 — Voice notes are doctrine-compatible

The claim: asynchronous voice notes (async, transcript-default-
visible, moderable) deliver coach signal that text cannot, and are
not a doctrine violation.

Falsifying read: voice creates parasocial intimacy with the coach,
which (clause 4) the doctrine resists. The present read is that
*parasocial replacement of coach 1:1* refers to client ↔ client mass
intimacy, not coach ↔ client async voice. Coach voice notes that
deepen the coach relationship are aligned with the doctrine, not in
tension.

### Assumption 5 — A future bidirectional Discord bridge is feasible

The claim: in v2, TGP-native chat and Discord can be kept in sync.

This is engineering-tractable. The constraint is Discord ToS (no
unauthorised content modification), not the engineering. Held as a
safe assumption for v2 planning.

---

## Appendix D: anticipated owner objections and responses

The author anticipates several objections to Option B. Listed here
with responses.

### Objection 1 — "The acknowledgement tick is a slippery slope to public counts."

Response: it could be. Mitigation is that the schema does not store
emoji or count fields. Adding public counts would require a new
schema column, a new route, and a new client surface. The slope is
not slippery; it is a deliberate set of additional changes.

### Objection 2 — "Member directory is a parasocial surface even if consent-gated."

Response: maybe. The current spec defaults the directory to
opt-in-only, alphabetically or join-date sorted, and explicitly not
ranked by activity. If the owner reads the directory as a parasocial
surface, the directory can be dropped from Option B without affecting
the rest of the spec. (Equivalent to "Option B-minus".)

### Objection 3 — "Voice notes give clients a vehicle for low-effort
participation that disguises disengagement."

Response: possibly. The transcript-default-visible policy mitigates
this — every voice note is also text, so a "lazy client uploading
1-second 'hi' voice notes" is visible as such. The 1-second minimum
plus the moderation pipeline (auto-flag for rapid trivial uploads)
provides further mitigation. If the concern is decisive, voice notes
can be coach-only (clients can listen but not record), which is a
sub-decision under Option B.

### Objection 4 — "Discord federation is a way of permanently
keeping coaches off TGP-native chat."

Response: a fair concern. Mitigation is that the federation is
read-only; it does not let coaches *post* into Discord from TGP. So
TGP is not a Discord client. The federation gives TGP retention-
engine signal without forcing migration; the migration incentive is
the rest of TGP (programs, payments, sub-coaches, retention rewards).

### Objection 5 — "Why is presence not even a sub-decision under B?"

Response: presence is a doctrine-boundary case. The current spec
takes the conservative read (presence = social-proof manipulation by
default, even if literally accurate). If the owner reads presence as
benign, it can be added to Option B without breaking the rest. (It
would require a new schema delta — `Presence` table or a Redis-only
ephemeral store — and a new route. The cost is bounded.)

---

## Appendix E: sequencing recommendation

Independent of which option is chosen, the following sequencing is
recommended:

1. **Lock the doctrine read.** Owner publishes a 1-page restatement of
   PR #90 referencing the chosen option. Public commitment.
2. **Ship the channel + thread spec** (`channel-and-thread-spec.md`)
   first. This is the largest scope and gates everything else.
3. **Ship moderation pipeline** (`moderation-and-safety.md`) before
   any user-generated content goes live. Skipping this is a legal
   and brand risk.
4. **Ship voice notes** (if Option B selected) once moderation is
   live, because voice notes participate in the moderation pipeline.
5. **Ship Discord federation** in parallel with voice notes, since
   it is independent of the chat surface.
6. **Mobile mirror** ships PR-by-PR as backend chunks land.

The full sequence is ~6 weeks for B. Roughly +2 weeks for A. Roughly
-1 week for C.

---

## Appendix F: glossary

For consistent reading.

- **Doctrine** — the psych principles ratified in PR #90.
  Specifically: no public streak counters, no noisy reactions, no
  social-proof manipulation, no parasocial replacement of coach 1:1,
  audit + GDPR everywhere.
- **Option A** — full Whop-style community (parity benchmark).
- **Option B** — doctrine-compatible community (recommended).
- **Option C** — maximally pure community (text + threads only).
- **Acknowledgement tick** — Option B's single-type private reaction.
  Sender sees aggregate of recipients who tapped; recipients see only
  their own tap.
- **Doctrine-compatible** — every doctrine clause is satisfied; no
  user-visible artifact contradicts the doctrine.
- **Reversibility** — the cost of moving from one option to another
  after launch.
- **Asymmetric reversibility** — moving from B to A is cheap; moving
  from A to B is expensive.
- **Parity benchmark** — Whop's current community surface.
- **Federation bridge** — the read-only (v1) or bidirectional (v2)
  link between TGP and an external chat platform (Discord in v1).
- **Scope-stack** — Wave 3's nested scope keys (org → cohort → coach
  → client) used for permission resolution and cache keys.

---

## Appendix G: change history of this RFC

| Version | Date | Change |
| --- | --- | --- |
| v0.1 | 2026-05-01 | Initial draft (this document). |

Future updates will append rows here. The owner's decision becomes
v1.0; any subsequent changes are versioned.
