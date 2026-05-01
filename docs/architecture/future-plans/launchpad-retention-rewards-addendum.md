# Launchpad Retention & Rewards — Operator Addendum

**Status:** Draft addendum, not a build spec.
**Captured:** 2026-05-01.
**Source:** YouTube — *"How I Scaled Digital Launchpad To Over $474K MRR
in 50 Days"* — <https://youtu.be/Hcn9tQmkej4?si=PficCtDXyDUdpU9n>.
**Provenance caveat:** The full authoritative transcript could not be
downloaded directly (YouTube bot protection blocked the transcript
endpoint in the capture session). The lessons distilled below were
reconstructed from web-search snippets of the video plus the title
metadata. Treat every claim as paraphrase, not quote. Before any of
this becomes a build commitment, an operator should re-watch the video
in full and confirm or correct the points on this page.

This document is a durable operator note. It exists so a future
builder picking up retention or rewards work has the context behind
why those features matter, and so the lessons from the video do not
evaporate the moment this branch is closed. It does not modify any
runtime source, schema, migration, env validation, or CI. The only
non-`docs/` edit allowed under this PR is the link in
[`docs/README.md`](../../README.md) so the page is discoverable.

---

## Why this page exists

The video is a first-person account from a coach who scaled a
coaching offer ("Digital Launchpad") to roughly $474K MRR in about
50 days. The mechanism was *not* a single funnel hack — it was a
stacked system of retention rituals, earned unlocks, and recognition
loops layered on top of an already-sold cohort. Every line in the
video maps to either a client-experience lever or a coach-operator
lever the platform should support, so this page is structured around
those two audiences.

The user's framing was: *every line is gold for improving the
client/coach experience*. That framing is preserved here — when a
lesson is operator-facing rather than product-facing, it is still
listed, because the platform's job is to make those operator moves
cheap to execute.

---

## Client retention — bonuses by tenure month

The video's most concrete idea is a tenure-keyed bonus ladder. A
client gets *something new* at predictable points in their lifecycle,
which compounds with whatever they were originally sold. The points
called out in the source were **months 2, 3, 6, 12, and 24**. The
intent is that the bonus is large enough to be worth showing up for
on its own, and that each step unlocks something the prior step did
not.

Concrete bonus categories the source described, in rough order of
"cheap to deliver" to "expensive to deliver":

1. **More coaching offers / extra coaching sessions.** Additional
   1:1 or small-group calls beyond what the base offer included.
   These should attach to the same coach by default so the
   relationship deepens rather than diluting.
2. **Mastermind access.** Group-format sessions, peer-to-peer, often
   the highest-leverage retention move because it converts a 1:1
   relationship into a network effect — the client now has reasons
   to stay that the coach is not personally producing.
3. **Live event invites.** In-person or hosted virtual events. Even
   the *invitation* is a retention asset; the event itself is the
   payoff.
4. **Exclusive content drops.** Modules, recordings, playbooks, or
   deep-dive workshops not in the base curriculum. The framing
   matters: "you get this because you're 6 months in," not "here's
   another piece of content."
5. **Secret channels.** Private community spaces — a Slack/Discord/
   in-app channel that only tenured clients can see. The scarcity is
   the product.
6. **Status / badges.** Visible markers ("90-day club", "Year One",
   "Founding Member") that show up in community surfaces and on the
   client's own profile. These cost the platform nothing and
   compound forever.
7. **Progress milestones.** Surfaceable, celebratable checkpoints
   inside the app — not just internal counters but moments the app
   actively congratulates the client for and asks them to share.
8. **Wins channel / community recognition.** A dedicated surface
   where wins are posted and reacted to, by the client themselves and
   by the coach. The recognition loop is the retention mechanism;
   the channel is just where it lives.

The unifying pattern: **bonuses are earned by tenure, not bought.**
A client cannot upgrade their way into the month-12 bonus. That is
what makes the ladder load-bearing.

---

## Coach retention — what keeps the people who run cohorts

Coaches are the platform's true compounding asset. The video's
implicit claim is that the same retention mechanics that work on
clients work on coaches, with different content. The operator
levers called out:

1. **Private calls with the founder / lead coach.** Direct mentor
   proximity. The platform's job is to make these easy to schedule
   and to gate by tenure or performance, not to host the call itself.
2. **B2B mastermind invites.** A coach-only mastermind, separate
   from any client mastermind. Coaches sharing what works with each
   other is the highest-bandwidth coach-education channel a platform
   can offer, and the platform owns the scheduling, attendance, and
   recording surfaces.
3. **Special referral links that generate profit.** A coach who
   refers another coach should see real revenue, attributed and
   paid out automatically. This is product, not back-office.
4. **Free client-migration support.** When a coach considers moving
   from another platform, the friction is the existing roster.
   Removing that friction is a coach-retention play even though it
   feels like sales.
5. **Badges / status for coaches.** Same mechanic as clients —
   visible markers of tenure, cohort size, win count, retention
   rate. Coaches are competitive; the leaderboard is the feature.
6. **Moderation / community-leader roles.** Tenured, high-trust
   coaches get elevated rights inside community surfaces. This is
   both a recognition lever and a labor-distribution lever — the
   community moderates itself once enough leaders exist.
7. **Mentor proximity.** Structured access to the platform's most
   senior operators — not just the founder, but a tier of senior
   coaches who run office hours.
8. **Live event access.** Coach-tier events, separate from client
   events. The IRL component matters disproportionately.
9. **Business operations support.** Help with the un-fun parts of
   running a coaching business — bookkeeping templates, contract
   templates, hiring playbooks. The platform's leverage here is that
   it sees what works across many coaches and can codify it.

The unifying pattern for coaches: **the platform makes the boring
parts cheap and the high-status parts visible.**

---

## Translation into TGP product principles

The lessons above are not platform-neutral. Translated into
principles this codebase should hold to as retention and rewards
features land:

### 1. Retention through earned levels

Every retention surface should expose *what the user has earned* and
*what the next thing is*. Hidden progress is wasted progress.
Surfaces touched: client home, coach dashboard, profile, and any
notification copy.

### 2. New unlocks, not new content

A bonus is a *thing that wasn't there yesterday*. The unlock event
is the experience; the content is the payload. The data model
should record the unlock as a first-class event so it can be
celebrated, surfaced, and reasoned about, not just gated.

### 3. Mobile-first progress tracking

The phone is where the recognition loop closes. Wins, badges,
milestones, and unlocks must render correctly, push correctly, and
share correctly from mobile before they exist anywhere else. Any
desktop-only retention surface is a missed loop.

### 4. Community status

Status is a feature. Badges, tenure, role markers, and leadership
indicators belong in the community surface and in the profile, not
in admin tools.

### 5. Exclusive access

Some surfaces should be invisible to users who have not earned
them. "Locked with a teaser" and "doesn't exist" are different
products; this principle prefers the latter for the highest tiers.
A client who is two months from earning the secret channel should
not see that channel listed.

### 6. Live calls and events

The platform must treat live events as first-class, not as calendar
attachments. RSVP, attendance, recordings, and post-event followups
are all product surfaces.

### 7. Rewards and bounties

A reward is a tenure unlock. A bounty is a reward for a specific,
named action ("invite a coach", "post your first win", "complete
the 30-day check-in"). Both should run on the same eventing
substrate.

### 8. Referrals

Referral links must attribute revenue, pay out automatically, and
surface the referrer's earnings. A referral feature that requires a
human in finance to reconcile is not a referral feature.

### 9. Power-user recognition

The 95th-percentile coach and the 95th-percentile client are
different cohorts and deserve different recognition. The platform
should detect both and give each a path to elevated status.

---

## Connection to existing and future PRs

This document is intentionally a peer to several open expansion-wave
drafts rather than a replacement. Cross-references, with the caveat
that each PR is open and may evolve:

| Open PR | Title (as of 2026-05-01) | Relationship to this addendum |
|---|---|---|
| [#122](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/122) | docs(masterminds): draft operating-model spec for paid IRL masterminds + L2/L3 SaaS tiers | Mastermind access (clients) and B2B mastermind (coaches) are bonus-ladder rungs and coach-retention rungs respectively. The operating model in #122 should be the authority on how mastermind access is fulfilled; this addendum is the authority on *when* it is granted (months 6/12/24 for clients; tenure + performance for coaches). |
| [#123](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/123) | docs(expansion): coach-experience wave — specs + handoff briefs (rows #30–#37) | The coach-side rewards in this addendum (B2B mastermind invites, badges, mentor proximity, business-ops support, live event access) belong in the coach-experience wave's scope. This addendum should feed into #123's roadmap rather than fork it. |
| [#125](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/125) | docs(expansion): commerce & marketplace wave — specs + briefs (rows #40-#45) | Referral links that generate profit, paid client-migration support, and any "exclusive content drop" with monetary value cross into commerce/marketplace. The marketplace wave is the right home for the payments and attribution plumbing this addendum names. |
| [#126](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/126) | docs(expansion): engagement & retention wave + AI Business Copilot (rows #40–#44) | This is the closest sibling. The bonus ladder, badges, milestones, wins channel, and unlock events all belong in the engagement & retention wave. This addendum is the operator-context companion to #126 — it explains *why* those features matter and what the source for them is. |
| [#127](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/127) | docs: draft enterprise admin web dashboard spec | Operator visibility into the bonus ladder (who is at what tenure, who is owed what unlock, which unlocks fired vs. failed) belongs in the admin dashboard. This addendum is a hint to #127's scope: surface tenure cohorts and unlock state to OWNER. |

A future PR that builds on this addendum should reference it in the
description so the lineage is preserved.

---

## Acceptance criteria for follow-up work

When the engagement & retention wave (#126 or its successor) starts
turning these notes into product, the following acceptance criteria
apply. They are deliberately stated as outcomes, not implementations,
so the eventual builder is not boxed in.

1. **Tenure unlock is event-driven.** The platform fires a typed
   event when a client crosses a tenure threshold (2/3/6/12/24
   months), and that event is the canonical trigger for the unlock,
   the notification, and the analytics row. A tenure unlock is not
   a cron job's side effect.
2. **Bonuses are addressable.** Each bonus type from the bonus-ladder
   list above has a stable identifier so it can be referenced from
   admin tools, customer support, and analytics. "Mastermind access"
   is a thing the system can name.
3. **Status markers render on mobile.** Every badge or status marker
   defined in this work must have a mobile rendering pass before the
   feature is considered shipped. Web-only is not shipped.
4. **Coach-side rewards are isolated from client-side rewards.** The
   coach reward ladder and the client reward ladder share the
   eventing substrate but not the surfaces. A client cannot see the
   coach mastermind exists, and vice versa.
5. **Referral attribution is end-to-end.** A coach referral link
   produces an attributed signup, an attributed first payment, and a
   payout the referrer can see. No human reconciliation step.
6. **Exclusive surfaces are gated, not teased.** The highest-tier
   surfaces (secret channels, year-2 content) are invisible to users
   who have not earned them. There is no "locked" placeholder for
   the top of the ladder.
7. **Wins are first-class.** Posting a win, reacting to a win, and
   being recognized for a win are three distinct, addressable
   actions. Each is countable and each is a possible bounty target.
8. **Operator dashboard exposes the ladder.** OWNER can answer "how
   many clients are within 30 days of their next unlock" and "which
   unlocks failed in the last 7 days" without writing SQL.
9. **The source is preserved.** The video URL above is recorded in
   the eventual PR description so the lineage from source → spec →
   build is auditable.

---

## Operator handoff

A future operator picking this up — whether engineer, PM, or
founder — should:

1. Re-watch the source video and reconcile any drift between this
   page and the actual content. The reconstruction was from
   snippets, not transcript.
2. Decide which wave (engagement & retention #126, masterminds
   #122, commerce #125) absorbs which lessons. This page does not
   prescribe ownership.
3. Promote the agreed lessons into specs in the relevant wave,
   leaving this page as the historical source-of-context.
4. Do not try to ship the whole ladder at once. Months 2 and 3 are
   the highest-leverage rungs because they fire on every cohort;
   months 12 and 24 fire only on cohorts that are already retained.
   Earliest rungs are the ones to build first.
5. When in doubt, treat any ambiguity in this page as a signal to
   re-watch the video, not to invent.

---

## Out of scope for this addendum

- No runtime code change.
- No schema or migration change.
- No env or CI change.
- No edits to `new-website` (out of scope by direction).
- No commitment that any feature here will ship. This page is
  context, not a backlog.
