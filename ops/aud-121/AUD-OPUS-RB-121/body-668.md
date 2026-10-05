Split piece C1 of #651 (owner PR size rule; MODEL_ROUTING.md 8.2). Base: #666 (B). Stack: #667 (A1) -> #665 (A2) -> #666 (B) -> **C1** -> C2 -> C3.

Contents: `roman.service`, `roman.controller`, `roman.module`, `roman.prompts`, `roman.constants`, `anthropic-client.provider`, the env-validation and `.env.example` hunks, the dunning route-table spec line, and the launch-hardening, guardrails-wiring, client-context-injection, streaming, SSE, controller and service specs. 2,160 changed lines.

This is the first piece that changes a live Roman turn (Roman stays behind its feature guard). Carried verbatim from #651 @ a8fa651c via c67eecf8 (the eval harness moved to C3). Known open findings on this code: B-651-1, B-651-4, B-651-5, the turn-path application of OR-115-1/OR-115-2 and B-651-9; their failing-before tests and fix are C2. C1 and C2 merge back to back. `tsc --noEmit` passes locally. Needs fresh Opus 5.5 and Sol audits at its exact head.

