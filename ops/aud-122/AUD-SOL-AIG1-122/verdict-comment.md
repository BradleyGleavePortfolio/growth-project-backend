AUDIT GPT-6.1 Sol — growth-project-backend#736 @ f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/3

AUD-SOL-AIG1-122, agent 122 — independent T4 safety review; no other lens's work read.

### B-736-1 — Named-medicine overdose still gets the quota/consent refusal

**Normal-user story:** A client who used today's AI allowance types “I took a whole bottle of Tylenol” and gets the daily-limit error instead of the emergency 911 reply. [Overdose patterns](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L55-L58) [Quota refusal](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.service.ts#L687-L705)

`src/ai/ai-crisis-router.ts:56–58` requires a generic noun such as `pills` after the optional word, so medicine names alone do not match; the standalone exact-source probe returned `null` for “I took a whole bottle of Tylenol,” “I swallowed a whole bottle of ibuprofen,” and “I took 20 Tylenol,” and actual `AiService.chat` returned 429 at cap or 403 without consent for the first phrase. [Patterns](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L55-L58) [Chat ordering](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.service.ts#L391-L417)

**Minimal fix:** Recognize ordinary named medicines in bottle/handful/excess-count overdose statements before consent/quota, retaining the non-crisis result for “I took 2 Tylenol for my headache”; add a service-level regression that fails at this head.

### B-736-2 — Ordinary “overdose on cardio” training talk falsely gets 911

**Normal-user story:** A client asking about “overdose on cardio” gets “call 911 now” and instructions to unlock the door instead of the normal training answer. [Unqualified keyword](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L53-L54) [Fixed emergency reply](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L116-L120)

`src/ai/ai-crisis-router.ts:54` matches every `overdose` occurrence without excluding the explicitly assigned fitness figure of speech; the exact-source probe classified both “overdose on cardio” and “I think I overdose on cardio. How much should I do each week?” as `emergency`, and actual `AiService.chat` skipped the model and returned the 911 reply. [Keyword and dispatch](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L53-L58) [Early return](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.service.ts#L391-L400)

**Minimal fix:** Exclude ordinary exercise metaphors without suppressing genuine medication/substance emergencies, and prove this phrase uses the normal answer under cap and the existing 429 at cap.

### Evidence / passing behavior

The standalone read-only Node probe loads the exact router and `AiService` source in memory, with dependency doubles; it is not a Jest, TypeScript-check, or full-suite run, and was executed through `ops/heavy.sh` without any push.

```text
classify("I took a whole bottle of Tylenol") -> null
chat(at cap, that message) -> 429 AI_DAILY_QUOTA_EXCEEDED
chat(no consent, that message) -> 403 ai_consent_required
classify("overdose on cardio") -> emergency
chat(under cap, "overdose on cardio") -> safety, "call 911 now", model calls 0
```

Recognized self-harm and generic-pill overdose controls return the correct fixed safety replies at cap, before context/consent/quota/model, with zero audit/analytics calls and unchanged quota; “kill this workout” uses the normal model path, and “I'm dying after leg day” still gets 429 at cap. [Service early return](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.service.ts#L386-L401) [Router and replies](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L103-L127)

PR size is 213 changed lines, below 1,500, and PR CI is successful with deploy-readiness-gate skipped; the builder's targeted lane is also successful, but does not cover these two failures. [PR #736](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736) [PR CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393614776) [Builder targeted lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393636969)

Local probe and transcript: `ops/aud-122/AUD-SOL-AIG1-122/crisis-probe.cjs`, `ops/aud-122/AUD-SOL-AIG1-122/crisis-probe-output.json`.

### C — follow-ups only

- C-736-1: Existing 20/hour controller throttle remains outside this diff — C (edge, deferred to 10k clients). [Controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai.controller.ts#L19-L22)
- C-736-2: Share the two pattern lists after Roman merges; not a gate for this focused fix. [Router note](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5/src/ai/ai-crisis-router.ts#L11-L14)
- C-736-3: Daily allowance size is unchanged and remains a separate operator follow-up. [Builder scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006627739)
