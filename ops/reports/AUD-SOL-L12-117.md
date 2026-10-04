# AUD-SOL-L12-117 — agent 117 — mobile dunning L1/L2

## Final verdicts

| PR | Exact audited head | Sol verdict | A/B/C | Posted verdict |
|---|---|---|---|---|
| mobile #352 (L1) | `58b80914feb62101aca2c7b5e8985d32912b80b0` | REQUEST CHANGES | 0/1/0 | [5976926738](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5976926738) |
| mobile #353 (L2) | `e22acc84b3ee99c94f3ec77793b38ca0c8157241` | REQUEST CHANGES | 0/3/3 | [5976938374](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374) |

Both heads were re-read immediately before their POST, with a duplicate-Sol-verdict guard; one verdict was posted per assigned PR/head. ([L1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5976926738), [L2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))

## Scope, split fidelity and evidence reuse

T4 money/auth-state review; all L1 and L2 diff lines, their tests and adjacent auth/logout, persisted-query identity, interceptor, entitlement/paywall, navigation, support and telemetry consumers were read independently. L1 is 1,774 changed lines and L2 1,730, within the hard limit, with operator KEEP assessments. ([#352 assessment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5975773636), [#353 assessment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5975773732))

G09 reuse is confined to this model's original approval at `23435ec2c099aa5e25c8c0737d92662b73c83855`: all 32 stack files except `app.json` retain their approved blobs, and `app.json` only gains landed-main OTA/fingerprint/build-number changes. The complete native test suite in L3 was also read for previous closure and coverage applicability. ([Original Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964847392), [L3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354))

Mechanical `git merge-tree --write-tree 23435ec2 367e6c48` produced `8f0a27302988e47a0b375c29465b3b9ad7b7dd01`, exactly the tree at L3 `37ed3d56c3ed1173f7da8791408e4887de3898bf`; no L1/L2 production import requires a later piece. The transport addition is live in L1, while its native flow has no screen caller until L2; L3 carries native-flow regressions, so full-stack landing is still required. ([Verified split/landing record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354), [L1 operator rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5975773636))

Prior B-322-1/2/3/4/5/6/7 and C-322-2 closures remain on their proven scope: partial-paid bank reconciliation, same-operation lost-answer recovery, retained bank context, guarded SDK rejections, complete/consistent quoted money, exact invoice approval and valid `in_progress` handling. Their evidence did not cover the independently reproduced auth/lifecycle/dispute cases below. ([Prior Sol closure record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964847392))

## Findings and verification rules

### B-352-1 — Global lockout is not account/auth-generation owned

- **Location:** `src/services/api.ts:276-280`; `src/entitlements/dunning/dunningLockoutStore.ts:27-54`; the existing sign-out reset list at `authActions.ts:434-440` omits the new singleton. ([Exact L1 finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5976926738))
- **Proof:** A's lock survives `authEvents.emit('logout')`; even after an explicit reset and B login, a delayed A-authenticated 403 sets the global lock/reference again. The actual interceptor/store produced two failed identity invariants while current-account and unrelated-403 controls and the existing interceptor suite passed. ([CI run 37179751151](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179751151))
- **Fix/verification:** own the signal by auth/account generation; synchronously retire/reset it at the actual identity boundary; stamp outgoing requests and reject retired-generation 403 writes. Regress logout, A→B, late old response after reset and same-account token refresh; raw JWT equality is not the identity rule. ([Posted fix rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5976926738))

### B-353-1 — Retired/out-of-order provider reads mutate current authority

- **Location:** `DunningLockoutProvider.tsx:80-116,157-175`; post-await status/error/store/cancel continuations lack lifetime, account and sequence fences. ([Exact L2 finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))
- **Proof:** retire A's mounted provider, complete B's clear read, then complete A's old locked read: B displays lockout and its next offline refresh cannot remove it. Separately, a delayed old clear response overwrites a completed newer locked read and removes the overlay; both are actual mounted assertions. ([Final CI run 37179882612](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179882612))
- **Fix/verification:** fence all continuations to the initiating provider/account/auth generation and invalidate on cleanup/disable/account change; sequence/coalesce reads. Preserve malformed-body last-state retention and paid-query invalidation; cover both completion orders and delayed cancellation. This is not a duplicate of L1's interceptor finding. ([Posted fix rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))

### B-353-2 — Retired card UI launches fresh native/payment work

- **Location:** `UpdateCardScreen.tsx:134-177,182-245,263-284`; native helper ownership/cancellation port is absent in L1 `updateCard.ts`. ([Exact L2 finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))
- **Proof:** hold the quote, unmount, release it: actual setup and confirm POSTs still happen with a 15,000-cent approval. Hold native presentation, unmount, return success: confirm/pay launches after retirement. Neither final assertion relies on a timeout. ([Final CI run 37179882612](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179882612))
- **Fix/verification:** bind the operation to initiating account/auth generation and fence every await before setup, native presentation, pay/resume, state/navigation/alerts. Retire screen-owned work on leave/unmount and propagate the predicate through the helper; preserve already-sent operation identity for honest account-bound reconciliation, not a false no-charge claim. Cover deferred quote/native-return A→B and ordinary same-account success/recovery. Shared helper changes belong in #352 and then restack. ([Posted fix rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))

### B-353-3 — Disputed payment is falsely presented as a card-repairable decline

- **Location:** `DunningLockoutScreen.tsx:37-43,120-139`; `DunningBanner.tsx:9-18`; `UpdateCardScreen.tsx:75-89,300-301,331-364`. Existing `status.kind` and `quote.disputes` are not used by these recovery surfaces. ([Exact L2 finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))
- **Contract:** backend D5 `e0afe6780e5954b20e88cfaefd63f12cd31d218d` reports reversal/dispute, can return an empty payable quote containing disputes, keeps disputed access unchanged and explicitly tells the client saving a card does not settle it. The mobile builds local outcome copy and drops that limitation. ([Paired backend composer](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e0afe6780e5954b20e88cfaefd63f12cd31d218d/src/checkout/client-billing.service.ts))
- **Proof:** mounted dispute lockout still says add a working card/charge/restore; dispute-only Save card returns a Done-style result without any dispute recovery explanation. Both assertions fail while ordinary lockout and paid-flow controls pass. ([Final CI run 37179882612](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179882612))
- **Fix/verification:** render truthful reversed-payment/support/coach/cancel guidance from status kind and quote dispute identities; retain card saving and payment of actual ordinary invoices without promising dispute settlement. Cover dispute-only before/after save and mixed paid/disputed plans; any required structured result-contract extension belongs in L1, not a backend behavior change. ([Posted fix rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))

### Optional carried/cheap items

1. **C-353-1 / prior C-322-4:** `UpdateCardScreen.tsx:117-124,159-174,227-245`; component state/ref does not establish restart continuity, and the L3 “after remount” helper test hand-supplies its context. If required, add an account-bound non-secret recovery locator and a real lifecycle test; do not call it mounted/device recovery. ([Prior Sol observation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964847392))
2. **C-353-2 / prior C-322-3:** `ClientPackagesScreen.tsx:237-244,296-303`; whichever stack/#334 merges second must preserve the native UpdateCard route and resolve the banner overlap without restoring a hosted portal. ([Prior carried composition item](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964847392))
3. **C-353-3:** `DunningLockoutScreen.tsx:138`, `UpdateCardScreen.tsx:461`; first-person JSX survives the quoted-string guard. Remove it, extend the guard to rendered JSX, and retain the paid-before-cancel caveat in the lockout's initial alert at `:87-88`; cosmetic copy cleanup alone is not a new money/auth blocker. ([Exact optional item](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))

## CI, artifact provenance and retained files

| Evidence | Source/artifact | Result |
|---|---|---|
| L1 required candidate checks | Exact PR head; [Typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153877906/job/111293139565), [JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153877980/job/111293140023), [actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153877980/job/111293139888) | 3/3 SUCCESS; build steps executed |
| L2 candidate build | Exact PR head; [Typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153881234/job/111293149084) | SUCCESS; required analyses absent on stacked-base head |
| L1 audit-only negative proof | PR head + identity spec + lane workflow; run head `bea12c22b30e4b627e81c79005c4c868dcf75353`; [37179751151](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179751151) | 2 failed / 4 passed |
| L2 first harness | PR head + lifecycle spec + lane workflow; run head `ecb934cbc158e1928d67777aa39ec970dfaafc6a`; [37179751596](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179751596) | 4 actual negative assertions; 2 deferred-press harness timeouts, not production findings |
| L2 final negative proof | Same production head; corrected deferred-press harness; run head `78a09610e7ff0261806ce832355ab57cfe99014a`; [37179882612](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179882612) | 6 actual failed invariants / 39 passed; existing lockout suite and two positive controls pass |

The correction only changed the audit spec to retain RTL 14's async press promise until the controlled network/native result was released; no production source changed. These red negative jobs are not candidate required-check regressions or relabelled flakes. Probe-only CI typechecking was intentionally skipped; candidate typechecking ran in the linked normal jobs. ([Superseded harness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179751596), [final proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179882612))

Retained in `ops/aud-117/AUD-SOL-L12-117/`:

- `verdict-352.md`, `verdict-353.md`, `posted-352.json`, `posted-353.json`
- `pr-{322,352,353,354}.json`, `comments-*.json`, `checks-{352,353}.json`
- `diff-352.patch`, `diff-353.patch`, `approved-to-stack-app.patch`, `approved-to-stack-names.txt`, `stack-merge-tree.txt`
- `auditSol117DunningIdentity.test.ts`, `auditSol117Lifecycle.test.tsx`
- `probe-352.patch`, `probe-353.patch` (first harness), `probe-353-final.patch`
- CI launch logs and all failed-job logs, including the superseded harness

No heavy local command, candidate branch write, merge, production access, settings/flag change or paid build was performed. Only the three isolated audit branches were pushed; all three were deleted and both owned worktrees removed after preserving the above evidence. ([L1 execution record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5976926738), [L2 execution record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374))

## HANDOFF

| PR | Final state | Next step / recommended default |
|---|---|---|
| #352 @ `58b80914feb62101aca2c7b5e8985d32912b80b0` | Sol REQUEST CHANGES, A/B/C 0/1/0; exact-head required checks green; [verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5976926738) | Builder closes B-352-1 with failing-before/passing-after CI, updates shared native cancellation port for L2's B-353-2 if needed, then restacks. Do not merge now. |
| #353 @ `e22acc84b3ee99c94f3ec77793b38ca0c8157241` | Sol REQUEST CHANGES, A/B/C 0/3/3; build green, both required analyses absent on stacked-base head; [verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5976938374) | Builder closes B-353-1/2/3 and cheap C-353-3, retains optional C-353-1 and operator C-353-2 truthfully, then restacks L3. Fresh independent lenses audit the new exact heads. |

**Operator decision/default:** route the whole four-B closure to one builder for this two-PR boundary, preserve every payment/recovery path, and land mobile #352–#354 as one only after backend #687–#691 is independently approved/landed/deployed and the combined main-target candidate has all required contexts. Do not waive absent analyses, activate FEATURE_DUNNING_V2 or treat SDK/transport doubles as native PaymentSheet/3DS/redirect/universal-link acceptance. No new product decision or spending is requested. ([L1 landing dependency](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5975773636), [L2 required landing gates](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5975773732), [prior release limits](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964847392))
