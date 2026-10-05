AUDIT GPT-6.1 Sol — growth-project-backend#666 @ 0ec835ca1cc9697bde71e6c67ed627ea3a000691 — VERDICT: REQUEST CHANGES

Job AUD-SOL-RB-121; agent 121. Independent full T4 review. **A/B/C = 0/3/1.**

Read every changed source line and both guardrail specs, the historical parent Sol verdict and the builder's split/fix account; no current-round other-lens evidence was read. No approved-parent evidence is reused: the parent Sol verdict was [REQUEST CHANGES](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964898255).

## Evidence status

All new executable probes were submitted to one [GitHub CI lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365650631), respecting the incident's one-in-flight-run rule. That lane was still queued during review; **the new probe results are not claimed as executed**. The findings below are direct code-reviewed counterexamples, with their corresponding regression assertions prepared in `test/roman/audit-sol-rb121-guardrails.spec.ts`.

At handoff, GitHub accepted cancellation of that unstarted lane under the operator's queue-discipline rule; its audit branch and disposable worktrees were removed, and both probe files are preserved in `/home/user/workspace/ops/aud-121/AUD-SOL-RB-121/` for the fixing builder's failing-before/after runs. No local fallback was used.

The lane is based on #668's exact head plus probe-only commits; an empty `git diff --exit-code 0ec835ca... fabc2268...` was verified for all `src/roman/guardrails/*`, `src/audit/audit.service.ts` and both guardrail specs, so those pure functions and their existing tests are byte-identical to this #666 head. This batches the two assigned PRs without adding a second queued runner.

## B — fix before merge

**B-666-1 — Explicit acute anaphylaxis is not recognized as an emergency.**

`src/roman/guardrails/safety-router.ts:40` uses `\banaphyla\b`: the closing word boundary prevents that truncated token from matching either `anaphylaxis` or `anaphylactic`. “I am having anaphylaxis right now.” and “My friend is having an anaphylactic reaction.” match none of the remaining emergency predicates, so the named acute emergency reaches the ordinary model/consent path rather than the deterministic template. ([Safety router](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Fsafety-router.ts))

Probe: `acute named allergic emergency must short-circuit` (two assertions, queued lane above). Minimal fix: recognize the complete emergency vocabulary with acute framing; retain a historical-allergy negative and the existing airway positive, rather than treating all historical mentions as emergencies.

**B-666-2 — Markdown/bullet formatting bypasses the daily calorie floor.**

`src/roman/guardrails/roman-post-check.ts:105-106,343-345,355-372` requires a digit immediately after a clause-start intake imperative; the fallback skips a calorie number with no semantic family. Therefore “Eat **900 kcal** per day.”, “- Eat 900 kcal per day.” and “Consume **300 kcal** per day.” are not directives and have no number-role family, despite explicitly prescribing a daily intake below the 1,200-kcal context floor. ([Post-check predicates](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Froman-post-check.ts))

Probe: `formatting does not waive a daily floor` (three assertions, queued lane above), with a plain daily directive and a valid snack as controls. Minimal fix: normalize presentation-only Markdown/list syntax for safety predicates, or otherwise bind the daily imperative to its numeric amount independent of that syntax; preserve meal-level suggestions.

**B-666-3 — A negated stop instruction satisfies injury enforcement.**

`src/roman/guardrails/roman-post-check.ts:159,479-488,555-572` accepts any token `stop|pause|skip|...`, without checking polarity or its object. Consequently “Do not stop the movement that hurts; message your coach. If it persists, gets worse, or is severe, please see a physician.” satisfies the stop, coach and exact physician checks and is retained, although it gives the opposite of the mandatory safe action. ([Injury enforcement](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Froman-post-check.ts))

Probe: `a negated stop instruction does not satisfy the injury safe-step requirement` (queued lane above), paired with an affirmative-stop control. Minimal fix: require an affirmative instruction to stop/omit the painful movement, reject its negation and unrelated stop tokens, and use the deterministic injury rewrite when that safe step cannot be established.

## Historical findings

The exact previously cited rowing/swimming negatives, ordinary treat/cardio and negated-starvation examples, plain/Unicode sub-floor directives, wrong-target-equals-remaining examples, prior injury-plus-earlier-rewrite example and zero-exclamation scrub are addressed by the new code and corresponding round-2 assertions; B-666-2/3 identify additional format/polarity gaps rather than claiming those exact old cases are still unfixed. ([Round-2 regressions](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/test%2Froman%2Froman-guardrails-round2.spec.ts))

OR-115-1's neutral action and owner-list metadata redaction exist in this piece; the old class-bearing action still emitted by #668 is a disclosed #669-owned turn-path fix, not a duplicate B on this inert piece. ([Audit redaction](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Faudit%2Faudit.service.ts), [C2 ownership](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669))

## C — follow-up, not part of the freeze fix

**C-666-4:** `docs/roman-safety-copy.md:4` records `roman-client-v2`, but `roman-guardrail.contract.ts:17` defines v3; update the documentation version to match the implemented contract. ([Safety-copy documentation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/docs%2Froman-safety-copy.md), [Versioned contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Froman-guardrail.contract.ts))

## CI / stack boundary

Size is 1,735 changed lines, within this grandfathered PR's 3,000 ceiling. The returned checks at this exact head are successful, apart from the intentionally skipped deployment gate; base-main-only CodeQL/danger/banned-token/SBOM checks still require the operator's normal retarget/main evaluation. ([PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666), [Existing build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148284245/job/111276617914))

No PR branch changed, local test run, merge, deployment, production/flag access or spend by this lens. Keep the stack unactivated until these safety Bs and its separately owned live-turn fixes are cleared.
