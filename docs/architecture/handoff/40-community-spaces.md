# Handoff: #40 Coach-Owned Community Spaces

> Operator brief. The engineer-facing long form is
> [`docs/specs/community-spaces.md`](../../specs/community-spaces.md).
> Read this in 60 seconds before you do anything else with row #40.

## WHY

Coaches lose retention because their audience lives in five tools
they don't control: Discord, Skool, Notion, Zoom, mailing list.
The platform already owns the coach ↔ client relationship; a
member-only community space gated by the coach's existing seat
turns "I bought a tracker" into "I joined my coach's home." The
business win is retention; the legal posture stays clean
because access is bound to the coach's existing subscription
seat (no separate community SKU).

## WHEN

Cannot start runtime PR-1 until: PR #120 lane #01 has accepted
the unified `can()` resolver shape; PR #117 §8 has confirmed
the Supabase Storage prefix; PR #118 has accepted the
`acted_by_member_user_id` forward-compat hook; PR #120 lane
#04 has filled out the per-table retention matrix for the
five new tables; PR #120 lane #05 has decided whether
communities are bundled or add-on. All five are spec-only
decisions; no runtime work blocks them.

## WHERE

New module `src/community/` peer to `src/messaging/`. Six new
tables: `CommunitySpace`, `CommunityPost`, `CommunityComment`,
`CommunityReaction`, `CommunityReport`, `CommunityRole`. New
env-var family `COMMUNITY_*`. No edits to existing tables in
v1. No `new-website` change.

## WHO

Founder owns: tier bundling, public-preview policy, naming.
Backend lead owns: schema, write-fan-out vs read-fan-in,
toxicity classifier choice. Mobile owns: feed shape +
reactions vocabulary. Coach console owns: moderation surface.
OWNER carries the pager for the first 30 days.

## WHAT

Already exists: `User`, `CoachProfile`, `CoachSubscription`,
`SubscriptionGuard`, `CoachMessage`, `CommunityWin`,
`AuditLog`, Supabase Storage prefix (PR #117 §8), the
Supabase Realtime ping pattern.

Net-new: 6 tables, the community-feed composer service, the
moderation service (toxicity classifier wrapped, best-effort,
provider-pluggable), the abuse-report intake, the per-coach
moderator role placeholder.

Non-goals (deliberate): cross-coach discovery, voice/video,
threaded multi-level comments, polls, in-feed events,
member-uploaded video. v1 is plaintext + one optional
attachment per post.

## HOW

8-PR rollout (spec §7.1). PR-1 is schema + empty `GET`
behind `COMMUNITY_SPACES_ENABLED=false`. Each PR is
independently revertable; revert = flag flip; no destructive
migration ever runs in the rollback path.

Smallest first PR ships only: schema additions, module
mounted behind the flag, route returns the empty envelope
when off, smoke-shape assertion, OpenAPI export update.

## Risks (top 3)

1. Engagement death spiral — a dormant community is worse
   than no community. Mitigation: AI Business Copilot (row
   #44) drafts post ideas; at-risk detector (PR #121 #22)
   surfaces dormancy.
2. Moderation overload — solo coach + 1k members + no
   moderator. Mitigation: PR-6 ships per-coach moderator;
   PR #118 Team Mode wires it.
3. Storage cost runaway — a single coach fills the bucket.
   Mitigation: 50 MB cap per attachment, daily post cap,
   per-coach storage quota with 80% OWNER alert.

## Acceptance criteria (one-line)

A coach posts → the roster reacts/comments → the OWNER
moderation surface flags reports → the OWNER metrics counter
reflects active spaces, DAU per coach, and open reports →
flag-flip kill-switch revert with no migration.

## Operator handoff

- **Kill-switch:** `fly secrets set COMMUNITY_SPACES_ENABLED=false
  -a tgp-backend-prod`.
- **Dashboards:** PR #120 lane #06 dashboard receives DAU
  per coach, open reports, storage usage per coach.
- **Runbook entry:** `docs/operations/community-spaces.md`
  (future doc) covers moderation, GDPR scrub, quota alert
  triage.
- **First 30 days:** OWNER reads `community_open_reports`
  daily; any report aged > 24h is the on-call signal.

## Cross-references

- Engineer spec: [`docs/specs/community-spaces.md`](../../specs/community-spaces.md)
- Adjacent specs: [`events-live-calls.md`](../../specs/events-live-calls.md),
  [`replays-content-library.md`](../../specs/replays-content-library.md),
  [`rewards-and-bounties.md`](../../specs/rewards-and-bounties.md),
  [`ai-business-copilot.md`](../../specs/ai-business-copilot.md)
- Related drafts: PR #117, #118, #120, #121, #123.
