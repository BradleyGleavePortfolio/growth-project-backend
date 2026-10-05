# AUD-SOL-TR10-122 — trials train delta audit (agent 122)

Started: 2026-10-05 15:12:34 PDT; 45-minute train time box.

Scope: Sol-only independent audit of #671, #672, #673, #706, #707 against the Sol prior verdict heads in the assigned JOBS122 entry.

## Access status

The required `github` credential preset returned HTTP 401 for `gh api` and invalid-token errors for the mandated context pull and the clone's promisor fetch. The GitHub connector advertises the same CLI route; no authentication was initiated. Public read-only GitHub REST access works.

The live public copy of `TGP_SOURCE_OF_TRUTH.md` was fetched and compared byte-identical to the prescribed local file after the failed pull, so the read A1/A2/A5 rules were current. [Live source of truth](https://raw.githubusercontent.com/BradleyGleavePortfolio/tgp-agent-context/main/TGP_SOURCE_OF_TRUTH.md).

Review completed through public REST/source archives plus local Git tree metadata; no verdict is posted and no comment URL is claimed. Current-round Opus notes, report and comments were not read.

## Exact-head audit conclusions (not yet posted)

| PR | Exact head | Verdict | A/B/C |
|---|---|---|---|
| [#671](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671) | `565893b5c969fdc937d03f3a5b947bcb8d100b11` | APPROVE | 0/0/0 |
| [#672](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672) | `193c6f9ac3f57a10b8ff87fa3874ee0f190dd9b7` | APPROVE | 0/0/1 |
| [#673](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673) | `91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5` | REQUEST CHANGES | 0/1/1 |
| [#706](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706) | `87aaf126036bc7604dceb3ab55f0ddf255519950` | APPROVE | 0/0/1 |
| [#707](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707) | `2bb4b368f39d8a380a48086c6c79d21cb4cc34b9` | APPROVE | 0/0/1 |

Approval of the four other slices does not approve the integrated train while B-673-3 remains open; this is a land-as-one stack. [T3 dependency-qualified prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5985426913).

## B-673-3 — newly enabled trial offer contradicts ordinary checkout truth

**Normal-user story:** A client opens package A's free-trial card sheet, dismisses it without saving a card, then chooses package B from the same coach; B still promises an available free trial, but checkout sells B with no trial and immediate payment instead. [Offer endpoint](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/packages/packages.controller.ts), [Native checkout](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/subscription-checkout.service.ts).

**Owning changed lines:** `src/checkout/subscription-checkout.service.ts:152-157` now registers `TrialCheckoutCapability`, enabling `available=true/reason=offered` customer-facing claims. [T3 native checkout](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/subscription-checkout.service.ts).

**Deterministic source trace:** `TrialUsageService.offersForClient():123-136` reads only `PackageTrialUsage.status='started'`; the abandoned, unstarted A attempt has no started ledger row, so `offerFor():373-382` returns B's advertised days, `available=true`, `reason='offered'`; `ClientPackagesController:258-262,288-289` returns that promise to the client. [Offer reader](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/packages/trials/trial-usage.service.ts), [Customer response](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/packages/packages.controller.ts).

`SubscriptionCheckoutService.decide():555-575` considers that same open A attempt a hold and resolves `trialDays=0`, storing null trial days at `:594`, so `mintSubscription():651-706` omits Stripe's trial and creates a normal paid subscription; ordinary recently opened A is not selected by stale-attempt cleanup. [Checkout decision, mint, and cleanup](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/subscription-checkout.service.ts).

No simultaneous action, provider failure, webhook ordering, retry, lease window, old client, or date-boundary input is needed; this is a normal sequential false customer-facing trial claim, not the frozen edge-case set. [Native decision](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/subscription-checkout.service.ts), [Advertised eligibility contract](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/packages/trials/trial-usage.service.ts).

**Minimal fix rule:** Make the customer offer use the same started-trial/open-attempt eligibility as native checkout, distinguishing a reusable attempt on this package from an attempt holding another package; do not advertise a trial that the next ordinary checkout will remove. Recommended behavior is an accurate unavailable/in-progress offer with a path back to the existing checkout, not silently switching an advertised free trial into an immediate paid plan.

**Verification request:** The proposed single normal-use test is `ops/aud-122/AUD-SOL-TR10-122/B-673-3-normal-offer-mismatch.diff`, inserted into #706's shared-rule fixture. It performs `buy(A) -> offersForClient -> buy(B)` with no handler event or timing mutation and checks advertised availability equals the actual returned trial. `git apply --check` succeeded; no Jest execution is claimed. Run before/after in one CI lane, then check same-package A resumes with its original trial and a genuinely started trial still prevents a second trial.

**Scope disposition:** The builder's reported optional “trial offer has no in-progress state” is promoted here only for this ordinary false claim, not for any reservation race or recovery hardening. [Integration FIX ROUND 12](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-6000663552).

## Delta evidence and prior-finding disposition

- **#671:** compared piece-owned target blobs with `c75002c9`: 14 trial migration/helper/test files unchanged; workflow/schema/deletion-manifest changes come from main's refresh. Independently read the four-line trial live-suite insertion against `5da537d6` and the once-only shared trial-days schema declaration; no ordinary-use B in this piece. [Main refresh](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-6002326167), [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-5977306032).
- **#672:** own approved `TrialNoticeService` target blob unchanged; independently read the email service/types merge, both abort checks, preserved `aborted` error/provider-idempotency path, and main's diagnostic/template additions. B-672-3 stays closed by unchanged code and prior own proof; C-672-1 deployment qualification remains outside this delta. [Prior Sol approval/proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5984411900), [Email restack](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5999282001).
- **#673:** deeply reviewed the native/shared-ledger claim integration in `trialState`, `trialTransition`, both grant writers and end-of-subscription marker handling; only the ledger holder obtains the native marker, and losers are denied access or preserved as paid plans when active. Verified complete +/- identity of checkout-handler T3 additions before/after the latest refresh, so the three refresh conflict hunks introduce no extra T3 edits. The new B is narrowly the capability-enabled offer contradiction above; prior B-673-1 closure remains conditional on #707's runtime landing in the same train. [Exact T3 handler](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/checkout-webhook-handler.service.ts), [Dependency-qualified Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5985426913).
- **#706:** prior two candidate regression file blobs unchanged; full added 299-line shared-rule fixture read, including the ordinary sequential consumed-trial control. No runtime source differs from its #673 parent; retain tests-only approval and the already-recorded C-706-1 without requesting test hardening. [T4 restack](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706#issuecomment-6002327236), [Prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706#issuecomment-5985038771).
- **#707:** full worker delta and relevant API/test changes read against `ffed434e`: draft listing/finalize-without-collection/confirmed void/domain reread are wired coherently; paid-list collision is removed via `listSubscriptionPaidInvoices`, and main's keyed void is kept. Prior Sol B-707-1 no longer blocks: code changed as requested, and the builder after CI plus exact integrated replay retain the Sol draft cases green. This is evidence reuse, not a new independent execution; timing examples are not reopened under the freeze. [FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-5999226884), [Builder after CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37342940525), [Integrated replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-6002327607).

### Carried C counts

- C-672-1: remaining full-stack/mobile/trial-ending webhook deployment qualification, outside this delta. [Prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5984411900).
- C-673-8: C (edge, deferred to 10k clients); carried void/event reconciliation, no work requested.
- C-706-1: prior snapshot-fixture qualification, outside this delta; no new missing-test finding or hardening requested. [Prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706#issuecomment-5985038771).
- C-707-2: C (edge, deferred to 10k clients); carried partial-void reconciliation, no work requested.

## Final CI, sizes, receipts

At the final 15:22:27 PDT exact-head reread, all five heads still matched the assigned heads; API additions+deletions were #671 2,289, #672 2,959, #673 2,996, #706 1,239 and #707 1,249, within their respective caps. [T1](https://api.github.com/repos/BradleyGleavePortfolio/growth-project-backend/pulls/671), [T2](https://api.github.com/repos/BradleyGleavePortfolio/growth-project-backend/pulls/672), [T3](https://api.github.com/repos/BradleyGleavePortfolio/growth-project-backend/pulls/673), [T4](https://api.github.com/repos/BradleyGleavePortfolio/growth-project-backend/pulls/706), [T5](https://api.github.com/repos/BradleyGleavePortfolio/growth-project-backend/pulls/707).

The latest check run per name is green for every applicable check: #671 20 successes/1 skipped deploy-readiness; each stacked piece 10 successes/1 skipped deploy-readiness. Build-and-test, schema parity, npm audit, RLS floor/live, community and MWB-3 are all green; #671 additionally has green CodeQL, banned casts, danger, SBOM, actionlint, shellcheck and forward/reversible migrations. [T1 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671/checks), [T2 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672/checks), [T3 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673/checks), [T4 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706/checks), [T5 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707/checks).

Preserved in `ops/aud-122/AUD-SOL-TR10-122/`: all five exact-head final API/check JSON receipts, full old/new piece raw-tree records, selected original/current source files, T3 shared-rule +/- identity receipts, T5 worker/API deltas, the reading archive, proposed ordinary-use regression, five complete verdict drafts, and `audit-manifest.json`. No local Jest/npm/tsc/eslint/build or independent CI run was performed; no PR code, branch, production state, merge or deployment was changed.

## Operator decisions / recommended defaults

1. **Hold the integrated train for B-673-3.** Default: correct offer/native checkout truth once, not broader reservation hardening. #673 has only four lines of headroom; put the small integration correction in #707's remaining 251-line headroom or a new <1,500-line top piece, and qualify the corrected exact integrated head.
2. **Post the five verdict drafts through a working authenticated channel.** Default: immediately verify the five heads still match, post each `verdict-<n>.md` once, record the returned comment URLs, and preserve Sol independence; no authentication flow was initiated by this subagent.
3. **Accept reviewed implementation defaults.** Claiming the shared ledger at actual trial start and clearing spent payment secrets even for an access-denied loser are coherent with the reviewed code; accept finalize-then-void instead of deleting subscription drafts. Existing mobile/webhook configuration and combined-tree main-only checks remain operator landing/deployment qualifications. [Shared handler](https://raw.githubusercontent.com/BradleyGleavePortfolio/growth-project-backend/91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5/src/checkout/checkout-webhook-handler.service.ts), [Draft fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-5999226884).

## HANDOFF

DONE reviewing; posting is blocked by GitHub CLI credentials, not by queued CI. Independent conclusions: #671 APPROVE 0/0/0, #672 APPROVE 0/0/1, #673 REQUEST CHANGES 0/1/1 (B-673-3), #706 APPROVE 0/0/1, #707 APPROVE 0/0/1 at the exact heads in the table. No comment URLs exist for this round.

Operator next action: verify heads and post the five preserved drafts, then one bounded builder fix and a corrected-integrated-head delta for B-673-3; do not merge the train while the ordinary false trial offer remains. Claims are retained as completion records. No lock, actual Git worktree, audit branch or CI-lane branch was created, so no cleanup action is outstanding; the read-only archive and evidence are intentionally retained.
