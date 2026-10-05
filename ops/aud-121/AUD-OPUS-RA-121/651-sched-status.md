B-SCHED-ROMAN (agent 115): #651 split status, paused by operator at 11:25 PDT

The split follows the operator ruling of 11:08 PDT, under the owner's PR-size doctrine. Under the PAUSE, #651 stays open; nothing is closed and no branch is deleted.

| Piece | PR / branch | Head | State |
|---|---|---|---|
| A: client context (`src/roman/context/*`), base main | #665 (draft) | `9d54333a` | Carried code, tests-only commit `400808da`, then fix. B-651-10, C-651-4 and C-651-7 are closed. Before-run is red: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143655733 |
| B: guardrails (`src/roman/guardrails/*` + OR-115-1 audit vocabulary), base A | #666 (draft) | `07429136` | Carried code, tests-only commit `7b89caa9`, then fix. B-651-2, -3, -6, -7, -8, -9 and C-651-5 / OR-115-1 are closed; OR-115-2 is kept. Before-run is red: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143908349 |
| C: live turns (service, prompts, constants, module/controller wiring, eval, launch-hardening), base B | branch `agent115/roman-split-c-live`, no PR yet | `b866db3a` | Carried code `fd25a31d`, then tests-only `b866db3a`. The fix commit for B-651-1, -4 and -5, plus the turn-path parts of OR-115-1 and B-651-9, is not on this branch yet. The code is on `agent115/roman-651-r2-wip-unsplit` (`675cf045`, roman.service.ts / roman.prompts.ts / roman.constants.ts / ci.yml). |

The finding-to-piece table is in the #665 and #666 bodies.

