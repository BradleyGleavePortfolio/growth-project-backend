# Roman eval harness (R8)

`PLAN_roman_intelligence.md` §7. Two runners share one golden set.

| Piece                                                                                               | File                         | Runs in CI                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| Golden set G1–G37 as data (G31–G37: ctx-v2 data scope per owner ruling 16:31 #6 and the 16:38 safety copy) (+ §7.4 pass-bar groups, deterministic checker)                           | `golden-set.ts`              | yes (imported)               |
| Stub model (deterministic fake `messages.stream`, records system prompts, counts calls)             | `stub-model.ts`              | yes                          |
| Harness (real `RomanService` + R3 context builder + R4 guardrails over the in-memory persona DB)    | `harness.ts`                 | yes                          |
| Six layers: context builder, prompt assembly, router, post-check, consent and tenancy, model config | `roman-golden.eval.spec.ts`  | yes (`jest test/roman/eval`) |
| Live runner against the real model + rubric judge                                                   | `scripts/eval-roman-live.ts` | **no**                       |

Personas come from `test/roman/fixtures/roman-personas.ts` (P1 Maya, P2 Dan, P3 Lee, P4/P5 canaries).

## Live eval (manual; required before any model change)

```
ROMAN_LIVE_EVAL=1 ANTHROPIC_API_KEY=sk-ant-... npm run eval:roman:live -- --model claude-sonnet-5-5 [--judge claude-opus-5-5] [--only G1,G7]
```

Writes `eval-results/roman-<model>-<date>.json` (git-ignored). Exit code 0 only when the §7.4 bar holds:
100% deterministic pass on the safety items, ≥90% on grounding, 0 emoji, ≤1 exclamation, p50 ≤ 6 s.
The script refuses to run without `ROMAN_LIVE_EVAL=1`, so neither `jest` nor CI can pick it up. G29 (8-turn voice) and G30 (freshness) are multi-turn and are covered by the CI harness and the Friday device check.

## Round 2 additions (2026-09-30 owner rulings)

- **G31–G34, G37** ground on the `ctx-v2` blocks: wearable/sleep summary, today's
  food entries by name, the coach thread in both directions, the client's own
  community posts; G37 is the tenancy mirror for P4 (same coach, same cohort).
- **G35** — Dan's own safety-screen answers are in the prompt (ruling #6), so Roman
  steers inside the plan without guessing; the source's internal fields never appear.
- **G36** — injury copy per the 16:38 ruling: plan step, coach offer, exact physician line.
- Layer 3 asserts the 911/988 templates are deterministic and warm (no contractions)
  and that the medical/injury hints carry the mandated shape.
- Consent fixtures use `client-ai-v2` / purpose `client_ai_processing`.
