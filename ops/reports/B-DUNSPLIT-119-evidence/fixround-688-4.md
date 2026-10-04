FIX ROUND 4 (B-DUNSPLIT-119, agent 119) — growth-project-backend#688 @ f29fc201b43a93b3a2f2e431b76b545110bff015

**Size:** 2,440 changed lines (1,905+/535-), `gh pr view 688 --json additions,deletions` before push. Grandfathered; under 3,000.

**Commits this round**
- `3d2fe48b`/`9506bc95`/merge of `c260a849` (merge-only): D1 into D2a.
- `f29fc201` test(privacy): the D2a service prints no exception text; the #700 guard's exact-match list drops its count.
- `999557c7` split: #688 keeps D2a = `src/checkout/dunning-v2/dunning-v2.service.ts` + `test/dunning-v2-service.spec.ts`, byte-identical to the audited `2368d5fa`. `src/checkout/dunning.service.ts`, `src/common/env-validation.ts`, `test/dunning-v2-service-fixes.spec.ts` (and the D1 fixtures) move to D2b #704 byte-identical. The R-DISPUTE-PAUSE build is D2c #705.

**Seams:** file-level only (an intra-file cut would leave unaudited intermediate code). D1 #687 2,822 / D2a #688 2,440 / D2b #704 694 / D2c #705 1,287.

**Closed:** JOBS119 split. No lens findings were open at `2368d5fa`.

**Evidence (CI lane):** D2a replay at `9506bc95` (later change: the privacy list only, covered by the PR build-and-test) [37230722879](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230722879), 132 passed, 0 failed (success). Probes:

| Probe | Result |
|---|---|
| Opus 116 aud-opus-d12-688-lost-dispute | pass |
| Sol 116 aud-sol-d12-116-d2 | pass |
| Sol 118 688-probe, 688-probe-v2 | pass |
| Opus 118 aud-opus-d12-118-688 parts 1-4 | pass |
| D1 probes (Sol 118 687 adapted, Opus 118 687, Sol 116 d1) | pass |

Compressed-cycle assertions in these probes still hold on D2a/D2b; they are superseded by R-DISPUTE-PAUSE at D2c (#705 OPENING lists each).

**Money self-check:** no behaviour change in D2a (byte-identical move). Webhook order/redelivery, concurrency, terminal states, list completeness, currency, copy truth: as audited at `2368d5fa`; R-DISPUTE-PAUSE changes are in #705.

**Note:** #689 is based on this branch; its displayed diff includes #704/#705 until B-DUNB-119 retargets it (not touched here).
