# AUD-SOL-L1-125 — exact-head L1 handoff

## Scope
22 queue PRs accounted for: 21 new verdict comments, one existing exact-head Sol approval skipped.
No other lens's current-head verdict was read. No code push, merge, deployment, local build/test, or production/provider action.

## Results

| PR | Exact audited head | Verdict | B | Verdict receipt |
|---|---|---|---:|---|
| b#776 | `d0303aa57090cf72c16a3455b6fc0281057f04b3` | REQUEST CHANGES | 1 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/776#issuecomment-6025292807) |
| b#779 | `5acc19e74707889449bce70e627a5bcfcd5ae8ee` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/779#issuecomment-6025302398) |
| b#778 | `52fbaaebea99673750e1226e90c89e9ebacadc58` | REQUEST CHANGES | 1 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/778#issuecomment-6025315964) |
| m#410 | `c1dfc699ce1a12d616fb5b99371bf89ce819221e` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/410#issuecomment-6025323904) |
| m#402 | `6d66ea2bb19de2d4826ac454fae56521c8f70cca` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/402#issuecomment-6025329309) |
| m#405 | `32e0c20ddd7d0fba981d1ddf64836d3fff8612fe` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/405#issuecomment-6025337756) |
| m#407 | `50386085b2e99a0f625e5e47ba370cdbab780e37` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/407#issuecomment-6025353137) |
| m#412 | `234a7e1a2505fd23a8ff8fff714636d3b47a3de5` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/412#issuecomment-6025362163) |
| b#780 | `59c01e0ec3282860c3b1582e27a6e421d5eb89be` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/780#issuecomment-6025375218) |
| m#404 | `0930dfeb93f7b6f805fd1373b3a199a6c9755d5c` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/404#issuecomment-6025387807) |
| m#406 | `9a334d122c4515c6d38f2d207fab3b9904a63f06` | APPROVE (existing) | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/406#issuecomment-6024663006) |
| b#785 | `f64275e42c27bc703ac73d3c4f5357163378bc01` | REQUEST CHANGES | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/785#issuecomment-6025407030) |
| m#413 | `bbb969dd85ebc988e93ab4aedbba195f2e2cc6fa` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/413#issuecomment-6025418422) |
| b#783 | `dd4dc8acf64b24263a3362382ee099f89b8dee56` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/783#issuecomment-6025424447) |
| m#409 | `e1239b1129841a51519450163463959fc8d0154f` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/409#issuecomment-6025439895) |
| b#782 | `80eab1c8c79ab23cd4fd9bf4122c19f2004ad6fa` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/782#issuecomment-6025449521) |
| b#777 | `bb7eae0965786ee428131557d9560f58d26bf892` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/777#issuecomment-6025460270) |
| m#408 | `92e1ff635f580cf462f7d557a4fe8f801553676c` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/408#issuecomment-6025470836) |
| m#414 | `16aca39fd1befa6d6514fca3525a0d29341ad98c` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/414#issuecomment-6025477608) |
| m#415 | `e0dbbb006ddfc1755e11305fbf5f0d68d6b59e0a` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/415#issuecomment-6025486188) |
| b#781 | `6d0e1623cd2e04fd6e53a3380339e67caf92fe37` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/781#issuecomment-6025498960) |
| b#784 | `ac39c7d2706f7d4e547e27e1a3da2f69a54f9619` | APPROVE | 0 | [Exact-head comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/784#issuecomment-6025499516) |

## B list
- **B-776-1:** A coach fully refunds a recurring plan and then tries to restart billing, but launch production has FEATURE_DUNNING_V2 off, so the new refund pause ends access while the restart returns flag_off. Smallest fix: permit owning-coach refund restart/read-model visibility independently of nonpayment rollout; alternative is an explicit owner-approved activation prerequisite. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/776#issuecomment-6025292807).
- **B-778-1:** A coach edits cadence/price while an existing recurring contract is disputed/refunded, and the active/trialing/past_due-only predicate allows it although Stripe retains the old contract; app cadence and later billing then differ. Smallest fix: reuse a genuine live-contract predicate in pricing enforcement and pricing_locked. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/778#issuecomment-6025315964).

## CI blockers (A=2, B=0 on b#785)
- build-and-test: unchanged expected signup/login limits and exact public route inventory fail after the changed contract. [Failed job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37525742910/job/112482163738).
- R75: new casts (+1 as any, +2 as unknown as, +6 as never). [Failed job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37525742609/job/112482162777).

## U list
None found in reviewed deltas.

## C one-liners
b#781: C (edge, deferred to 10k clients): unusual calendar/device-clock behavior; not investigated.

## Covered by existing verdicts / dependencies
- m#406 current exact-head Sol approval already existed; no duplicate was posted. [Existing verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/406#issuecomment-6024663006).
- m#405 and m#407 mobile-slice approvals do not close their backend companion findings on b#776 and b#778.
- m#404 advanced from the originally listed ab6d426b to 0930dfeb before this review; reviewed the new deduplication delta and posted at 0930dfeb. Its checks were running at verdict time and are now green. [Current-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530806852/job/112499384946).

## PRs opened
None.

## Not fixed (needs operator)
B-776-1, B-778-1, and the two b#785 PR-caused CI failures are left for the authorized builders/operator.

## Live head verification at handoff
- b#776: head unchanged; live `d0303aa57090cf72c16a3455b6fc0281057f04b3`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/776).
- b#779: head unchanged; live `5acc19e74707889449bce70e627a5bcfcd5ae8ee`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/779).
- b#778: head unchanged; live `52fbaaebea99673750e1226e90c89e9ebacadc58`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/778).
- m#410: head unchanged; live `c1dfc699ce1a12d616fb5b99371bf89ce819221e`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/410).
- m#402: head unchanged; live `6d66ea2bb19de2d4826ac454fae56521c8f70cca`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/402).
- m#405: head unchanged; live `32e0c20ddd7d0fba981d1ddf64836d3fff8612fe`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/405).
- m#407: head unchanged; live `50386085b2e99a0f625e5e47ba370cdbab780e37`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/407).
- m#412: head unchanged; live `234a7e1a2505fd23a8ff8fff714636d3b47a3de5`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/412).
- b#780: head unchanged; live `59c01e0ec3282860c3b1582e27a6e421d5eb89be`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/780).
- m#404: head unchanged; live `0930dfeb93f7b6f805fd1373b3a199a6c9755d5c`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/404).
- m#406: head unchanged; live `9a334d122c4515c6d38f2d207fab3b9904a63f06`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/406).
- b#785: head unchanged; live `f64275e42c27bc703ac73d3c4f5357163378bc01`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/785).
- m#413: head unchanged; live `bbb969dd85ebc988e93ab4aedbba195f2e2cc6fa`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/413).
- b#783: head unchanged; live `dd4dc8acf64b24263a3362382ee099f89b8dee56`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/783).
- m#409: head unchanged; live `e1239b1129841a51519450163463959fc8d0154f`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/409).
- b#782: head unchanged; live `80eab1c8c79ab23cd4fd9bf4122c19f2004ad6fa`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/782).
- b#777: head unchanged; live `bb7eae0965786ee428131557d9560f58d26bf892`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/777).
- m#408: head unchanged; live `92e1ff635f580cf462f7d557a4fe8f801553676c`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/408).
- m#414: head unchanged; live `16aca39fd1befa6d6514fca3525a0d29341ad98c`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/414).
- m#415: head unchanged; live `e0dbbb006ddfc1755e11305fbf5f0d68d6b59e0a`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/415).
- b#781: head unchanged; live `6d0e1623cd2e04fd6e53a3380339e67caf92fe37`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/781).
- b#784: head unchanged; live `ac39c7d2706f7d4e547e27e1a3da2f69a54f9619`, state `open`, merged `False`. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/784).

## HANDOFF
All queue work is saved under ops/aud-125/AUD-SOL-L1-125/: per-PR .json evidence, .md verdicts and -receipt.json posting receipts; aggregate results JSON is authoritative for audited heads.
Notifications: ops/lanes125/notify/AUD-SOL-L1-125.txt.
Operator action: route the two Bs and b#785 CI repair; retain exact-head dual-lens/required-check gates. No user decision beyond the already held dunning activation alternative was assumed.

## L2 continuation
Operator assigned live L2 queue and FIX-Q1 delta polling after L1 completion. The follow-on report is `ops/reports/AUD-SOL-L2-125.md`, with exact-head receipts aggregated in `ops/aud-125/AUD-SOL-L1-125/AUD-SOL-L2-125-results.json`. The corrected launch profile is clinic for both iOS and Android. Original L1 evidence remains intact.
