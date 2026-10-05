FIX ROUND 6 (B-PUSH3-120, agent 120) — growth-project-backend#693 @ cc0a167fcf977e1452e8f94f72aa72d83ec648d0

Answers Sol REQUEST CHANGES 0/1/2 at 53796f1e (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-6000395449): B-648-8 reopened. Normal pushes 53796f1e..2ab3c726..cc0a167f (no force, no rebase). #692 not moved (346cf4a8). Size 2,965 lines (+2,844/-121), 25 files vs #692 (grandfathered 3,000 ceiling).

## Finding -> change -> commit
| Finding | Change | Commit |
|---|---|---|
| Sol B-648-8 (reopened): final preference/token awaits ran after the last authority CAS, so a lapsed/swept claim or an erased token/outbox row still reached Expo | `handOff(row, to)` moved after the final consent/token re-read: it is now the last await before `client.send`. One CAS on `{ id, status: 'sending', lease_token, lease_until > now, user: { is: { expo_push_token: to } } }` stamps `handed_off_at` and renews the lease. A lost/expired/swept claim, a deleted row, a deleted user or a cleared/replaced token = zero provider calls (`lease-lost`); `handed_off_at` stays null, so the sweep returns the row to pending (attempt refunded) and it is decided again, never classified as an unknown attempt. Final quiet-hours clock check stays after the CAS with no await before the send (`later()` clears `handed_off_at`); late-provider `finish` path unchanged. Fake (`test/utils/push-outbox-fake.ts`) honours the relation filter. | 2ab3c726 |
| tsc (lane) | round-6 helper returns the fake's user shape | cc0a167f |

## Tests
| Check | Result |
|---|---|
| test/push-delivery-send-time.spec.ts, new `B-648-8 (round 6)` block, 5 cases: final read outlasts the lease and a replica sweeps (only the replica sends, once); erasure of token + outbox rows during the final read; lease lapse without a sweep; sign-out; new device registered | failing-before (53796f1e src): 5 fail / 18 pass, https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37356352005 ; after: 23/23 |
| Probe replay lane (Postgres 15 + `tsc --noEmit`) at cc0a167f + both lenses' probes | https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37356806463 : tsc clean; 18 suites, 240/243; failures listed below |

## Probe replay (both lenses)
| Lens | Probe | At 53796f1e | At cc0a167f |
|---|---|---|---|
| Sol PUSH3 refined | final token read outlasting the lease (sweep) | fail (A sends once) | outcome holds (A sends 0, replica sends the released row once); the probe's line `expect(reads).toBe(2)` fails by construction: reads = 4 because the replica's own two token reads go through the same mock after it re-claims the released unstarted row (the probe comment permits that). One-line variant (`reads` 4, replica send 1, A send 0): pass (`b-push3-120-sol-refined-variant.spec.ts`, same lane) |
| Sol PUSH3 refined | erasure during the final token read | fail | pass |
| Sol PUSH3 refined | controls: erased/null final read; 70 s read inside the lease sends once | pass | pass |
| Sol PUSH3 refined + PUSH P2 | the 7 earlier cases (reschedules, twin proof, drip writer, token cleanup, mute during preparation, emitter copy, pre-handoff delete control) | pass | pass |
| Sol PUSH3 unrefined (superseded by the refined file) | 11 cases | 9/11 | 11/11, but its in-mock `handed_off_at` expects throw into the worker's catch, so treat the refined file as the evidence |
| Sol P1 | 6 cases | 6/6 | 6/6 |
| Opus | U1 channels, U4 copy control | pass | pass |
| Opus | U2 [C-693-3], U3 [C-693-4] | fail (ruled Cs) | fail (ruled Cs, unchanged) |
| Opus live (real Postgres) | L1-L6, incl. L1 30 rows on two pools through the new relation-filter CAS | pass | pass |
| Candidate suites | round5 15/15, service 22/22, emitters, booking, scheduling, s-fee, drip, purchase fan-out, lock-screen copy, no-pii guard | pass | pass |

## Money-list self-check
- Webhook order/redelivery: no webhook code changed.
- Concurrency/lock order: one extra condition on the existing single-row CAS; claim SQL unchanged; two replicas: the stalled worker loses, the replica sends once (tested).
- Terminal states: deleted user/row/token = no send; unstarted rows are released, never closed as lease-expired.
- Pagination/fail-closed: a failed handoff CAS sends nothing.
- Currency/minor units: none touched.
- Copy truth: no customer copy changed; worker log reads "claim lapsed, taken back or erased".

Follow-up Cs unchanged (Sol C-693-1, C-693-2; Opus C-692-2, C-693-3, -4, -6..-10). Merge order unchanged: #692 then #693 back to back; deploy after #693 with migrations.

## CI at cc0a167f
CI run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37356808729 (build-and-test full suite, rls-floor-guard, rls-live, community-live, mwb-3-live) success; Schema parity 37356808838, Dependency Audit 37356808772, H4 deploy readiness 37356808799, size-label success. deploy-readiness-gate skipped (optional, not claimed). Main-only gates (migrations forward/reversible, banned casts, CodeQL, danger, SBOM) run once #692 lands and the base is main.

READY FOR AUDIT
