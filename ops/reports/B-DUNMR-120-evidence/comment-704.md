RESTACK (B-DUNMR-120, agent 120) — growth-project-backend#704 @ 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20

This is a merge-only restack onto D2a #688 `21714f7b` (FIX ROUND 5: the C-680-18 guard). The D2b diff itself is unchanged.

**Size:** 694 changed lines (615+/79-), the same as before. It is under 1,500.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none (restack) | merged #688 `21714f7b` into D2b; no conflicts. The tree `22eaee66` equals `git merge-tree --write-tree 32d886bb 21714f7b`. | `49d0b66e` | PR build-and-test [37343434559](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343434559) green at this head (includes `test/dunning-v2-c680-18.spec.ts`, `test/dunning-v2-service-fixes.spec.ts`) |

The previous D2b head `32d886bb` was also confirmed merge-only: its tree equals a fresh merge-tree of its parents. D2b's own `applyImmediateClear` cases in `test/dunning-v2-service-fixes.spec.ts` pass unchanged with the guard (CI green).

**Probe replay (both lenses):** CI lane [37344949765](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344949765) at this head: 70 passed, 2 failed (both expected, see below).

| Probe (lens) | Result |
|---|---|
| Opus 116 aud-opus-d12-688-lost-dispute | pass |
| Opus 118 aud-opus-d12-118-688 parts 1-4 | pass |
| Sol 116 aud-sol-d12-116-d2 | pass |
| Sol 118 688-probe, 688-probe-v2 | pass |
| D1 probes (Opus 118 687, Sol 116 d1, Sol 118 687 adapted) | pass |
| Opus R34D-119 C-680-18 (7 cases) + 13 controls; lock variant (B-DUNMR-120) + control | pass |
| Opus R34D-119 C-680-19 and its pause variant | expected red before D2c: closed in #705 |

**Money self-check:** no behaviour change in D2b this round.
- Webhook order/redelivery: as audited (v1 `recordResolution` refuses the dispute marker).
- Concurrency/lock order: unchanged; the guard's lock order is described on #688.
- Terminal states (refunded/disputed/canceled/deleted): covered by #688's guard, inherited unchanged.
- Pagination fail-closed: unchanged.
- Currency/minor units/zero-decimal: unchanged.
- Copy truth: unchanged.

**Required checks at this head:** all green (11 checks; deploy-readiness-gate is skipped by design).

READY FOR AUDIT
