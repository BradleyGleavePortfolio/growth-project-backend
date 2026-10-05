SUPERSEDED BY SPLIT (B-SPLIT-SCHED-120, agent 120) — growth-project-backend#634 @ e18e8055454b04856d2c5ab5568d0a7127b74939

Owner order 09:45 PDT 10-05: split into pieces under 1,500 changed lines. This PR is superseded by the nine stacked draft PRs below. It stays open; the operator closes it after the pieces land.

| Piece | PR | Head | Lines | Base |
|---|---|---|---|---|
| 1/9 | #712 | `7fd99dce284405f018c545d31cdc1d3d25432f68` | 1359 | `main` |
| 2/9 | #713 | `a7c8b33afbac44f3086036eb59ca617809320411` | 1274 | `agent120/sched-split-1-foundation` |
| 3/9 | #714 | `55dfbdce84b644f2c25826e11040a9ef8b597e0f` | 1382 | `agent120/sched-split-2-test-infra` |
| 4/9 | #715 | `8040f14912b9bca649f0578685cc9056fdc9fd84` | 1355 | `agent120/sched-split-3-emitter` |
| 5/9 | #716 | `31318708e96c29b73ae4d1e9eb64fe34f87f6deb` | 1402 | `agent120/sched-split-4-lifecycle` |
| 6/9 | #717 | `112e0452a473d2ab7226750a80e03043812a9470` | 1068 | `agent120/sched-split-5-reminder-job` |
| 7/9 | #718 | `6feb18bb9b259c662230fb1e79ff3a4cddc290ea` | 1062 | `agent120/sched-split-6-service-api` |
| 8/9 | #719 | `c79c3e67efca90eddcdb89f3a2dc5ff0591ce3b2` | 1148 | `agent120/sched-split-7-integrity-tests-a` |
| 9/9 | #720 | `c2b271936f47ecf1827f7a46607d29add381579f` | 1218 | `agent120/sched-split-8-integrity-tests-b` |

- Content: #634 @ e18e8055 merged with main `ee55f814eb02b530e6578a168dc16c7ea7e2b07b` once (reference merge `6fc88c457b917d74773f881ffed60c9d3f8d9d35`, branch `agent120/sched-split-0-merged-reference`; resolved hunks R1-R7 in each piece body). The 9/9 tree equals that merge: `0595cfd70254cde577bf1cc3a844fa0c179c1d20`.
- No A/B fixes and no behaviour change beyond the main-merge resolution. Every required check that runs on a stacked PR is green on every piece (all 11 on 1/9, base main).
- #653 (S-SCHED-5) is restacked merge-only onto 9/9 (#720): head `9a23e3b2471794a1356d9939cc4e06682f1ea7ec`, base `agent120/sched-split-9-integrity-tests-c-live`.
- Pairs with mobile #325 (OR-112-13), unchanged. Land the nine pieces as one stack (MERGE_DEPENDENCY_GUIDE rule 11).
