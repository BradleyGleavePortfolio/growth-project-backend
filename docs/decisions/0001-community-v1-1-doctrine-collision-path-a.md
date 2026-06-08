# ADR 0001 — Community v1-1: Doctrine Collision Resolved via Internal Rename (Path A)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision owner:** Bradley Gleave (repo owner)
- **Implementation PR:** #365 — `community: v1-1 schema workspace cohorts` (merged at `7e851d8a`)
- **Process amendments:** R66, R67, R68, R69, R70 (this PR)

## Context

Pull request #365 introduced 11 new Prisma models for the Community
v1-1 schema (workspaces, cohorts, partitioned messages, RLS, etc.).
One of the new models was `CommunityReaction`, representing the
internal join table behind the per-message emoji-response UX.

The repo has carried a doctrine guard since PR #90 (2026-04-29):
`test/doctrine-cleanup.spec.ts` rejects any Prisma model name
matching the case-sensitive tokens `Badge`, `Streak`, or `Reaction`,
and any column name matching `streak_*` or `badge_*`. The doctrine
exists because earlier product directions (gamification-heavy
mechanics) were explicitly retired in favor of an "ack-without-receipts"
community model, and stray naming was creating UX pressure to
re-introduce points-and-streaks language.

The v1-1 builder did not know about the guard. PR #365 went red on
CI immediately. The R1 auditor's sandbox died mid-audit (R61 was
not yet enforced via persisted dispatch state). PR sat red for
**5 days** before a new operator took it up.

## Decision

**Path A:** Rename the internal model and its associated artifacts
to remove the banned token. Keep the user-facing UX identical.

| From                                       | To                                          |
| ------------------------------------------ | ------------------------------------------- |
| `model CommunityReaction`                  | `model CommunityResponse`                   |
| `enum CommunityReactionTargetType`         | `enum CommunityResponseTargetType`          |
| Column `reaction String @db.VarChar(32)`   | Column `response_kind String @db.VarChar(32)` |
| `@relation("CommunityReactionUser")`       | `@relation("CommunityResponseUser")`        |
| `@@map("community_reactions")`             | `@@map("community_responses")`              |
| Migration table `community_reactions`      | Migration table `community_responses`       |

Lowercase `'reaction'` survives only as one enum value in
`CommunityModerationTargetType` (representing the moderation target
type for a response row, not the data model). It does not match
the case-sensitive doctrine guard.

The owner explicitly approved Path A with the question: *"this is
literally renaming a feature that no users will see?"* Answer: yes.
API routes, request/response shapes, and mobile UX are unchanged.
The emoji-response UX is preserved end-to-end. Emoji byte-fidelity
is now under a permanent regression test
(`test/community/rls/community-v1-emoji-roundtrip.spec.ts`) covering
👍, 🔥, family ZWJ 👨‍👩‍👧‍👦 (25-byte grapheme cluster), and ❤️
with variation selector (6 bytes / 2 codepoints).

## Alternatives considered

**Path B — Weaken the doctrine guard.** Add `CommunityReaction` to
an allowlist exception. Rejected because: (a) doctrine guards exist
precisely to resist case-by-case weakening, (b) the `Reaction` token
in any model name re-opens UX pressure toward gamified language even
if THIS use is benign, (c) future schema authors would cite this
allowlist entry as precedent for further exceptions. Owner's view:
"once you allow one exception, the next ten are debates."

**Path C — Rename the doctrine guard scope.** Make the guard
case-sensitive only on column prefixes (`streak_`, `badge_`,
`reaction_`) and lift the model-name ban. Rejected for the same
reason as Path B; model names are read more often than column
names and shape the mental model of the system.

## Consequences

### Positive

- Doctrine guard remains strict and signal-rich.
- No public-API or UX change. Mobile client unchanged.
- New emoji byte-fidelity regression test catches any future
  migration that silently drops grapheme clusters or variation
  selectors.
- Forced codification of R66–R70 (this PR) — five durable
  process improvements that close the gaps the 5-day red PR
  exposed.

### Negative / cost

- 40 lines of rename across 5 files in the v1-1 schema + migration.
- Two audit rounds (R2 + R3) before CLEAN, plus the original R1.
- Operators reading the migration history need this ADR to know
  why the table is `community_responses` despite the product
  surface being "reactions".

### Neutral but worth recording

- The R2 fixer also repaired a corrupted `prisma` CLI WASM in the
  shared `node_modules` (truncated to 679KB vs canonical 2.97MB),
  which had been silently breaking 2 base-SHA tests independent of
  the rename. Repair was a byte-identical restore from sibling
  worktree, not a fresh `npm install` (golden-modules invariant
  preserved).

## Carried-forward learnings (codified as R66–R70 in this PR)

1. **R66 — Full-Suite-Before-PR.** The v1-1 builder ran targeted
   subsets and missed the doctrine guard. Full `npx jest --runInBand`
   is now mandatory before any push.

2. **R67 — Dispatch-State-Persisted.** The R1 auditor's death
   stranded PR #365 for 5 days because nobody could resume from
   shared state. Dispatches now write `handoffs/dispatch.json`
   in `tgp-agent-context` before waiting.

3. **R68 — Doctrine-Decision-Of-Record.** Every doctrine change
   needs a merged ADR like this one. No verbal/Slack/journal-only
   doctrine changes.

4. **R69 — Skipped-Tests-Are-Red.** The R2 audit caught the
   emoji spec failing CI because its `describe` block lacked
   the sibling `liveDbUrl() ? describe : describe.skip` pattern.
   Any skip without a `SKIP-BECAUSE:` annotation is now rejected.

5. **R70 — Fail-Fast Pre-Push Lane.** Running
   `npx jest test/doctrine-cleanup.spec.ts test/invariants/locked_defaults.spec.ts test/diagnostic-prompt-doctrine.spec.ts`
   completes in <30s and would have caught the original `Reaction`
   token collision in 6 seconds. This is now the mandatory first
   gate. Canonical guard index lives in `docs/REPO_DOCTRINE_GUARDS.md`.

## Acceptance criteria (all met before this ADR was merged)

- [x] PR #365 merged at `7e851d8a` (squash on `main`).
- [x] `prisma/schema.prisma` contains zero matches for `Reaction`,
      `Streak`, `Badge`, `streak_`, `badge_` (case-sensitive).
- [x] Emoji regression test passes on live Postgres (7/7) and
      skips cleanly when `COMMUNITY_TEST_DATABASE_URL` is unset.
- [x] Full Jest suite green: 4219/4219 passing, idempotent
      across two consecutive runs.
- [x] Two independent GPT-5.5 audit rounds (R2 DIRTY → R3 CLEAN)
      with full reports archived at
      `/home/user/workspace/COMMUNITY_V1-1_R2_AUDIT_REPORT.md`
      and `/home/user/workspace/COMMUNITY_V1-1_R3_AUDIT_REPORT.md`.
- [x] R64 closeout journal entry in
      `tgp-agent-context/COMMUNITY_BUILD_JOURNAL.md` at
      commit `aade631`.
