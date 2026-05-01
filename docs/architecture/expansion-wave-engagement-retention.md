# Expansion wave: engagement & retention + AI Business Copilot

> **Status:** Draft addendum to the expansion roadmap.
> **Coexists with:** PR #119 (rows #01–#20), PR #121 addendum
> (rows #21–#29), PR #123 wave (rows #30–#37). Folds into the
> main roadmap's index table once PR #119 merges.
> **Stage:** discovery → spec.

This wave reserves rows #40–#44 in the same numbering scheme
PR #119 introduces. Five docs-only specs that together turn
the platform into a one-stop-shop for a coach's audience —
the asynchronous community, the synchronous live calls, the
durable back-catalog, the financial reward layer, and the
operator-side AI assistant that reads from all of them.

## Rows

| # | Item | Spec | Brief |
|---|---|---|---|
| 40 | Coach-Owned Community Spaces | [`docs/specs/community-spaces.md`](../specs/community-spaces.md) | [`docs/architecture/handoff/40-community-spaces.md`](./handoff/40-community-spaces.md) |
| 41 | Events and Live Calls | [`docs/specs/events-live-calls.md`](../specs/events-live-calls.md) | [`docs/architecture/handoff/41-events-live-calls.md`](./handoff/41-events-live-calls.md) |
| 42 | Replays and Content Library | [`docs/specs/replays-content-library.md`](../specs/replays-content-library.md) | [`docs/architecture/handoff/42-replays-content-library.md`](./handoff/42-replays-content-library.md) |
| 43 | Rewards and Bounties | [`docs/specs/rewards-and-bounties.md`](../specs/rewards-and-bounties.md) | [`docs/architecture/handoff/43-rewards-and-bounties.md`](./handoff/43-rewards-and-bounties.md) |
| 44 | AI Business Copilot for Coaches | [`docs/specs/ai-business-copilot.md`](../specs/ai-business-copilot.md) | [`docs/architecture/handoff/44-ai-business-copilot.md`](./handoff/44-ai-business-copilot.md) |

## Why these five together

The five rows are designed as a **single retention loop**:

1. **#40 community** is the always-on home for the audience.
2. **#41 events** are the synchronous moments that pull the
   audience back in.
3. **#42 library** is the durable back-catalog where every
   moment lives forever (or until retention expires).
4. **#43 bounties** are the coach-defined incentives that
   convert engagement events into retention events.
5. **#44 Copilot** is the operator-side surface that reads
   from #40–#43 (plus the at-risk detector and weekly recap
   from PR #121) and helps the coach actually run the
   resulting business.

Shipping any subset alone is strictly less valuable than
shipping the loop. Specifically:

- **Community without events** is a feed.
- **Events without library** is a recurring "did you record
  it?" race.
- **Library without community** is a Vimeo link.
- **No bounties** = no incentive layer = engagement is pure
  dopamine.
- **No Copilot** = every signal the platform produces stays
  in a dashboard tile the coach forgets.

## Dependency graph

```
                     ┌─────────────────────────────┐
                     │        PR #117 RFC          │
                     │  (Storage prefix, mime,     │
                     │   provider, eval CI,        │
                     │   prompt template table,    │
                     │   per-coach budget)         │
                     └──┬──────────────────────────┘
                        │
       ┌────────────────┼─────────────────┬─────────────────┐
       │                │                 │                 │
       ▼                ▼                 ▼                 ▼
   #40 community   #41 events        #42 library       #44 Copilot
       │                │                 ▲                 ▲
       │                │                 │                 │
       │                └─────────────────┘                 │
       │              (recording handoff)                   │
       │                                                    │
       └──────────────► #43 bounties ─────────────────────► (uses)
                            │
                            └────► PR #121 #22 / #23 / #24
                                   (at-risk, recap, voice)
                                          │
                                          ▼
                                   #44 Copilot
```

#44 Copilot is downstream of every other row in this wave + the
PR #121 #22/#23/#24 trio. It does not ship without them.

## Coexistence with prior PRs

- **PR #117 (AI Program Builder RFC)**: every row in this wave
  reuses the Storage prefix, the mime allow-list, the
  provider abstraction, the eval CI, the prompt-template
  table, and the per-coach budget. Each spec calls these
  reuses out by §-reference.
- **PR #118 (Team Mode foundation ADR)**: every new table in
  this wave reserves the `acted_by_member_user_id` forward-
  compat column. The Team Mode wiring PR series can layer in
  staff-acted-as-coach attribution without a schema retrofit.
- **PR #119 (roadmap rows #01–#20)**: this addendum extends
  the same row-numbered shape; rows #40–#44 are append-only.
- **PR #120 (platform-readiness lanes)**: every row maps onto
  one or more lane briefs; the gap map at
  [`gap-map-engagement-retention.md`](./gap-map-engagement-retention.md)
  has the explicit lane crosswalk.
- **PR #121 (specs #21–#29)**: #44 Copilot has hard
  dependencies on #22 (at-risk detector), #23 (weekly recap),
  and #24 (coach AI voice). #43 bounties is the financial
  cousin of #29 revenue dashboard.
- **PR #122 (mastermind operating model)**: Phase 4 cohort
  surface reuses #40 community + #41 events (cohort space =
  member-only community + scheduled IRL events with the same
  RSVP / attendance / reminder lifecycle).
- **PR #123 (coach-experience wave, rows #30–#37)**: #30
  challenges + #31 leaderboards are natural redemption
  triggers for #43 bounties; #33 content-boards is a v0
  superseded by #42 library; #34 regimens publishes lessons
  that the library imports lazily; #36 messaging+progress
  is the deep-link convention #44 Copilot writes drafts
  into.

## Stage definitions (mirrors PR #119)

- **parking lot** — the row exists in this index but no spec.
- **in discovery** — a draft RFC / spec is in flight; runtime
  work is blocked.
- **in flight** — at least one runtime PR has merged behind
  the row's feature flag (still default off).
- **shipped** — the feature flag is on for the entire
  intended tier in production.

All five rows are **in discovery** as of this PR.

## How to fold this addendum into the main roadmap (when PR #119 merges)

The addendum exists separately so the two PRs are trivially
mergeable in either order. Once PR #119 merges, fold-in is a
five-row append to the main `expansion-roadmap.md` index
table:

| # | Item | Stage | Spec / brief |
|---|---|---|---|
| 40 | Coach-Owned Community Spaces | in discovery | [spec](../specs/community-spaces.md) / [brief](./handoff/40-community-spaces.md) |
| 41 | Events and Live Calls | in discovery | [spec](../specs/events-live-calls.md) / [brief](./handoff/41-events-live-calls.md) |
| 42 | Replays and Content Library | in discovery | [spec](../specs/replays-content-library.md) / [brief](./handoff/42-replays-content-library.md) |
| 43 | Rewards and Bounties | in discovery | [spec](../specs/rewards-and-bounties.md) / [brief](./handoff/43-rewards-and-bounties.md) |
| 44 | AI Business Copilot for Coaches | in discovery | [spec](../specs/ai-business-copilot.md) / [brief](./handoff/44-ai-business-copilot.md) |

Append; do not delete the addendum. The addendum's "why
these five together" + dependency graph stay as a separate
record of intent.

## What is deliberately NOT in this wave

- Cross-coach community / discovery / marketplace (parking-lot;
  unsafe to ship without anti-abuse maturity that does not
  yet exist on the platform).
- Voice/video media plane proxied by the platform (kept
  third-party for cost, latency, abuse, and DMCA reasons).
- Member-uploaded content into the library (only coach +
  OWNER + Team Mode staff write).
- Sweepstakes / lottery prize draws (legal posture in
  [`docs/specs/rewards-and-bounties.md`](../specs/rewards-and-bounties.md) §11).
- Auto-award path on bounties that doesn't run through OWNER
  review threshold (parking-lot until the predicate maturity
  is higher).
- Free-form "Copilot, anything" kind (the eight structured
  kinds are the moat; a free-form Copilot is a worse ChatGPT).
- Voice input on Copilot (parking-lot; v1 is text-only).
- Mobile-side Copilot (operator-only in v1; mobile is the
  client experience).
- Public RSS / podcast feed export from the library (parking-
  lot row #11 in PR #119).

## Hard boundaries (preserved across the wave)

- ❌ The `new-website` repo is not touched. Public surfaces
  for coach profiles are rendered by **this** backend's
  public-pages module, not the marketing site.
- ❌ No change to PR #117, #118, #119, #120, #121, #122, #123.
- ❌ No `prisma/schema.prisma` change.
- ❌ No new migration in `prisma/migrations/`.
- ❌ No `app.module.ts` wiring.
- ❌ No new env var registered in `src/common/env-validation.ts`
  (env vars are *named* in the specs, not added).
- ❌ No mobile or coach-console contract change in this PR.
