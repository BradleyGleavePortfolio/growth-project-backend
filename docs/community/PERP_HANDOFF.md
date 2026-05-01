# Wave 10 — Session Handoff

Author: Wave 10 spec agent.
Date: 2026-05-01.
Status: Draft PR open. Awaiting OWNER_DECISION 1 (A/B/C).

---

## What this session shipped

Seven docs under `docs/community/`:

1. `README.md` — wave overview, non-goals, OWNER decisions, file map,
   dependency graph, merge order.
2. `doctrine-decision-rfc.md` — the highest-stakes file. A vs B vs C
   feature matrix, risk analysis, reversibility analysis, data-model
   implications, recommendation rationale (Option B).
3. `channel-and-thread-spec.md` — channel taxonomy, permission matrix,
   Prisma deltas (illustrative), state-transition tables, 8 failure
   modes, route surface, performance budgets, test plan, rollback
   plan, onboarding checklist.
4. `voice-notes-spec.md` — recording, two-phase upload, transcription
   via sonar-pro, accessibility (transcript-default-visible), 90-day
   audio retention, storage cost rough budget (<$0.05/coach/month at
   10k scale), 8 failure modes.
5. `moderation-and-safety.md` — auto-flag rules, severity → action
   map, manual review queue with SLAs, 6-step ban ladder, audit
   trail, right-to-be-forgotten cascade, CSAM compliance, 7 failure
   modes.
6. `integration-with-discord.md` — read-only v1 (recommended) vs
   bidirectional v2, OAuth flow, identity reconciliation (strict
   mode), rate-limit handling, ToS compliance, 8 failure modes.
7. This file.

No code. No migrations. No schema applied. `prisma/schema.prisma`
unchanged.

---

## The decision the owner must make

**OWNER_DECISION 1 — A vs B vs C.** This is the single highest-stakes
question across the parity set. Surface the doctrine collision PR #90
ratified vs the parity benchmark Whop's native community provides.

Recommendation: **Option B (doctrine-compatible community)**. See
`doctrine-decision-rfc.md` for the full analysis. Short version:

- Option A violates doctrine (reactions with public counts, presence,
  feed metrics, public streak surfacing). High retention upside but
  wrong on brand and hard to retract.
- Option B is doctrine-compatible. Acknowledgement-only reaction
  (single tick, no public count). Structured rooms / cohorts / DMs.
  Voice notes (async, transcript-default-visible). Member directory
  with explicit consent. Reversible up to A or down to C.
- Option C drops the acknowledgement tick and voice notes entirely.
  Maximally pure doctrine but probably underperforms retention vs
  Discord defection.

**Until the owner answers, this PR remains draft.** No subsequent
work in Wave 10 should land.

---

## Other OWNER_DECISIONs surfaced (in priority order)

2. Voice-note retention window — recommend 90 days (audio purge;
   transcript retained per text retention).
3. Voice-note maximum length — recommend 5 minutes.
4. Discord bridge depth — recommend read-only v1, bidirectional v2.
5. Moderation queue ownership — recommend platform-owned with
   per-coach escalation.
6. DM scope in v1 — recommend 1:1 only (coach ↔ client or client ↔
   sub-coach), no group DMs, no client ↔ client DMs.

Several sub-decisions are tagged `OWNER_DECISION_DEFERRED:` inside
specific files (e.g., DM read-receipt indicator under Option B,
cohort-channel default visibility on cohort end, Discord identity
reconciliation strictness). They do not require resolution before
Decision 1 lands.

---

## Cross-repo implications

- `growth-project-mobile`: this spec is consumed by the mobile mirror.
  Mobile RN app must implement voice-note recording via native APIs,
  push notifications for new messages and acks, and the
  transcript-default-visible UI. The mobile PR will reference this
  spec by filename.
- `tgp-finance-app`: voice-note storage cost surfaces as a per-org
  bill line item via the Wave 5 billing computation. Read from a
  derived per-org metric, not stored on `Message` rows.

---

## What the next agent should NOT do

- Do not apply the schema deltas. They are illustrative only.
- Do not pre-decide the A/B/C question. Surfacing the trade-space is
  the point of the RFC; the owner must decide.
- Do not extend the spec to live voice / video. Out of scope.
- Do not add AI-generated reply suggestions inside chat. Out of v1
  scope (separate consent surface required).
- Do not collapse the moderation pipeline into the coach's hands.
  Platform-owned moderation is a deliberate floor; coaches can layer
  on, not replace.

---

## What the next agent CAN do

- Once the owner resolves Decision 1, refine the spec to remove
  non-selected options.
- Author an implementation plan that maps Day-1 implementation order
  to a concrete sprint plan.
- Open follow-up PRs for the mobile mirror, Discord federation
  details, voice-note worker code.
- If the owner picks A: extend `doctrine-decision-rfc.md` with the
  brand-comms plan (because Option A contradicts PR #90 — that
  contradiction must be addressed publicly).

---

## Open known risks

1. **Doctrine credibility risk** — variable per option (see RFC).
2. **Discord defection risk** — partially mitigated by the federation
   bridge.
3. **Moderation load at scale** — bounded under B; multiplied under A.
4. **Voice-note storage cost** — modelled at ~$260/month at 10k
   coaches; sane.
5. **AI cap** — transcription dominates AI spend; per-org caps
   enforced.
6. **Mobile parity drift** — mitigated by shipping this spec first
   and following with the mobile PR.
7. **EU/US legal surface** — DSA + GDPR + Section 230 + state laws
   covered in `moderation-and-safety.md`.

---

## Pointer summary

If you are the human reviewer:

- 5 minutes: read `doctrine-decision-rfc.md`.
- 30 minutes: read `README.md` + RFC + permission matrix +
  channel taxonomy in `channel-and-thread-spec.md`.
- Senior engineer onboarding: read all 7 files in the order in the
  README's file map.

If you are the next subagent:

- Confirm the owner's Decision 1 has been recorded before doing any
  refinement.
- Touch only `docs/community/`. Do not write to `prisma/schema.prisma`
  or anywhere else outside docs.
- Maintain the "no emojis" doctrine, no placeholders, no fake
  testimonials, no TODOs (all open questions are tagged
  `OWNER_DECISION:` or `OWNER_DECISION_DEFERRED:`).

---

## File line counts (target vs actual)

Approximate line counts (will vary slightly with editor):

- `README.md`: ~220 lines (target ~220).
- `doctrine-decision-rfc.md`: ~1100 lines (target 1000-1200).
- `channel-and-thread-spec.md`: ~1500 lines (target 1400-1600).
- `voice-notes-spec.md`: ~1000 lines (target 900-1100).
- `moderation-and-safety.md`: ~900 lines (target 850-1000).
- `integration-with-discord.md`: ~900 lines (target 800-1000).
- `PERP_HANDOFF.md`: ~200 lines (target ~200).

Total: ~5800 lines of dense spec. (Target: 4500-5500.)

---

## Final note to the owner

You said this is the highest-stakes question across the parity set.
The RFC is written to make the choice as clean as possible. The
recommendation (Option B) is the option that satisfies the doctrine,
delivers credible community, and preserves reversibility in both
directions. Any of A or C is defensible if your read of the doctrine
is different. The cost of waiting on the decision is one wave; the
cost of getting it wrong on the first ship is multi-month.

---

## Author's posture on the recommendation

The Wave 10 spec author stands behind Option B as written. The
recommendation is not "B because it's the safe middle"; the
recommendation is "B because the asymmetric reversibility matrix
favours it under every plausible doctrine update".

The author's confidence per option:

- A: defensible with a concurrent re-statement of the doctrine. If
  the owner ships A, the public-facing doctrine should be amended at
  the same time, with a clear note that public reaction surfaces are
  permitted because they are real signal not manufactured. This
  protects credibility.
- B: high confidence as a recommendation. The acknowledgement-tick
  read is the author's read; the owner may disagree, in which case
  drop the tick and ship "B-minus" (B without the reaction surface,
  which is essentially C with directory + voice).
- C: defensible if the doctrine read is strict. Lower retention
  upside; cleaner brand. The federation bridge mitigates the
  Discord-defection risk.

If the author had to pick one outcome unilaterally: **B**.

If the author had to pick a fallback: **B-minus** (B without the
acknowledgement tick), which is structurally close to C but retains
voice notes and the directory.

The author would not unilaterally pick A. The doctrine collision is
real and the brand cost is too high.

---

## Closing checklist for the next reviewer

- [ ] Read the RFC. Internalise the A/B/C trade space.
- [ ] Pick a recommended option (or accept B).
- [ ] Walk through the appendices in the RFC; surface any objections.
- [ ] Have the founder formally sign off on Decision 1 in writing.
- [ ] Update each `OWNER_DECISION:` block in the spec from `OPEN` to
      `RESOLVED` once decided.
- [ ] Convert the PR from draft to ready-for-review.
- [ ] Tee up the implementation PR sequence per the Day-1 order in
      `channel-and-thread-spec.md`.
- [ ] Notify the mobile-mirror agent that the spec is final.
