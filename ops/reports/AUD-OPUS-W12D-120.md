# AUD-OPUS-W12D-120 — Claude Opus 5.5 lens, agent 120: mobile wizard W1 #345 + W2 #346 delta, plus the W3 #347 restack delta

- **Window:** 09:28 to 09:53 PDT 10-05 (times from `date`). Verdicts posted at 09:52 PDT.
- **Heads:** checked on GitHub at the start and again right before posting. None moved.
- **Claims:** ops/lanes120/claims/mobile-{345-ed29833c,346-26cf23b7,347-8437fb94}-opus.
- **Notes:** ops/aud-120/AUD-OPUS-W12D-120/
  - probes: `audOpusW12D_120_345.test.ts`, `audOpusW12D_120_346.test.tsx`
  - posted bodies: `verdict-{345,346,347}.md`
  - lane logs: `run*.log`
  - comments read: `c<id>.md`
- **Footprint:** no heavy local work; probes ran only in CI lanes. Disk was at 61%.
- **Independence:** I listed comments before posting and saw only the first lines of the Sol W12D-120 verdicts. I read no Sol body or notes from this round before posting.

## mobile #345 @ ed29833cb2d5c597f0be3a557877bd3cf29d85a3: APPROVE, A/B/C = 0/0/1
- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5999046073
- **Delta since Opus APPROVE at 97c9005e:** only `packageCreateIntent.ts:363-374`. A retired create now keeps the write-ahead it saved (B-345-1). This is correct: keeping the intent only lets the same create be replayed with the same key.
- **Evidence reuse:** my 97c9005e approval covers the unchanged lines.
- **CI at this head, all green:**
  - Typecheck/lint/test (run 37241093788)
  - Analyze js-ts and Analyze actions (run 37241093835)
  - CodeQL
- **Branch state:** behind main cc4ceeed, with no file overlap.
- **Size:** 2,726, grandfathered.
- **Lane run 37342580875:** 40/40. That includes the new probe (6/6) and my replayed W12-119 probe (6/6).
- **Old-head comparison, run 37343369828:** the new probes at 2baea5b8/97c9005e fail 4 #345 cases for the expected reason, and the 2 controls pass.

## mobile #346 @ 26cf23b7987c866615ab9a4b2f95a10e6e318f40: APPROVE, A/B/C = 0/0/1
- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5999046333
- **Delta since Opus APPROVE at 2baea5b8:**
  - `FirstPackageForm.tsx` (B-346-3): a `ready` flag, `show()` with a `shown` ref, locked inputs, and a submit that waits for hydration and then snapshots.
  - The W1 merge.
  - Tests.
- **Verified:** account switch, edits made before ready, double tap, unmount, unreadable storage, and the generation fence.
- **CI at this head:** Typecheck/lint/test green (run 37241251692).
- **Size:** 2,873, grandfathered.
- **Lane run 37342606067:** 80/80. The new probe at the old head fails 3 cases for the expected reason, and the 3 controls pass.

## mobile #347 @ 8437fb94aa031b906e26f33f734097d9af2f9bc5: APPROVE for the restack delta only, A/B/C = 0/0/0
- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-5999046635
- **The merge is clean:** remerge-diff is empty.
- **W3's own diff is byte-identical** to 3beab160's: 2,592 lines, grandfathered.
- **What came in is exactly the W1 and W2 delta.**
- **Effect on W3:**
  - The editor does not pass `isLive`, so the B-345-1 branch cannot be reached there.
  - The wizard renders `FirstPackageForm` with the same props.
- **Lane run 37342629917:** 148/148, including the W3 suites.
- **CI at this head:** Typecheck/lint/test green (run 37241252458).
- **W3's own content has no lens verdict at any head yet.** It is not merge-eligible until both lenses do a full review.

## Follow-ups (C)
All of these are outside the frozen round; the operator tickets them.

- **C-345-7 (new): `packageCreateIntent.ts:366-372`**
  - **Problem:** the comment claims sign-out always wipes a kept intent. That fails if a write-ahead is issued after `clearAllStorage()` lists the prefs keys and completes after the `logout` re-render. See `authActions.ts:379,423-425` and `useCurrentUser.ts:87-90`.
  - **Effect:** the same coach's own unsent package details stay on the device under that coach's key.
  - **Fix rule:** fence `saveIntent` for a retired account during sign-out (the `purgeConsultationDraft` pattern), then delete the intent keys. At minimum, narrow the comment.
  - **Proof:** the observe case passes at ed29833c and fails at 97c9005e.
- **C-346-7 (new): `FirstPackageForm.tsx:470-479`**
  - **Problem:** Create is not disabled while hydrating, so a queued tap can finish a resumed package the coach has not seen yet.
  - **Fix rule:** `disabled={busy || !ready}`, plus the matching `accessibilityState`. Keep the wait in `submit`.
  - **Optional:** announce the end of hydration.
- **Still open from W12-119:**
  - C-345-4 (`packagesApi.ts:463-473` rewrites cadences)
  - C-345-5 (`coachSetupApi.ts:99-121` "finish" copy)
  - C-345-6 (`errors.ts:255-262` package update and locked copy)
  - C-346-4 (`CoachSetupChecklist.tsx:120` and `:83-86`)
  - C-346-5 (`CoachSetupScreen.tsx:44-46` privacy overclaim)
  - C-346-6 (`FirstPackageForm.tsx:214`: no trial choice)
  - the rest of C-346-1 (checklist and invite async guards)
  - For full fix rules, see ops/reports/AUD-OPUS-W12-119.md.
- **W3 items for its full review:**
  - `CoachPackageEditScreen.tsx:261` (no `isLive`)
  - `CoachPackageEditScreen.tsx:608` ("It will not be made twice.")
  - `CoachWizardNavigator.tsx:343` ("our payments partner", "TGP never sees them")
  - `CoachWizardNavigator.tsx:130-140` and `:622-629` (awaits with no owner re-check)

## Operator decisions (recommended default first)
1. **The new Cs (C-345-7, C-346-7):** default is to ticket them with the W12-119 Cs as one small T4 follow-up after #345-#351 land. The alternative is to fold them into the W3 #347 fix round, which already touches this code.
2. **W3 #347:** default is to schedule its first full dual review now. Its known items (first-person copy at `:343`, the missing `isLive`) need a builder round before landing.
3. **Landing:** unchanged. #345-#351 land as one, after the coach backend deploys.

## HANDOFF
- **mobile #345** @ ed29833c: Opus APPROVE 0/0/1 (5999046073). The Sol verdict exists at this head; the operator reconciles.
- **mobile #346** @ 26cf23b7: Opus APPROVE 0/0/1 (5999046333). The Sol verdict exists at this head; the operator reconciles.
- **mobile #347** @ 8437fb94: Opus APPROVE for the restack delta only (5999046635). Its first full W3 review is still pending.
- **If a head moves:** a fresh Opus lens runs a delta from these heads and replays `ops/aud-120/AUD-OPUS-W12D-120/*.test.ts*` and `ops/aud-119/AUD-OPUS-W12-119/*.test.ts*`.
- **Cleanup done:**
  - audit/AUD-OPUS-W12D-120/{345-probe-1,346-probe-1,347-probe-1,old-heads-1} deleted.
  - Worktrees wt/AUD-OPUS-W12D-120-{345,346,347,old} removed.
  - No locks held. The claims stay as records.
