AUDIT Claude Opus 5.5 — growth-project-mobile#352 @ c89f719cd8f5863c4150af1da5b96e273df319d6 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/8

Lens AUD-OPUS-L3-121 (agent 121). Tier T4 (billing lockout, money copy, shared native PaymentSheet). Size 2,586 vs main (grandfathered, under 3,000).

**Evidence reuse.** This lens audited every #352 line at T4 at `ac244d22` ([AUD-OPUS-L12-119, 5983819724](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983819724)). That evidence covers the lines that have not changed since. Audited fresh:
- **Main merge `4070652`.** Its tree `dfb53858` equals `git merge-tree --write-tree ac244d22 cc4ceeed`. `cc4ceeed` (#368) touches no #352 file.
- **Fix `c89f719c`, every line:** `dunningErrorCopy.ts`, `dunningApi.ts`, `updateCard.ts`, the dunning README, `dunningL1Contract.test.ts`.
- **Copy rules.** Copy was judged against R-DISPUTE-PAUSE (disputes **and inquiries**: owner decision 6, 09:43 PDT 10-05) and the operator ruling that B-352-7 forbids "settle".

**Probe run.** {{RUN352}}

## Prior findings at ac244d22
| ID | Status at c89f719c |
|---|---|
| B-352-7 (Opus): "Email support to sort it out"; the three ruling facts missing | **Closed.** One sentence, `disputePauseFacts` (`dunningErrorCopy.ts:463-478`), now appears in every outcome. It says access has ended, billing is paused, the coach decides, and nothing restarts on its own or with a new card. No dispute output contains "settle", "sort it out", "support", the first person or "!". The 119 probe passes 5/5, and the VERIFY cases pass for all 9 outcomes and every scope. |
| B-352-2 (Sol): mixed paid + disputed outcomes | **Sound (delta reviewed).** The paid amount is kept. Access news is scoped to "The plan you paid for" (`:518-526`), and processing says "The plan it pays for updates" (`:526`, `:542-543`). The title no longer says "updating your plan" while a dispute is open. |
| B-352-3 (Sol): an older update could replace the shared native sheet | **Sound (delta reviewed).** Each update takes a session number before its first native step (`updateCard.ts:126`, `:189-191`). The number is checked between `initStripe` and `initPaymentSheet` (`:200`) and again after init (`:213`, `:225`), with no await between the last check and `presentPaymentSheet`. A new variant also passes: A is already inside `initPaymentSheet` when B starts; A never presents or confirms, and B presents once, with its own customer and SetupIntent. |
| C-352-1, C-352-2, C-352-3, C-352-6, C-352-8 | Open (frozen) |

## Finding
**B-352-9 (new): the dispute copy says the bank reversed a payment. Under owner decision 6 the same copy is shown for an inquiry, which moves no money.**
- **Where:**
  - `dunningErrorCopy.ts:491-493`: `disputeNotSettledLine` says "Your bank reversed a payment" / "reversed payments";
  - `:631`: the `cancelOutcomeCopy` dispute branch says "Your bank had reversed a payment on this plan".
- **Why it is false:**
  - Decision 6 (owner 09:43 PDT 10-05): an inquiry pauses the plan exactly like a dispute.
  - The backend pauses on an inquiry (growth-project-backend#705 @ `2a03d7dd`, `test/dunning-v2-dispute-pause.spec.ts:269`, "an inquiry pauses like a dispute"). It reports the inquiry with the same `kind: 'dispute'` / `reason: 'dispute_paused'`, so the app cannot tell the two apart.
  - Stripe: inquiries have no financial impact ([Stripe docs](https://docs.stripe.com/disputes/withdrawing)).
- **Counterexample:**
  - The client's bank opens an inquiry on a renewal. After a card save, the outcome reads "Your bank reversed a payment to Avery. For that plan, access has ended and billing is paused. ..."
  - No money moved, but the client is told that it did.
  - 3 PROBEs fail: {{RUN352_PROBES}}.
- **Same fix on the backend:** the Opus lens raised B-687-8 there. #687 @ `d86b31a6` (`dunning-v2.copy.ts:182-193`) now says "the bank opened a dispute or inquiry about a recent payment".
- **Fix rule:**
  - No dispute copy may claim money moved: no "reversed", "took back" or "refund".
  - Say what is true for both cases: "Your bank opened a dispute or inquiry about a payment[ of $X] to <coach>." Use "about payments" for several plans.
  - `disputePauseFacts` stays as it is.
  - #353 reuses the same wording (B-353-9).
- **Verify:** the three `B-352-9` PROBEs in `aud121OpusL3_352.probe.test.ts` turn green; every VERIFY and CONTROL case stays green.

## Follow-ups (C)
- **C-352-10 (new)** `dunningErrorCopy.ts:620-634`:
  - `cancelOutcomeCopy(_, { dispute: true })` cannot be reached any more: no surface offers End my plan for a dispute, and D2c sends no cancel route.
  - Its text would also contradict the base copy: after "You keep access until ..." (scheduled) it says "its access had already ended", and after "Your plan has ended" it says "Only your coach can restart it".
  - Rule: when next touched, drop the dispute branch or make it outcome-aware.
- **C-352-11 (new)** `:489-491`: the noun counts plans, not charges, so two disputed charges on one plan read "a payment of <sum>". Rule: count disputes for the noun.
- **C-352-12 (new)** `:474-477` (account scope, used by the lockout summary and the Update card intro): "Your access has ended and billing is paused. Your coach, Avery, decides whether to restart it." Here "it" has no antecedent. Rule: "whether to restart the plan".
- **Carried, open:** C-352-1, C-352-2 (land #352 -> #354 as one), C-352-3, C-352-6, C-352-8.

## Money list (lens check)
- **Webhooks:** none on mobile; the newest status read wins.
- **Concurrency:**
  - one owner of the native sheet (B-352-3);
  - screen and account fences after every await;
  - the confirm is never sent by a retired or superseded update.
- **Terminal states:** a dispute pause reads as a dispute from `reason` alone and never carries a lock date (`dunningApi.ts:80-95`).
- **Fail closed:** strict normalisers are unchanged; a malformed body throws and the last known state stays.
- **Currency:** totals are per currency, in minor units (`disputedTotals`); currencies are never summed.
- **Copy truth:** B-352-9.

**CI at this head:** all pass (Typecheck, lint, test; Analyze (javascript-typescript); Analyze (actions); CodeQL).

**Merge state:** BEHIND main `b79ca594`.
- Since `cc4ceeed`, main overlaps #352 only in `src/services/authActions.ts`.
- `git merge-tree` is clean and the hunks are disjoint: main restructured `signOut`, while #352 adds a `dunningLockoutStore.retire()` row in `resetUserScopedStores`.
- A refresh therefore qualifies for the MERGE-ONLY TREE CHECK.
