## Tier header

**Tier:** T4. This is stacked piece B of 3 of the #651 split. It is inert on its own.
**Why:** It is the safety router that decides the 911/988 routes, plus the post-check that stops unsafe nutrition, medical and medication replies. It also changes the audit service's read path for one action (OR-115-1).
**T4 trigger scan:** crisis routing and health safety copy: yes. Audit read path (`AuditService.list` redacts `roman.safety_route` metadata): yes. Auth, RLS, migrations, payments and production config: none.
**T3 trigger scan:** new client-facing copy only in deterministic templates (docs/roman-safety-copy.md).
**Bounded T1:** docs/roman-safety-copy.md.
**Builder-owner:** B-SCHED-ROMAN (agent 115, Claude Opus 5.5 builder). Code is carried from #651. Not self-audited.
**Acceptance evidence:** described below. The failing-before run on `ci/B-SCHED-ROMAN-B-before` is red at the tests-only commit `7b89caa9`, and PR CI is green at the head.
**Promotion triggers:** none. Nothing calls the router or the post-check until piece C. No `roman.safety_route` rows exist until C writes them.

## What this is

This is stacked piece **B** (guardrails), split from #651 on the operator's ruling (11:08 PDT). It is based on **piece A** (#665, `agent115/roman-split-a-context`). Review only the three commits below; GitHub shows only this piece's diff because the base is A's branch.

1. `326aa226`: carries `src/roman/guardrails/*`, docs/roman-safety-copy.md and the pure router/post-check tests verbatim from #651 @ `a8fa651c`. Prompt assembly and live-turn wiring tests move to piece C.
2. `7b89caa9`: tests only. They fail before the fix.
3. `07429136`: the round-2 fixes for this piece's findings, plus OR-115-1 and OR-115-2.

**Inert:** no caller until C. The audit list change affects only the `roman.safety_route` action, which no code writes before C.

**Size:** 1,735 changed lines, 1,022 of them non-test source plus docs. That is above the OR-115-6 guide, so I am asking for an operator SIZE ASSESSMENT. The router and the post-check are the unit the lenses reviewed together.

**Checks on a stacked base:** ci.yml runs on this PR. CodeQL, danger and Banned cast tokens run only for base `main`, so they run when this PR is retargeted after A merges. Locally, r75 range against main reports no positive token change.

## Fix round (this piece's findings)

| Finding | Change | Commit | Failing-before test (`test/roman/roman-guardrails-round2.spec.ts`) |
|---|---|---|---|
| B-651-2 | Emergency now needs acute context for stroke ("having a stroke", "is this a stroke", FAST signs), fainting (now/just/third person) and allergic reactions (acute or airway). Rowing and swim strokes stay normal. A past fainting episode, a stroke history or an allergy goes to medical scope with the physician line. | `07429136` | Sol's 3 rowing/swim probes, breaststroke, and past fainting are not emergency; past fainting is medical_scope; 5 acute positives are still emergency. |
| B-651-3 | `treat`/`dose` count only with medical objects or medication. Starvation ignores negated mentions. | `07429136` | Sol's 4 probes are unchanged; ibuprofen, cortisone and "Starve yourself" are still removed. |
| B-651-6 | Clause-start intake imperatives ("Eat/Have/Consume ... <n>") are directives. Every positive daily value below the floor is replaced. Predicates use NFKC-normalised text, so full-width digits count. | `07429136` | "Aim for 300 kcal per day", "Eat 900 kcal per day" and "Aim for ９００ kcal per day" are replaced; the 300 kcal snack control is unchanged. |
| B-651-7 | Target statements are checked against the target only. Quoted facts are matched only within their own field family (remaining / logged / average / burned / target). | `07429136` | A target equal to the remaining, logged, average or remaining-protein value is corrected; 4 true-fact controls are unchanged. |
| B-651-8 | The medical/injury safe action and the exact physician line are enforced on the final composed reply, after any earlier rewrite. | `07429136` | Sol probe (injury + "Eat only 900 calories a day.") keeps stop + physician line; ibuprofen + injury and false target + medical keep the line. |
| B-651-9 | Every exclamation form (`!`, `！`, `‼`, `⁉` and others) becomes a full stop, even when the old per-session allowance is passed. Marks are scrubbed before emoji removal so the sentence keeps its full stop. | `07429136` | Allowance granted gives zero marks; full-width and double marks are scrubbed; `roman-guardrails.spec.ts` voice-scrub expectation updated. |
| C-651-5 / OR-115-1 | `AuditAction.ROMAN_SAFETY_ROUTE = 'roman.safety_route'` (neutral), `ROMAN_SAFETY_ROUTE_REASON` (closed `call_911` / `call_988`), `RESTRICTED_METADATA_ACTIONS`. `AuditService.list` never returns that action's metadata. #608's manifest already nulls `AuditLog.metadata` for the actor. Piece C writes the row and removes the router class and guardrail names from the ledger and logs. | `07429136` | The owner list returns `metadata: null` for `roman.safety_route` and keeps it for other actions. |
| FR1-651-7 / OR-115-2 (keep) | Kept as ruled: the crisis templates answer without box-2 consent and nothing reaches the provider. Documented on `ROMAN_SAFETY_ROUTE_REASON`, with the end-to-end test in C. | `07429136` | n/a (keep ruling) |

### #651 finding -> stacked PR (operator split 11:08 PDT, owner PR-size doctrine)

Every open Opus (5964857917) and Sol (5964898255) finding from #651 @ `a8fa651c` maps to exactly one piece. Each is fixed there, with a failing-before test.

| Finding | Lens | What | Piece |
|---|---|---|---|
| B-651-1 | Opus + Sol | unknown provider usage settled as zero | **C** (live turns) |
| B-651-2 | Opus + Sol | rowing/swim "stroke" and past fainting routed to 911 | **B** (guardrails) |
| B-651-3 | Opus + Sol | treat / dose / negated starvation rewritten | **B** |
| B-651-4 (was C-651-6) | Sol (Opus C) | fixed reservation not an upper bound of the payload | **C** |
| B-651-5 | Sol | spend admission not atomic | **C** |
| B-651-6 | Sol | below-floor daily directive ("Eat 900 kcal per day", full-width digits) ships | **B** |
| B-651-7 | Sol | remaining/logged value validates a false target | **B** |
| B-651-8 | Sol | earlier rewrite skips medical/injury enforcement | **B** |
| B-651-9 | Sol | one exclamation per session still ships | **B** (post-check: zero marks; C drops the dead allowance wiring and prompt text) |
| B-651-10 | Sol | context route returns generic 500 | **A** (context) |
| C-651-4 | Opus + Sol | memo / generation maps never evicted | **A** |
| C-651-5 -> OR-115-1 | Opus + Sol | crisis words in audit action, ledger, logs | **B** (neutral `roman.safety_route` action + closed reason code + restricted read; C writes it from the turn path and drops router class/guardrail names from the ledger and logs) |
| C-651-7 | Opus + Sol | stale "CoachingSession is never read" comment | **A** |
| FR1-651-7 -> OR-115-2 | operator | keep: crisis 911/988 templates answer without box-2 consent; nothing reaches the provider | **B** (rule and templates), tested end to end in **C** |


## Checks
- r75: range vs main, no positive token change.
- eslint: changed files have 0 errors.
- Copy: templates have no exclamation marks, no "we/us/our" and no emoji (existing tests).
- Logs: none added.

