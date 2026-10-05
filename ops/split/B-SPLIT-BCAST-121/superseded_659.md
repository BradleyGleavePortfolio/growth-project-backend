SUPERSEDED (B-SPLIT-BCAST-121, agent 121) — growth-project-backend#659 @ fa9a7cbd33c5f1c1d5108f3a3d57ea70f3177faf

This PR (3,929 changed lines) is superseded by a five-piece stacked split, each under 1,500 changed lines, with main 5da537d6 merged in once and fix round 1 for the [Opus](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/659#issuecomment-5964501283) and [Sol](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/659#issuecomment-5964574829) verdicts:
- #726 BCAST split 1/5 (schema, migration, flag, error codes; inert) @ b5501a89611844fc43717084d887e604af33037a, 642 lines, base main
- #727 BCAST split 2/5 (segments, recurrence, send-time scope, cards) @ 15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5, 1,221 lines, base #726
- #728 BCAST split 3/5 (broadcasts, saved replies, client tags services) @ 1dd798ab36e90dbb6b3719b7a4ae13883797167f, 1,162 lines, base #727
- #729 BCAST split 4/5 (dispatcher) @ 82a28bf2dbbe52b516e30fda1d22959ea0f87b42, 1,114 lines, base #728
- #730 BCAST split 5/5 (routes, module, live coverage) @ e97c472f00cdecbce2e5f1a680e05b1744c14715, 865 lines, base #729

Top tree of #730 equals this PR merged with main plus the listed fixes (reference `agent121/bcast-split-0-merged-reference` @ cb87282a00ae5119851f9b4417e9f2c40046030a, tree 6b89e8e23a831749b8fdd2604b9041d164714118; plain merge 03c5d7316528bf68df182e7509deda9b07617dc6). Fixed: A-659-6, A-659-7, B-659-1, B-659-8, B-659-9, plus C-659-2 (main's erasure gate) and C-659-3 on the same lines. Open Cs are listed in each piece's FIX ROUND 1 comment.
This PR stays open for reference; do not merge it.
