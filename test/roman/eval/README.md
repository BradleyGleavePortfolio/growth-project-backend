# Roman eval harness (R8)

`PLAN_roman_intelligence.md` §7. Two runners share one golden set.

| Piece                                                                                               | File                         | Runs in CI                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| Golden set G1–G30 as data (+ §7.4 pass-bar groups, deterministic checker)                           | `golden-set.ts`              | yes (imported)               |
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
