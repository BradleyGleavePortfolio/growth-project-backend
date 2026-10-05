# AUD-SOL-L3-121 — mobile lockout FIX ROUND 2

## Status
Complete: three exact-head verdicts posted 2026-10-05 12:51:16 PDT from `date`.
Independent Sol T4 lens, agent 121; started 12:41:15 PDT from `date`.
Read common 121 fully (including incident addendum), only assigned JOBS121 entry, current source-of-truth A1/A6/A9.1 and assigned historical entries, lens contract, builder report and prior Sol reports.
No other lens's current-round notes or verdict read before posting.

## Exact candidates
- #352 `c89f719cd8f5863c4150af1da5b96e273df319d6`, 2,586 changed lines, base main, behind current main.
- #353 `9d47045b63a4680d852591ae3b4b2d3bfb1e0d85`, 2,723 changed lines, base #352.
- #354 `68c7f080c1e7e7708e7c3b213ae9278b57ba3649`, 1,119 changed lines, base #353, merge-only.
GitHub verified all open, created 2026-10-03 and below grandfathered 3,000 cap. ([L1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352), [L2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353), [L3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354))
Claims taken under `ops/lanes121/claims/mobile-<PR>-<head8>-sol`.
Candidate checks green; stacked PRs have no main-target analyses, not counted green.
Snapshots and filtered comments in `ops/aud-121/AUD-SOL-L3-121/`.

## Verdicts and counts
- #352 REQUEST CHANGES, A/B/C **0/2/2**. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))
- #353 REQUEST CHANGES, A/B/C **0/1/3**. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))
- #354 APPROVE for own merge-only test delta, A/B/C **0/0/0**; not approval of lower source or permission to land the train. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354#issuecomment-6001849937))
- Aggregate A/B/C **0/3/5**; no head moved through the immediate pre-post checks. ([L1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621), [L2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106), [L3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354#issuecomment-6001849937))

## Prior Sol disposition
- B-352-1 stays closed on stale-403/auth-reset scope; B-352-2 closes on mixed receipt/pause-facts scope; B-352-3 repaired at initStripe gap but remains open at native presentation/continuation boundary. ([L1 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))
- Re-pinned old Sol119 “settle” assertion to access-ended/billing-paused/coach-decides/no automatic or card restart; amount and no-universal-recovery assertions retained and passing in the previous exact-runtime lane. ([L1 replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979))
- B-353-1 stays closed on retired/out-of-order reads; B-353-2 closes on retained destructive alerts, including same-account reconciliation once sent; B-353-3 closes on old dispute deadline/card-repair/missing-three-facts scope. ([L2 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))

## Must-fix findings
### B-352-3, retained/narrowed
`updateCard.ts:189-229,241-249`: newest-session latch does not serialize already-presenting native work and is discarded after presentation. ([L1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))
Pinned iOS 0.64.0 assigns `self.paymentSheet` during init; completed A presentation clears the current singleton, which can already be B's. ([Native initializer](https://github.com/stripe/stripe-react-native/blob/v0.64.0/ios/StripeSdkImpl%2BPaymentSheet.swift), [native completion](https://github.com/stripe/stripe-react-native/blob/v0.64.0/ios/StripeSdkImpl.swift))
Two controlled negatives: retired A teardown erases B's sheet (B error rather than done); superseded-but-mounted A confirms its old SetupIntent (done rather than retired); 45 controls/regressions pass, 2 fail. ([Same-head proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979))
Fix rule: native lease through completion/teardown, owner recheck after acquiring lease, operation-session fence through confirm/retry/bank work, correct lease release on every outcome, preserve all functionality and account-owned sent-request reconciliation. ([Posted finding/fix rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))

### B-352-9, new
`dunningErrorCopy.ts:485-494,628-631`; `dunningApi.ts:142-147,325-353`: undifferentiated accepted inquiry metadata is reported as a bank reversal before/after card save and in retained cancel outcomes. ([L1 finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))
Inquiries withdraw no funds unless elevated, although binding owner policy pauses billing/ends access for inquiries too. ([Stripe inquiry contract](https://docs.stripe.com/testing-use-cases?locale), [owner decision register](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md))
Fix rule: neutral dispute/inquiry copy unless a trusted discriminator proves withdrawal; preserve pause/restart facts, amounts and mixed paid-plan receipts; replace generic-envelope reversal anchors and test inquiry/legacy/mixed/cancel forms. ([L1 rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))

### B-353-8, new
`DunningBanner.tsx:25-31`; `DunningLockoutScreen.tsx:69-75`; `UpdateCardScreen.tsx:87-95`: accepted locked/waived inquiry envelopes display “reversed”/“took back” without any withdrawal discriminator. ([L2 finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))
Fix rule: neutral language or trustworthy withdrawal gating, retain three facts/coach action/no card or automatic fix, update generic-envelope anchors; cover helper and mounted locked/waived/UpdateCard forms plus ordinary payment controls. ([L2 rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))

## CI and proof applicability
- Candidate CI green: L1 Typecheck/lint/test + both analyses; L2/L3 Typecheck/lint/test only, with main-target analyses absent and not counted green. ([L1 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285154), [L1 analyses](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285354), [L2 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344789490), [L3 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344796375))
- Previous Sol120 lanes verified directly on GitHub and runtime diffs independently checked: L1 **45 pass / 2 fail**; L2 **114/114 pass**; L3 **41/41 pass**. ([L1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979), [L2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355825712), [L3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355800424))
- One consolidated lane **37365609416**, branch `audit/AUD-SOL-L3-121/354-1-complete`, workflow head `f0c91bda802937114b5caee162f227811d527856`, rooted at exact #354 plus audit specs; all L1/L2 runtime files are byte-identical to their candidates. ([Single retained batch](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365609416))
- Batch queued at final 12:52:51 PDT check; inquiry assertions explicitly **not executed**, static finding supported by source + Stripe semantics; no local npm/jest/tsc/eslint/build used. ([Queued lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365609416), [inquiry semantics](https://docs.stripe.com/testing-use-cases?locale))
- Initial per-PR lanes 37365516729/37365523330 were canceled immediately on operator's one-in-flight instruction; they are not counted as proof. ([Canceled L1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365516729), [canceled L2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365523330))
- Auto-merge trees independently recomputed exactly, with details in `ops/aud-121/AUD-SOL-L3-121/tree-proof.txt`; L3 own test blob matches original Sol-approved #322 and prior L3, and its complete own-content file was read. ([L3 evidence disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354#issuecomment-6001849937), [original Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964847392))

## Follow-ups (C)
- C-352-1, `dunningErrorCopy.ts:75-86`, `updateCard.ts:128-135,285-292`: standard correlation helper, short customer/full searchable reference fields. ([L1 carried Cs](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))
- C-352-3, `dunningErrorCopy.ts:247-253`: validated Retry-After rather than fixed minute. ([L1 carried Cs](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621))
- C-353-1, `UpdateCardScreen.tsx:125-146,168-196,256-279`: non-secret account-owned recovery locator and true remount/restart restoration test if required. ([L2 carried Cs](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))
- C-353-2, `ClientPackagesScreen.tsx:239-244,290-302`: #334 composition, preserve native route/no hosted portal. ([L2 carried Cs](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))
- C-353-4, outside diff, `ClientPackagesScreen.tsx:284-287`: remove “our servers” in rendered-copy follow-up. ([L2 carried Cs](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106))

## Recommended operator default
Hold #352/#353 for the three listed Bs; #354's own-content APPROVE does not release the train; builder should make one focused round, replay both lenses and restack, with fresh exact-head dual verdicts. ([L1 recommendation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6001848621), [L2 recommendation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-6001849106), [L3 restriction](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354#issuecomment-6001849937))
No owner product decision is needed: inquiry policy and old “settle” anchor disposition are already binding. ([Decision register](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md))
Keep backend-first deployment, flag authorization, complete-stack integrated main checks and native iOS/Android PaymentSheet/3DS/redirect acceptance as separate release gates. ([Existing landing contract](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983776115))

## HANDOFF
- All three verdicts posted, exact heads unchanged at immediate pre-post and final 12:52:51 PDT API reads; own verdict payloads and posted JSON receipts, probes, source-composition diffs, native source snapshots and tree proof under `ops/aud-121/AUD-SOL-L3-121/`.
- A 0 / B 3 / C 5 across assigned PRs, as posted; new inquiry assertions remain pending on batch lane 37365609416, do not call them executed.
- No PR branch source push, merge, deploy, production/settings/flag change, lockfile edit, native build, spending or local heavy command.
- Three detached audit worktrees at `wt/AUD-SOL-L3-121-{352,353,354}` retain audit-only probe commits as intermediate evidence; no workspace evidence deleted.
- Single batch branch/run still useful pending result. Collect its result at no faster than 60-second polling; retain exact queued status if it never starts. Only after 20 minutes queued and deps READY is the incident rule's single-spec heavy fallback allowed.
- Both canceled per-PR remote lane branches deleted; retained batch `audit/AUD-SOL-L3-121/354-1-complete` should be removed after collecting its result. Own worktrees are detached, no named local audit branches were created.
- Builder next: repair B-352-3 and neutral inquiry-money copy in L1/L2, preserve all functionality, replay every prior/new probe, restack, post FIX ROUND then obtain fresh dual audit.
