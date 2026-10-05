**Tier:** T4 (money path).
**Why:** dunning v2 legacy-hook changes (v1 `dunning.service.ts` dispute marker, env validation) gate access and Stripe collection.
**T4 trigger scan:** money path (dunning, Stripe invoice state), access gating (entitlement), webhook ordering. Hit.
**T3 trigger scan:** env validation (`FEATURE_DUNNING_V2` parsing). Hit; covered by T4.
**Bounded T1:** none; every line here was audited at #688 `2368d5fa`.
**Canonical builder:** B-DUNSPLIT-119 (agent 119).
**Parent owner:** operator agent 119; stack dunning v2 (#687 D1 -> #688 D2a -> this D2b -> D2c -> D3 #689 -> D4 #690 -> D5 #691).
**Acceptance evidence:** CI-lane replay at `d92c83df` (tree equal to #688 `2368d5fa` + main merge + the D1 copy fix): 147 of 150 passed; the 3 fails were a D1 test regex since fixed in D1 `13c008a6` (see the FIX ROUND comment for the run at this head). Probes replayed: Opus 116 lost-dispute, Sol 116 d2, Sol 118 688-probe and 688-probe-v2, Opus 118 688 parts 1-4, plus the D1 probes.
**Promotion triggers:** none while FEATURE_DUNNING_V2 is off. The flag must stay off until D2c is merged: before D2c, the dispute copy ("access has ended, billing is paused") would go out on the old compressed cycle without a pause.

## What this piece is
Split of #688 under the 12:33 size rule (new pieces at or under 1,500 changed lines). The diff is a byte-identical move from #688 `2368d5fa`:
- `src/checkout/dunning.service.ts` (v1 hooks: dispute marker, flag-gated)
- `src/common/env-validation.ts`
- `test/dunning-v2-service-fixes.spec.ts`
- `test/fixtures/stripe/dunning-v2/*.json` (7 files, moved up from #687 to make room there; only D5 specs read them)

## Seams and line counts
| Piece | PR | Base | Changed lines |
|---|---|---|---|
| D1 | #687 | main | 2,822 (grandfathered, under 3,000) |
| D2a | #688 | #687 | 2,440 (grandfathered) — `dunning-v2.service.ts` + `test/dunning-v2-service.spec.ts` (+1 privacy-list line) |
| D2b | this | #688 | 694 (615+/79-) |
| D2c | #705 | #704 | 1,287 |

Seam rule: file-level only. An intra-file seam would leave unaudited intermediate code; every line here equals the audited `2368d5fa`. Each piece compiles and passes its own specs with the flag off.

#689 (D3) is based on #688's branch, so its displayed diff now includes D2b and D2c until it is retargeted (B-DUNB-119 owns #689-#691; not touched here).

## Fix rounds
| Round | Job | Head | Closed | Comment |
|---|---|---|---|---|
| OPENING | B-DUNSPLIT-119 (agent 119) | `276a9f60` | split from #688 (no behaviour change) | [OPENING](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-5984075128) |

