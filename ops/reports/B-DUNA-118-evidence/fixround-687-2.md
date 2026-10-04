FIX ROUND 2 (B-DUNA-118, agent 118) — growth-project-backend#687 @ 38d9b3ab0be5bb39df8eb0986293b9d62f04ba37

Tier T4 (money path). Closes Sol B-687-3 and B-687-4 ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490)), Opus B-687-5 ([Opus verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982478903)), the D1 part of Opus B-688-7 (template fallback) and the same-line Cs C-687-6, C-687-7 (same lines as B-687-3) and C-688-10. Main `2af682ca` was merged first, merge-only (`51139d5a`).

Commits: `51139d5a` merge main; `82f98e79` tests only (fail before the fix); `fde7b047` fix; `38d9b3ab` splits one test regex (CodeQL js/regex/missing-regexp-anchor on the new test).

Failing-before run (tests on the pre-fix tree): [CI lane 37221795789](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221795789), 13 failed / 22 passed, every failure one of the cases below.

| Finding | Change | Commit | Test (fails before, passes after) |
|---|---|---|---|
| Sol B-687-3, C-687-7 | `coach-alert.emitter.ts:85-95`: dunning coach pushes go through `pushToUser`, which reads the Expo ticket. A rejected ticket is `failed` (retried by the outbox), no or invalid token is `skipped` with a code, only an accepted ticket is `sent`. The push carries the coach push copy (title "Payment"), not the alert type. `dunning-v2.dispatcher.ts:357-368` maps the code to `push_ticket-error` / `push_no_token`. Other coach alerts keep `pushToCoach`. | `fde7b047` | `foundation-fixes` "B-687-3": real NotificationsService with Expo stubbed: "a rejected ticket is failed (retried); no token is a coded skip", "control: an accepted ticket is sent, with display copy, not the alert type". Two existing coach-delivery tests now mock `pushToUser`. |
| Sol B-687-4, Opus B-687-5, C-687-6 | `dunning-v2-client.hbs:9-17`: in a dispute cycle the email says a new card keeps future payments working and does not settle the reversed payment (the bank closing the dispute does). In a payment cycle: "Saving a card there charges the amount owed to it, and once that payment goes through, your access stays on." The End my plan paragraph shows only outside dispute cycles and now says access ends right away. `dunning-v2.copy.ts:178-207`: dispute copy (push, blocker, Day-7 email, coach in-app/push/email) says what happened, what ends it and the lock date, with no amount and no card or cancel promise. Payment emails and blockers drop attempt counts and every success claim made before the payment goes through. `renderer.ts:198,214`: every `lr_*` key renders dispute copy. `dispatcher.ts:288`: dispute blocker at every dispute step. `:269,:392`: `dispute` flag to both templates. | `fde7b047` | `foundation-fixes` renders every channel through Handlebars: "dispute cycle step 0..3: no card or cancel promise" (all four failed before), "payment cycle: a card update is a charge; access follows once it goes through". `dunning-v2-copy.spec.ts` updated to the new pinned strings. |
| Opus B-688-7 (D1 part) | `renderer.ts:98-117` `applyTokensTruthfully`: a sentence whose token has no value is left out (no "{cardLast4}", no guessed history). Used by renderPair, renderBlocker and the voice-policy push path. COACH_EMAIL: the four "declined ({reason})" lines become "Day 0 — {amount} — declined" plus "Charge attempts on this invoice so far: {attempts}" (D2 supplies Stripe's attempt count). | `fde7b047`, `38d9b3ab` | "step 1..3, both kinds and variants, no card / amount": every step × cycle kind × variant on every surface, with no card, reason or attempts. Asserts no `{token}` (step 0 has no tokens and passed before; steps 1-3 failed). |
| C-688-10 | Coach email: "The full record is here: tgp://..." becomes "The full record is in the app: open Clients, then {clientName}." This deviates from the fix rule. Most mail clients do not link `tgp://`. An https link would not open the app either: the AASA serves only `/join/*` and `/invite/*` (`well-known.controller.ts:116-117`), and no web page exists at that path. A plain route is the true option. | `fde7b047` | covered by the B-688-7 render test (no braces, no `tgp://`) |
| Sol B-688-7 (test support) | `test/support/dunning-v2-fake-prisma.ts:291-292`: the fake sorts like PostgreSQL (DESC puts nulls first, ASC puts them last, and `nulls` overrides both). Without this, the D2 test could not reproduce the hidden lock. | `fde7b047` | "plain desc puts nulls first, asc puts them last, `nulls` overrides" |

Probe replays at this head, [CI lane 37222815158](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222815158) (7 suites, 113 passed):
- Sol 118 `687-probe` (coach push on an error ticket is failed; the dispute email keeps the button and drops "paid with it and your access stays on"): pass.
- Opus 118 `aud-opus-d12-118-687` (payment Day-7 email has the button and "your access stays on"; dispute steps 2 and 3 have subject "Your recent payment was reversed" and make no settle or access promise): pass.
- Sol 116 `aud-sol-d12-116-d1`: pass.
- Same probes at the previous head `fde7b047`: [37222330624](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222330624), pass.

Money self-check:
- Webhook order and redelivery: no webhook code in D1. A coach push that Expo rejects stays retryable instead of being marked sent.
- Concurrency (two workers, lock order): D1 does not change claims or lock order (D2 holds them).
- Terminal states (refunded, disputed, canceled, deleted account): dispute surfaces never offer a card update or a cancel as the fix. A coach with no device token (for example a deleted account) is `skipped` with a code, never `sent`.
- List pagination and completeness (fail closed): the fake now sorts like PostgreSQL, so capped-list tests see real null order.
- Currency (presentment vs settlement, minor units): amounts are unchanged (formatMinor, the purchase currency). Dispute copy shows no amount.
- Copy truth (no claim before proof): no surface says a card update pays or keeps access before the payment goes through, no attempt count is invented, and no raw token renders.

Size: 2,681 additions + 293 deletions = 2,974 changed lines vs main (tests included). This is in the 1,500-3,000 band, with 26 lines of headroom.

Checks at `38d9b3ab`: build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, npm audit, Schema parity, Forward migrations, New migrations reversible, Banned cast tokens, CodeQL and danger all pass.

Follow-ups (C), reported only (FREEZE):
- C-687-4: note only (OR-113-4), unchanged.
- `dunning-v2.copy.ts:61,76,78`: the payment-cycle Day-1 and Day-3 push copy is pinned by the Roman voice policy (LEGACY/ROMAN_V2 and `test/_fixtures/roman-voice-legacy.snapshot.json`). It still says "Updating your card will settle it" and "Three attempts". Fix rule: the same copy-truth rule as B-687-4, with the snapshot updated in the same PR.
- `dunning-v2.copy.ts:159` LOCKOUT_SCREEN says "after several attempts ... restore everything at once". Fix rule: access comes back once the new card's payment goes through; no attempt claim.
- `dunning-v2.dispatcher.ts:302`: the blocker body is cut at 160 characters. The new copy fits. Fix rule: never cut mid-sentence.
- `dunning-v2.dispatcher.ts:310`: the dispute blocker's "See details" CTA still deep-links to `tgp://billing/update` (the card screen). Fix rule: route it to the dunning status screen.
- `notifications.service.ts:689` (main): pushToUser logs `ticket.message`. Fix rule: log the code only.

READY FOR AUDIT
