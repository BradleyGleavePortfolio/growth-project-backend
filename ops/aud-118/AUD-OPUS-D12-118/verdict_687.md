AUDIT Claude Opus 5.5 — growth-project-backend#687 @ f8e47bf40fe81064d679fc2831cedf3b1cd90b2c — VERDICT: REQUEST CHANGES
A/B/C = 0/1/3

AUD-OPUS-D12-118 (agent 118 wave), T4 (money, access, client copy). This lens's previous verdict on this PR: REQUEST CHANGES 0/1/3 @ `c2a901a8` (comment 5975919378).

**Scope.** FIX ROUND 1 delta `c2a901a8..f8e47bf4`, 6 commits, no main merge. (1) `5f9d081b` moves `dunning-v2.cadence.ts`, `dunning-v2.dispatcher.ts` and `test/dunning-v2-cadence.spec.ts` into D1. `git diff 6627044c 5f9d081b` is empty for all three, so they are byte-identical to D2 @ `6627044c`. (2) `f2a97625`, `41404998`, `7d7e7db4`, `b8eb8f13`, `f8e47bf4` are the fixes: the live-grant query, coach receipts, `dunning-v2.safe-error.ts`, the emitter, the template footer, the money comment, `sweep_checked_at` (migration, down.sql, schema) and the fake orderBy. Every changed line was read. Size is 2,717 changed lines (1,500-3,000 band; under the cap).

**Prior findings from this lens.**
| ID | Decision | Evidence |
|---|---|---|
| B-687-1 first person in the client email footer | CLOSED | `41404998`: `dunning-v2-client.hbs:13` now has no first person. The voice test in `test/dunning-v2-foundation-fixes.spec.ts` failed before the fix ([run 37172705221](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172705221), "client template") and passes at this head. |
| C-687-2 money comment | CLOSED | `client-billing.money.ts:37` |
| C-687-3 `workerIdleMemoryLimit` | CLOSED by main | main `b644198b` (#694) carries the identical `jest.config.js` hunk. After the next main merge, D1's diff on this file is empty. |
| C-687-4 migration order | Note only | Kept under operator ruling OR-113-4. The new `sweep_checked_at` column goes into the same unapplied migration and its down.sql: additive and nullable, no user id. |

**Evidence reuse (G09).** The other lens's verdict at this head was not read before this one was written. The moved cadence and dispatcher rest on this lens's audit of them at `6627044c` (verdict 5975919515), which is valid because the files are byte-identical. The fix-round lines on top were audited fresh. Files untouched since `c2a901a8` rest on that verdict. The client template was audited fresh: it is the subject of the copy-truth check in this job, and it produced B-687-5.

**CI at this head.** All 11 required checks are green (build-and-test [run 37174418115](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174418115)). The PR is BEHIND main, not DIRTY.

### B-687-5 — dispute-cycle client emails say a card update pays the debt and keeps access
- `src/email/templates/dunning-v2-client.hbs:9` (new in D1) says: "Once the new card is saved, the amount owed is paid with it and your access stays on."
- `src/checkout/dunning-v2/dunning-v2.dispatcher.ts:259-283` (`sendClientEmail`) sends this template with `update_card_url` on every client email, including the late-reversal (dispute) cycle at steps 2 and 3. Those emails carry the subject "Your recent payment was reversed" (`:415`).
- In a dispute cycle no invoice is open, and a card update does not end the cycle:
  - D2 `applyImmediateClear` refuses `card_update` on the dispute marker or an open obligation.
  - D3's quote documents `dispute_open` as "a card update never settles it".
  - The Day-10 lock still lands.
  So the sentence is false for every client whose payment was reversed. It breaks the copy-truth rule (no claim before proof). The same email also carries the dispute-cycle Roman bodies the dispatcher selects: `lr_day3` falls back to `DAY1_EMAIL` ("I attempted it again today, and it was declined"), and `LR_DAY7_ESCALATION` says "Update your card now and I will restore everything at once" (`dunning-v2.copy.ts:202`, `renderer.ts:200`). Both are false in a dispute cycle.
- Probe: branch `audit/AUD-OPUS-D12-118/687-copy` (this head plus the probe spec only, `e8b5b754`), [run 37218769772](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218769772), `test/aud-opus-d12-118-687.probe.spec.ts`. It uses the real dispatcher, classifier and renderer, and compiles the real template with Handlebars.
  - The control passes: a payment-cycle Day-7 email carries the card-update sentence.
  - Both probes fail: the rendered dispute-cycle emails at steps 2 and 3 contain "the amount owed is paid with it and your access stays on".
  - The builder's `dunning-v2-foundation-fixes.spec.ts` passes 23/23 in the same run.
  - The contradicting behaviour is proven on #688 by [run 37219161671](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219161671), part 3: on a dispute cycle, `applyImmediateClear('card_update')` returns `{liftedLockout:false}` and the lock stays.
- Fix rule: copy for dispute-cycle clients never says or implies that a card update pays, ends the cycle, keeps access or restores access. This covers the email body, the template paragraph, push and blocker, all in D1's dispatcher choice of copy.
  - The template renders the card-update paragraph only for payment cycles (the dispatcher passes the cycle kind).
  - Dispute-cycle notices say what happened (the bank reversed a payment of {amount}), what ends the cycle (the dispute closing in the client's favour, for example the client withdrawing it with their bank), the lock date, and the reply-to-email support path.
  - For payment cycles, do not claim success before proof: the card is charged, and access stays on once that payment goes through.
  - Verify: the probe above passes. A new test renders every dispute-cycle client surface (steps 2 and 3, both variants) and finds no card-update promise. The payment-cycle control keeps its call to action.

### C (follow-ups; not blocking)
- **C-687-6** `dunning-v2-client.hbs:11` (same block as B-687-5): the 2A sentence ("End my plan ... The unpaid amount is then canceled and nothing more is charged") leaves out that access ends at once, which is the 2A ruling. A client could expect to keep access to period end, as a voluntary cancel does. Fix: add "Access ends right away." to the same sentence.
- **C-687-7** Coach push body is a raw code. The dispatcher (`:337`) dropped the dedicated coach push copy, so the emitter pushes `title = in-app body`, `body = alertType`, and `pushToCoach` (main, `notifications.service.ts:598-599`) shows `dunning_step7` on the coach's lock screen. This happened at `6627044c` too whenever the emitter was wired. Fix: give `pushToCoach` a display body (use `renderer.coachPush`) and never put `alertType` in the body.
- **C-687-4** Migration order: note only (see above).

### Verified (no finding)
- `hasOtherLiveAccess` (`dunning-v2/dunning-effective-access.ts:28-60`):
  - "Not itself locked" is now part of the query (`dunning is null` OR `isNot {active, locked}`), the fetch is `take: 1`, and the row re-check stays.
  - It stays scoped to this client, entitled, in a paid status and unexpired.
  - It is correct for any number of locked alternatives (Sol B-687-1). Prisma 6.19 to-one `is`/`isNot` filters are valid (tsc green).
- `dunningErrorCode` returns closed codes only. `StripeConnectApiError` code matches `^[a-z][a-z_]{0,63}$`. Prisma codes must match `^P\d{4}$`. Other errors map to an allow-listed class name or `error_unknown`. No import cycle: `stripe-connect-api.service.ts` imports only `@nestjs/common`.
- `CoachAlertEmitter`:
  - It still never throws and returns a real result per transport. Muted (null) counts as skipped, a throw or `false` counts as failed, and the push read-state row is written only after a sent push.
  - It is used only by the dunning dispatcher, and `DunningV2Module` imports `NotificationsModule`, so it is wired.
  - Behaviour on live paths outside dunning v2 does not change.
- Dispatcher:
  - `coach_alert` and `coach_push` are separate outbox channels (no CHECK constraint on `channel`). A push-only retry never writes a second feed row.
  - Every `error` is a closed code. `push_<code>` draws on the closed `PushDeliveryCode` union.
  - `run()` logs and stores codes only.
- Piece boundary:
  - D1 compiles alone (tsc green). The v2 surface stays gated by `FEATURE_DUNNING_V2` (OFF), and the hourly cron is a no-op while the flag is off.
  - Nothing imports a later piece. The migration is additive with a matching down.sql.
- No first person, exclamation mark or emoji in the changed copy.

**Outside this PR (operator).** The main-copy dispute-cycle bodies (`copy.ts:180-208`, `renderer.ts:185/200`) carry the same promise as B-687-5. Recommended default: they are fixed in the same D1 round, because they are the same message.

Head re-read right before posting: `f8e47bf40fe81064d679fc2831cedf3b1cd90b2c`.
