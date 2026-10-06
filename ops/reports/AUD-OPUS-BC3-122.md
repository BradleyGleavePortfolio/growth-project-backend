# AUD-OPUS-BC3-122 — Claude Opus 5.5 lens, broadcasts b#726-#730 delta re-review (agent 122)

Window: 16:57 to 17:01 PDT, 2026-10-05 (times from `TZ=America/Los_Angeles date`). The time box was 25 minutes. Under RUTHLESS SCOPE I checked only my own prior items and the changed lines.

Independence: I did not read the Sol lens's notes, report or comments for this round before posting. I did read the builder report B-BC2-122.md.

## Verdicts
Each head was re-verified right before posting.

| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #726 (confirm unchanged) | b5501a89611844fc43717084d887e604af33037a | APPROVE | 0/0/1 (C-726-1 carried) | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005978507 |
| #727 | 63348b0771e39996cf75f8451802430f9f497229 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005978910 |
| #728 | 06b322e8471929933cbe0e635b1cc2f9dcdbc4cb | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005979435 |
| #729 (merge-only) | ec53c87f7bd800b9f2c469c7d4b36b16b8e67e65 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005979810 |
| #730 | afbb4c1a846422df6b09a028d71d2a763a6ccf76 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005980291 |

Comment texts are in ops/aud-122/AUD-OPUS-BC3-122/v726.md through v730.md. There are no Bs.

## Prior Opus items
- **C-727-1 (archived clients): CLOSED.**
  - `resolve()` filters out clients whose `User.archived_at` is set (broadcast-scope.service.ts:44-56).
  - At send time, `lockSendAuthority` reads `archived_at` FOR SHARE and refuses with `not_on_roster` (:82-90, :102).
  - The dispatcher inherits this through fenceSend.
- **C-728-1 (a draft PATCH without a status armed the draft): CLOSED.**
  - `validate()` now takes a default status (broadcasts.service.ts:132, :161), and `update()` passes 'draft' for a draft row (:283-289).
  - Paused rows still stay paused (:299, :315).

## Changed-line wrong-audience check (clean)
- **#727 program audience (Sol B-727-1):** it now also matches the live copies of a master. The rule is the same as ProgramLibraryService.listAssignees: `cloned_from_id`, not a template, not archived, same tenant. It stays bounded to the caller's roster.
- **#727 validator and #728 picker (Sol B-728-1):** both use the library's read rule (own or tenant_shared masters) and agree with each other.
- **#729:** merge-only. The own patch is byte-identical at both heads, and the full old-to-new diff equals the #728 delta exactly.
- **#730:** own src is unchanged (5 files byte-identical). The only change is the live-spec seed: one open sub-coach per client, and PrismaService is passed to the scope service. The cases that depend on it (A-659-6, A-659-7) still prove what they claim.

## Evidence
- PR CI at the heads:
  - #726: 17 success, 1 skipped.
  - #727 to #730: 10 success, 1 skipped each.
- The live spec passed in community-live-tests at afbb4c1a: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37390496684/job/112034145278
- I ran no lane and no local runs, since PR CI covers the changed specs.
- Sizes: #727 1,404/1,500, #728 1,210, #729 1,114, #730 880, #726 642.

## Carried Cs (not blocking, from BC1)
C-726-1, C-728-2, C-659-4, C-659-5, C-659-10.

## HANDOFF
Done: five APPROVE verdicts posted at the exact heads above.
- Claims: ops/lanes122/claims/backend-{727-63348b07,728-06b322e8,729-ec53c87f,730-afbb4c1a}-opus. The #726 claim from BC1 (backend-726-b5501a89-opus) still applies. A stray extra file, backend-726-b5501a89-opus-bc3, was also created; it is harmless.
- I created no worktrees or branches, pushed nothing and hold no locks.

Next: the operator pairs these verdicts with Sol's BC3 verdicts and lands the stack per A5 rule 11. If any head moves, a new delta re-review is needed.
