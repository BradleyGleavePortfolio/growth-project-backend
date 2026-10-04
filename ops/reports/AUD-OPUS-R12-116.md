# AUD-OPUS-R12-116 (lens Claude Opus 5.5, agent 116 wave) — recurring R1 #678 + R2 #679

Job: full-depth T4 audit of backend #678 @ b89c199d91a868e625b1c1bd861d540ac4c2a8ce and #679 @ 958806d15af64863786337699020428cd89ffaf3
(FIX ROUND 3 by B-RECUR-116). Claims: ops/lanes116/claims/backend-678-b89c199d-opus, backend-679-958806d1-opus (created 03:13 UTC 10-04).
Notes and probe scripts: /home/user/workspace/ops/aud-116/AUD-OPUS-R12-116/ (logs/, src/ copies, pipefail probes).
No worktree, no CI-lane run (read-only lens; findings proven from code, Stripe docs and existing CI runs). df 76 percent at start.

## Prior findings (this lens, #654 @ 02c48de7 APPROVE 0/0/3, comment 5972187301)
- C-654-8 (pinned resend after Stripe 24 h key window -> second subscription): CLOSED at 958806d1 (lookup before any resend; none + >= 23 h -> ATTEMPT_EXPIRED; tests #680 b-recur-116-fix-round-3.spec.ts:120-209, red before run 37172350469, green #680 job 111348792701).
- C-654-9 (mobile mode 'none'): CLOSED in mobile #342 @ 72821495 src/lib/packagePayment.ts:189-202.
- C-654-10 (errorLabel unfiltered Error.name): CLOSED (src/checkout/error-label.ts closed allow-lists; no err.message left in the service).

## Evidence reuse (G09)
- #678: all 12 files' patch 7be7d396..b89c199d == #654 own patch cd332bfa..02c48de7 (normalized hunk headers, md5). 10 of 12 blobs identical to 02c48de7;
  schema.prisma and stripe-connect-api.service.ts differ only by #627/main changes underneath (transfer beforeSend, drop statuses, unrelated models).
- #679 @ 517def8c (the cut): all 8 files' patch b89c199d..517def8c == #654 own patch; 7 of 8 blobs identical; checkout.service.ts differs only by buyer drop-status lines underneath.
- Deep audit: 517def8c..958806d1 (error-label.ts new; subscription-checkout.service.ts +~100/-58) and every function it calls.

## Operator question (mail 20:12 PDT): delivery-artifact.spec.ts:284
- Head: #679 517def8c, CI run 37151675007 attempt 1, build-and-test job 111286676037 (20:35 UTC 10-03): 1 failed / 12,500 passed.
  Attempt 2 same head: that spec PASSED (OOM in community-message-shape.live.spec.ts); attempt 3 green. Also passes at 958806d1 (job 111348789748) and #680 2b10687c.
- Not #679's content: scripts/ci/assert-prod-sbom.sh and test/ci/delivery-artifact.spec.ts identical to main d23fa317.
- Root cause (main-side REAL gate bug, fail-open): assert-prod-sbom.sh:24 `set -Eeuo pipefail` + :59 `if printf '%s\n' "$NAMES" | grep -qxF "$d"`:
  grep -q exits on first match, printf gets SIGPIPE (141), pipefail makes the pipeline non-zero, the denylisted tool reads as absent.
  :62 inverse (spurious "required package missing"). Local probe (exact construct, 3,000 iterations): 45 and 97 misses; here-string form 0/3,000.
  Fix: separate T4 CI-gate PR on main: `grep -qxF -- "$d" <<<"$NAMES"` at :59 and :62 + a regression spec. Does not block #679.

## #678 @ b89c199d91a868e625b1c1bd861d540ac4c2a8ce — APPROVE 0/0/0
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976162988 (posted 03:28 UTC 10-04).
- Evidence reuse: full (patch-identical to approved #654 code). Piece boundary: compiles alone; new Stripe methods and trial-card inert until #679;
  createSubscription optional trialPeriodDays leaves guest-checkout caller unchanged; http-exception.filter pickErrorDetails is live but adds fields only
  for 5 allow-listed codes (none thrown with `code:` on this base); no in-piece tests (accepted under rule 11); migrations additive + down.sql, no user ids.
- Note: 20270225000000 sorts before production's latest applied 20270301000000; prisma migrate deploy applies it anyway (independent tables). Not a finding.
- Checks at head: 7 running required + forward/reversibility green; R75 checker (main's scripts/check-r75.js, range 7be7d396..b89c199d) OK.

## #679 @ 958806d15af64863786337699020428cd89ffaf3 — APPROVE 0/0/2
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976163092 (posted 03:28 UTC 10-04).
- FIX ROUND 3 delta verified: lookup before any pinned resend (:846-858), 23 h window from reservation created_at (>= 1 h margin under Stripe's 24 h),
  cancelConfirmed (:1551-1567) gates every expire after a cancel, past_due/unpaid = plan, sheetSecret null for ended subs, 12 errorLabel log lines.
- C-679-1 (decided C, the builder's open race): cancelConfirmed DELETE can land on a subscription paid between the read and the DELETE (two-surface self-race
  + terms change); client charged, plan ends. Fix rule: void the open first invoice before DELETE (Stripe voids only open/uncollectible; refused = paid ->
  ALREADY_ACTIVE); trialing: cancel pending SetupIntent first. Placement: Stripe calls in #678 (~25 lines), call in #679 cancelConfirmed (~15 lines,
  #679 -> ~2,967), test in #680 (2,914). Recommended default: follow-up PR on main right after the stack lands.
- C-679-2: listSubscriptionsForCustomer status=all limit=100 with no created bound; >100 lifetime subs -> has_more -> 'unreadable' forever on that key.
  Fix: created[gte] = reservation created_at - 5 min (optional param in #678, one call in #679).
- Checks at head: 7 running required green (build-and-test job 111348789748, attempt 1); R75 checker b89c199d..958806d1 OK. Size 2,952.

## Outside-this-PR finding for the operator (main-side, CI gate = T4)
- scripts/ci/assert-prod-sbom.sh:59 and :62 `printf | grep -qxF` under pipefail: SIGPIPE race makes the denylist fail open (eslint in a prod SBOM can pass)
  and the require-list spuriously fail. This is the delivery-artifact.spec.ts:284 failure on #679 517def8c attempt 1. Fix: here-string
  `grep -qxF -- "$d" <<<"$NAMES"` + regression spec, separate T4 PR on main. Probe scripts: ops/aud-116/AUD-OPUS-R12-116/pipefail-grep-q-probe.sh
  (45 and 97 misses / 3,000) and herestring-fix-probe.sh (0 / 3,000).

## Cleanup
- No worktree created, no audit/* or ci/* branch pushed, no CI dispatched. Claims left in place (verdicts posted at those heads).

## HANDOFF
State at 03:29 UTC 2026-10-04 (20:29 PDT 10-03).

| PR | Exact head | Verdict (this lens) | Comment | Next step |
|---|---|---|---|---|
| backend #678 (base agent115/fee-split-6-recovery-specs 7be7d396) | b89c199d91a868e625b1c1bd861d540ac4c2a8ce | APPROVE 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976162988 | Needs GPT-6.1 Sol verdict at this head. Lands with #679/#680 after fees F1-F6 (rule 11); retarget to main, then CodeQL/danger/banned casts/SBOM must pass. |
| backend #679 | 958806d15af64863786337699020428cd89ffaf3 | APPROVE 0/0/2 (C-679-1, C-679-2) | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976163092 | Needs Sol verdict at this head. Then AUD pair R3 (#680 @ 2b10687c). Cs are optional; recommended as one follow-up PR on main after the stack lands. |

Operator decisions (recommended defaults):
1. C-679-1 / C-679-2: follow-up PR on main after the recurring stack lands (default), not a new round on #679 (would push it to ~2,970 of 3,000).
2. assert-prod-sbom.sh SIGPIPE fail-open: launch a small T4 B-CI-style PR on main (default: yes, before the next SBOM-gated release).
3. If any later round moves #678 or #679, a fresh Opus lens audits the delta from these heads using this report.
