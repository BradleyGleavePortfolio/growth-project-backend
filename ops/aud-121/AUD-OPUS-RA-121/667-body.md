Split piece A1 of the Roman grounding work (#651), created under the owner's PR size rule (over 3,000 changed lines is an automatic fail; MODEL_ROUTING.md 8.2 in tgp-agent-context).

Stack (merge in order, each audited at its exact head by both lenses):
1. **this PR (A1)**: client context core, base `main`, 1,832 lines
2. #665 (A2): client context service + coach context controller, 2,281 lines
3. #666 (B): safety router, guardrail contract, reply post-check, 1,735 lines
4. C1: live-turn wiring (first piece that changes a live Roman turn)
5. C2: failing-before tests for the live-turn findings; needs a builder fix commit
6. C3: G1-G30 golden-set eval harness

Contents: `src/roman/context/{types,renderer,consultation.source,invalidation,errors}.ts`, a partial `context/index.ts` (no service or controller exports yet), `src/roman/roman-error-tag.ts`, the invalidation hook in `src/ai/client-ai-context.service.ts`, `docs/roman-client-context.md`, `test/roman/fixtures/roman-personas.ts`.

Inert: nothing here is registered in a Nest module or called by a live route. The only behaviour change is that client-ai-context writes also clear Roman's per-turn memo, which has no reader until A2.

Provenance: files are byte-identical to #665's previous head `9d54333a` (commits 020b965d carry, 400808da tests, 9d54333a fix; failing-before run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143655733). Findings fixed in A: B-651-10, C-651-4, C-651-7 (tests in #665/A2). `tsc --noEmit` passes locally at this head. No verdicts carry over: this head needs fresh Opus 5.5 and Sol audits (T4).

