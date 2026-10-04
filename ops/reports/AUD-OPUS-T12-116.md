# AUD-OPUS-T12-116 — Claude Opus 5.5 lens, trials T1 #671 + T2 #672 (backend)

Job: FULL T4 audit (no prior Opus evidence on #656; nothing reused). Agent 116 wave.
Started 2026-10-04 02:55 UTC (2026-10-03 19:55 PDT, from `date`).

## Setup
- Claims: ops/lanes116/claims/backend-671-a6a2b589-opus, backend-672-e06b5b13-opus.
- Heads: #671 a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4 (base main d23fa317, 1,727 lines, 14 files, 11/11 required green);
  #672 e06b5b13691d3f869b92009c87159c0672df517c (base #671 branch, 1,328 lines, 12 files, 10 pass + deploy-readiness-gate skipping;
  CodeQL/danger/banned casts/SBOM run once the stack targets main).
- Tree check: `git diff 86223987 5743e51f` (#656 head vs #673 T3 head) is empty.
- Worktrees: wt/AUD-OPUS-T12-116-1 (#671 head), wt/AUD-OPUS-T12-116-2 (#672 head). Notes: ops/aud-116/AUD-OPUS-T12-116/.

## Progress
- 03:05 UTC: read every line of #671 and #672.
- 03:14 UTC: #672 probe run 37173251463 (4/4 red as expected).
- 03:20 UTC: Sol posted REQUEST CHANGES 0/1/0 on #671 (B-671-1, markStarted same-purchase race) at 03:11Z. Re-derived from the code
  (trial-usage.service.ts:264-310 has no same-purchase check after a skipped insert; reserve() has one at :186), and confirmed that T3
  calls markStarted in applyTrialState before the CoachPackage FOR UPDATE lock. Own probe on the #671 head: run 37173511118 (B probe red, control green, C-671-1 red).
- 03:19 UTC: posted #672 verdict. 03:23 UTC: posted #671 verdict (heads re-read immediately before each post, unchanged).

## Verdicts
- #671 @ a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4 — REQUEST CHANGES, A/B/C = 0/1/3 —
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-5976130575
  (text: ops/aud-116/AUD-OPUS-T12-116/verdict-671.posted.md). Probe: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173511118
- #672 @ e06b5b13691d3f869b92009c87159c0672df517c — REQUEST CHANGES, A/B/C = 0/1/6 —
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5976099855
  (text: ops/aud-116/AUD-OPUS-T12-116/verdict-672.posted.md). Probe: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173251463
- Evidence reuse: none. Sol's #671 B-671-1 was reproduced with this lens's own probe and recorded as this lens's B-671-1.
- Lens comparison (for the operator): on #671 both lenses have the same B (markStarted same-purchase race). On #672, Sol (issuecomment-5976081090,
  0/2/1) rates the stale-clock lease and the sweep starvation as B-672-1 and B-672-2; this lens rates them C-672-1 and C-672-2 (the rationale:
  delivery is documented as at-least-once, and starvation needs 50 or more stuck rows in a 3-day window and affects retries only, since the
  first send is post-commit). This lens's B-672-1 (trial-end date time zone) is not in Sol's verdict. Recommended default: fix all three
  in the same round; each fix is small.

## Findings (summary)
### #671 (T1) — REQUEST CHANGES 0/1/3
- B-671-1 trial-usage.service.ts:264-310 — two concurrent markStarted for one purchase with no reservation: the loser returns
  'conflict' for its own started row, so T3 would record a conflict and cancel a legitimate trial. Same finding as Sol B-671-1, reproduced
  independently. Fix: same-purchase holder => 'owned'.
- C-671-1 trial-view.ts:80-95 never-started trial reads 'ended'. C-671-2 T1 modules untested in T1 and no live-DB race test (rule 11).
  C-671-3 formatTrialAmount wrong for zero-decimal currencies.
### #672 (T2) — REQUEST CHANGES 0/1/6
- B-672-1 trial-notice.service.ts:731-742 — trial-end date ignores main's resolveRecipientTimeZone (unstamped default row = Pacific,
  no row = UTC), so a notice can name a day later than the real local end ("Cancel anytime before" Oct 13 for a trial ending 9:30 pm ET
  Oct 12). Mobile main never stores a stamped client zone, so this is the common case.
- C-672-1 stale sweep clock gives already-expired leases (duplicate sends). C-672-2 cancelled-purchase rows stay pending and head the
  50-row sweep (starvation). C-672-3 'ClientPackages' push target not in mobile CLIENT_PUSH_ROUTES (tap lands on Notification Center).
  C-672-4 TrialNoticeService untested in T2. C-672-5 stated charge excludes automatic tax / discounts. C-672-6 email key comment
  overclaims; in-app row copy frozen at record time.

## Operator items (not blocking T1/T2)
1. C-656-1 composition with recurring (#678-#680 lands first): #680 `packageTrialDays` (src/checkout/subscription-checkout.service.ts:261-273)
   reads `CoachPackage.trial_days` via Reflect.get and sells trials with its own ClientPurchase-based one-trial check (:717-737), with no
   TrialUsageService.reserve. Once T1+T2 land, a coach-set trial goes live through #680 while T2's `trial_offer` still says
   `not_offered_yet` (capability unregistered), and the two one-trial ledgers disagree; T3's markStarted then runs on the no-reservation
   path (B-671-1). Recommended default: the trials stack carries the integration (single ledger, reserve in #680's decide step, capability
   registered by the checkout that really sells) before it lands on a main that has #680.
2. #675 (coach) vs #672 both change packages.service/controller: the second to land refreshes, and must keep `trial_days` in
   create data and assertValidTrial in assertValidPricing/publish. Note only.
3. Mobile: add `ClientPackages` to CLIENT_PUSH_ROUTES in the mobile trials piece (C-672-3). Recommended default: fold into mobile #338
   or its follow-up.
4. Before deploy: owner adds Stripe event `customer.subscription.trial_will_end` (and confirms `customer.updated` for the customer default
   card mirror). Product decision on tax wording (C-672-5): recommended default "plus any tax" when automatic tax is on.

## CI / cleanup
- Probe specs are kept in ops/aud-116/AUD-OPUS-T12-116/ (audit-opus-t12-116-671.spec.ts, audit-opus-t12-116-672.spec.ts).
- Audit branches audit/AUD-OPUS-T12-116/671-probes and /672-probes deleted (remote and local); `git ls-remote` shows 0 left.
- Worktrees wt/AUD-OPUS-T12-116-1 and -2 removed (no node_modules were linked). Disk 79% (`df -h /`).
- No PR branch was pushed to; nothing merged; no workflow other than ci-lane was dispatched; no production or provider action; no spend.

## HANDOFF
- #671 a6a2b589 REQUEST CHANGES 0/1/3 (B-671-1 markStarted same-purchase race; same as Sol). Builder: fix the insert-collision branch
  (trial-usage.service.ts:279-310) so a same-purchase holder returns 'owned', keep the probe, and add a takeover variant. C-671-1..3 optional.
- #672 e06b5b13 REQUEST CHANGES 0/1/6 (B-672-1 time zone: use resolveRecipientTimeZone, never a later date when the zone is unknown).
  Builder: also close Sol's B-672-1/B-672-2 (= this lens's C-672-1/C-672-2) in the same round.
- Re-audit: Opus lens on the new heads after the fix round. Evidence from this audit applies only to unchanged files (rule G09).
- Operator decisions (recommended defaults): (1) the trials stack carries the #680 integration before it lands on a main that has recurring
  (C-656-1); (2) the second of #672 or #675 to land refreshes packages.service/controller (note only); (3) mobile adds ClientPackages to
  CLIENT_PUSH_ROUTES; (4) the owner enables customer.subscription.trial_will_end before deploy; for tax wording, use "plus any tax".
- CI: #671 11/11 required green; #672 10 pass + 1 skipping (main-only gates pending the stack's retarget). Both probe runs failed as designed.
