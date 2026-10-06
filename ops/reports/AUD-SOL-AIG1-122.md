# AUD-SOL-AIG1-122 — agent 122

AUDIT GPT-6.1 Sol — growth-project-backend#736 @ f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/3

Posted verdict: [Independent Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006699712).

Started 2026-10-05 17:37:10 PDT; posted 17:40:29 PDT, within the 25-minute time box.

## B-736-1 — Named-medicine overdose misses emergency routing

**Normal-user story:** A client who used today's AI allowance types “I took a whole bottle of Tylenol” and gets the daily-limit error instead of the emergency 911 reply. [Overdose patterns](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L55-L58) [Quota refusal](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.service.ts#L687-L705)

At `src/ai/ai-crisis-router.ts:56–58`, the optional word still has to be followed by a generic pill/medication noun, so a brand/generic medicine name alone is not recognized. [Exact-head code](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L55-L58)

The standalone probe returned `null` for “I took a whole bottle of Tylenol,” “I swallowed a whole bottle of ibuprofen,” and “I took 20 Tylenol,” while actual `AiService.chat` returned 429 at cap and 403 without consent for the Tylenol bottle statement. [Posted reproduction](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006699712)

**Minimal fix / verification:** Include common named medicines in overdose quantity/bottle/handful statements, retain the non-crisis result for “I took 2 Tylenol for my headache,” and add a service-level at-cap/no-consent regression that fails at the audited head.

## B-736-2 — Fitness metaphor falsely gets 911

**Normal-user story:** A client asking about “overdose on cardio” gets “call 911 now” and instructions to unlock the door instead of the normal training answer. [Keyword](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L53-L54) [Emergency reply](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L116-L120)

At `src/ai/ai-crisis-router.ts:54`, an unconditional overdose keyword match classifies both “overdose on cardio” and “I think I overdose on cardio. How much should I do each week?” as emergency; the actual chat method returns the 911 template without calling the model. [Exact-head code](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L53-L58) [Posted reproduction](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006699712)

**Minimal fix / verification:** Exclude ordinary exercise metaphors without suppressing genuine substance emergencies, then prove this phrase takes the normal-answer path under cap and the existing 429 path at cap.

## A and C

A: none.

- C-736-1: Existing 20/hour controller throttle is outside this diff — C (edge, deferred to 10k clients). [Controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.controller.ts#L19-L22)
- C-736-2: Share the AI guide/Roman lists after Roman merges; not a gate for this focused fix. [Router note](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L11-L14)
- C-736-3: Daily allowance size remains unchanged and is a separate operator follow-up. [Builder scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006627739)

## Passing behavior and evidence

Recognized self-harm and generic-pill overdose controls receive the fixed safety reply before context/consent/quota/model, with no quota, model, audit or analytics calls; “kill this workout” keeps the normal model path and “I'm dying after leg day” still receives 429 at cap. [Early return](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.service.ts#L386-L401) [Posted probe evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006699712)

Fixed copy uses 988 for self-harm and 911 for an emergency, without first-person statements or exclamation marks. [Fixed text](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L110-L127)

PR size is 213 changed lines, and the head's checks are successful with deploy-readiness-gate skipped; the builder's targeted lane also succeeded. [PR #736](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736) [PR CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393614776) [Builder targeted lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393636969)

The builder lane commit `dfbe199f089e46b23de54add0d25a35a2be64bb1` has identical blobs to the audited head for all three PR files, checked with a scoped git diff; this supports reuse of its targeted test result, not coverage of the newly reproduced failures. [Lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393636969) [Posted audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006699712)

### Saved files

- `ops/aud-122/AUD-SOL-AIG1-122/crisis-probe.cjs` — read-only standalone Node probe loading the exact router and service in memory with dependency doubles.
- `ops/aud-122/AUD-SOL-AIG1-122/crisis-probe-output.json` — classifier and actual `AiService.chat` observations.
- `ops/aud-122/AUD-SOL-AIG1-122/verdict-comment.md` — complete posted payload.
- `ops/aud-122/AUD-SOL-AIG1-122/comment-receipt.json` — GitHub comment receipt.

Executed the probe via `ops/heavy.sh`; no local npm/Jest/tsc/eslint/build, no branch push, merge, production interaction, or paid action.

## HANDOFF

Builder should fix only B-736-1 and B-736-2, with targeted regressions; re-review only those Bs and the delta at the new head. The exact head was verified immediately before posting the single verdict. [Posted audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006699712)

No other lens's notes, report, or comment was read before posting. The clean audit worktree was removed and the claim was moved to `ops/lanes122/notify/backend-736-f2dd87ad-sol-complete` at 17:41:26 PDT; retained evidence is under `ops/aud-122/AUD-SOL-AIG1-122/`.
