# Agent 118 job board — wave 1 (10-04). One agent per job; one or two PRs per job (plus merge-only restacks named in the entry); END.
Re-read every head on GitHub before acting. All jobs T4 unless stated. Builders: _COMMON_116.md section 7 + _COMMON_118.md.
Lenses: _COMMON_116.md section 8 (claims under ops/lanes118/claims) + _COMMON_118.md; independent of every builder; one verdict per
PR per head; re-read the head right before posting. Repo = growth-project-backend unless "mobile". B = backend base URL
https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/<n>#issuecomment-<id>.

## B-FEES15-118 (builder, Claude Opus 5.5, T4) — fees F2 #682 + F3 #683, then merge-only restack F4 #684 -> F4b #697 -> F5 #685 -> F6 #686
Job one of the whole launch: recurring is stacked on fees, so every fees round forces a recurring restack. Land-quality, once.
Heads: #681 F1 e9650dc4 (dual APPROVE, do not touch), #682 a2051568, #683 33a9d83b, #684 7872a533, #697 b8b63e63, #685 8dc2c2ed,
#686 13c814f7. Take lock `fees`.
- #682: Sol APPROVE 0/0/0 (5977674117). Opus RC 0/1/3 (5977756869): B-682-9 — round-14 test adds banned R75 tokens
  (`test/s-fee-r11-reversal-admission-diagnostics.spec.ts` :357/:371 `page as never`, :369 `.catch(() => undefined)`); the composed
  candidate fails the required "Banned cast tokens" check when F1 carries the stack to main. Dead builder B-F3-117 left two unpushed
  commits on branch ci/B-F3-117-682-r75-after (4482adcd, 5a57e220; its lane run 37186992337 FAILED — find out why). It typed the
  array as `any`; use a genuinely neutral typed form instead (no `any`, `as never`, `as unknown as`, empty catch). Prove with
  `node scripts/check-r75.js --mode=range --base=b644198b90bb9ab1dc62a78794e12cf09f8ace7c --head=<sha>` at F2, at the restacked fees top
  #686, and on a scratch merge of the recurring top (#701 67905b43) with your fees top: no positive class anywhere.
  #682 stays red by design with exactly the 4 tests Sol/Opus verified (F4 carries them); say so with the run URL.
- #683: Sol RC 0/2/2 (5977674319), Opus RC 0/1/4 (5977756981; corrected from APPROVE). Fix:
  - Sol B-683-1 (both lenses): deferred-fee awaiting->settled currency switch compares presentment cents with settlement cents
    (`src/connect/fees/charge-settlement.service.ts` :687-691 with :1421-1455 and the claim's currency rewrite :722). Rule: take
    row.refunded_cents into the max only when row.currency equals the settlement currency; otherwise derive succeeded refunds in the
    settlement currency from the list (as before round 13); list unreadable -> stay awaiting, nothing moved. Verify the two CAD->USD
    deferred cases pay USD 56.40, store 2000 USD, reconcile to zero drift after retry/replay; same-currency, changed-FX higher/lower,
    pending/failed refund and head-coach controls; late converted refund notices unchanged.
  - Sol B-683-5 (Opus rates C; fix it, it is cheap and a Sol B): never clear a retry flag raised by the current run (propagate the
    notice-recording failure, or clear with a CAS on the observed flag value). Verify same-instant failure keeps retry authority and a
    later sweep creates the notice once with no second reversal.
  - Replay every prior probe: Sol's spec `test/aud-sol-f23-117-settlement-boundaries.spec.ts` (parent of commit
    80ca936a2f1443f91f8140f094fd09d9ca5f1943; `git fetch origin <sha>`), audit/AUD-SOL-F34-117/{683-boundaries,683-boundaries-v2,
    684-refunds,684-refunds-budget}, and the round-13/14 probes named in the #683/#684 verdict threads. #683 stays red by design with
    exactly 3 suites / 9 tests (state the run).
  - FREEZE: C-683-4 (both lenses' different C-683-4s), Sol C-683-6 = Opus C-683-5, C-682-5/6/7 go to your report as follow-ups.
- Then merge-only restack #684 -> #697 -> #685 -> #686 (no content edits; if a conflict forces one, that piece gets a FIX ROUND with
  failing-before evidence). Post `FIX ROUND <k> (merge-only restack ...)` + READY on each at green heads. Release the lock and write
  notify/fees.txt: "fees top: #686 @ <sha> (B-FEES15-118, <time>)". Do not touch #678-#701.
Report: ops/reports/B-FEES15-118.md.

## B-RECUR6A-118 (builder, Claude Opus 5.5, T4) — recurring R1 #678 + R2 #679 (MOST CRITICAL OF ALL)
Heads: #678 b04ea692 (base fees F6 #686), #679 6760ee6a. Above them (NOT yours): #680 9621457e, #696 5225e078, #701 67905b43; a
second builder (B-RECUR6B-118) takes #680/#696/#701 after you end. Take lock `recur` while you push.
- #678: Sol APPROVE 0/0/0 at b04ea692 (5977830820); Opus APPROVE 0/0/1 at 0c2191c0 (old, 5977231057).
- #679: Sol RC 0/3/1 at 6760ee6a (5977831040): B-679-7 pre-send marker does not fence account finalization (delete during
  post-claim/pre-reply still sends a paid create); B-679-8 unknown rejected-bind cleanup releases the one-subscription exclusion;
  B-679-10 a null pending SetupIntent (Stripe returns none when the customer already has a default card) makes an eligible native trial
  unavailable or permanently confirming. B-679-10 is the "clients with a saved card cannot start a trial" gap from the handoff: fix it
  with more functionality, never less (attempt-owned SetupIntent presented in the native sheet; lift the trial end only on that
  intent's success; one trial per client per coach; a customer default card is never this attempt's consent). C-679-3 -> report.
  Opus RC 0/2/1 at f48fa8f0 (5977231156): Sol says Opus B-679-8/9 are closed at round 5; confirm with the tests.
- Dead Opus lens AUD-OPUS-R12R5-117 left probes on audit/AUD-OPUS-R12R5-117/679-probes (commit 86ebd91a on 6760ee6a; lane run
  37187184830, 2 failed at head): "Opus B-679-10 a client whose customer already has a default card and a trial package can start the
  plan: no SETUP_UNAVAILABLE on a first or a later attempt" and "Opus B-678-2 the generic default-card update carries the trial-end
  lift: a default-card update on a paid plan never touches cancel_at_period_end". Treat both as findings: verify, fix (#678 for
  B-678-2), and make those probes pass.
- Replay every prior probe from both lenses on #678/#679 (threads + audit/* branches) and do the money self-check (_COMMON_118 6).
- If notify/fees.txt shows a new fees top while you work, merge it into #678 then #679 (merge-only) before your final push.
- When #678 and #679 are READY at green heads: write notify/recur.txt "recur R2 top: #679 @ <sha> (B-RECUR6A-118, <time>)", release
  the lock, END. Do not touch #680/#696/#701.
Report: ops/reports/B-RECUR6A-118.md.

## AUD-OPUS-T23-118 (Claude Opus 5.5) / AUD-SOL-T23-118 (GPT-6.1 Sol) — trials T2 #672 and T3 #673
#672 @ c5e7ed8e35f1e5b88653e5605dded2af8614182d (FIX ROUND 8 READY 5977736892; 2,977 lines), #673 @
df76889fb862095170498dccb23f35db3d116690 (FIX ROUND 8 READY 5977778572; 2,627 lines over T2). Base T1 #671 c75002c9 has dual APPROVE.
Prior at 6ce54002: Opus APPROVE 0/0/6, Sol RC 0/2/1 (B-672-3 superseded trial warnings; B-672-4 email requests across timeout/retry).
Decide your lens's prior findings first, then audit both rounds deeply. The builder says two Opus probes stay red by design (C-672-7
date wording per the ruling "Oct 13 at 12:30 AM EDT"; C-671-4 direct view probe because T1 is unchanged and T3's writer holds the
contract): Opus decides that with evidence. Binding: real free trials (coach sets 0-30 days, card up front, one per client per coach,
trial-ending notice), MRR/churned_30d exclude never-billed trials. Landing context: trials land after recurring (#678-#701) and carry the
C-656-1 #680 integration list then; mobile #338 pairs. Findings about recurring code go to your report, not to these PRs.
Reports: ops/reports/AUD-OPUS-T23-118.md, AUD-SOL-T23-118.md.

## B-CM4-118 (builder, Claude Opus 5.5, T4) — coach Money M1 #674 + M3 #676 (+ M4 #677 merge-only/test move): FINISH B-CM3-117's round
B-CM3-117 died after pushing, before any comment. A push with no FIX ROUND comment is unfinished work: trust nothing until checked.
Pushed: #674 39653f80 (fcf640ed tests B-674-11 fair chargeback sweep + B-674-12 one first close; a1d6a9a7 fix; 39653f80 moves
refund-reversal-boundaries spec to #677 for size); #676 fbd6402c (c2524b2a restack merge; b1775673 test B-676-3; fbd6402c fix: tax
CSV rows from refund and chargeback events); #677 ed1546b6 (211e0eb5 restack; e9db27d7 spec moved, byte-identical; ed1546b6 service
mock answers chargeRefund.findMany). Failing-before lane runs it left: ci/B-CM3-117-674-before (runs 37186748565, 37186763956),
ci/B-CM3-117-676-before (run 37187188812).
Findings to close (read every comment): Sol RC 0/2/2 on #674 at 5bbcc92a (5977398163); Sol RC 0/1/1 on #676 at 54e61566 (5977398126);
earlier Opus RC on #674 (5976743131) and #676 (5976743259) were answered by FIX ROUND 2: confirm each closure. #677: Opus APPROVE 0/0/1,
Sol APPROVE 0/0/1 (older heads). Do: verify every pushed commit against its finding's fix rule and counterexample (owner-only authz,
reversal idempotency, coach-visible money equal to the ledger to the cent, MRR rule); check the failing-before runs fail for the
stated reason and the after runs pass; fix any gap; replay prior probes; money self-check. Sizes: #676 2,981 and #677 2,918 lines:
stay under 3,000. Post FIX ROUND 3 on #674 and #676 and a merge-only/test-move FIX ROUND on #677, each + READY at green heads.
Report: ops/reports/B-CM4-118.md.

## AUD-OPUS-FU1-118 / AUD-SOL-FU1-118 — #698 (data export order + keyset paging) and #699 (SBOM dependency check fails closed)
#698 @ ecf8da57 (base main; READY; 467 lines): deterministic latest request (tiebreaker) and keyset export pages (>500 rows could repeat
or miss). T4: privacy export completeness. #699 @ 40ce1757 (base main; READY; 221 lines): CI gate (T4: enforcement boundary; prove it
fails closed with a negative case). Reports: ops/reports/AUD-OPUS-FU1-118.md, AUD-SOL-FU1-118.md.

## AUD-OPUS-FU2-118 / AUD-SOL-FU2-118 — #700 (no emails/names/free text in logs; Apple steps iOS 18+) and mobile #368
#700 @ 66569a61 (base main; READY 05:57 PDT; 936 lines; T4 PII/logging + public privacy text). mobile #368 @ 2216ad1d (base main;
112 lines; DeleteAccountScreen "Apple Account" name and iOS-version-accurate steps). Every public sentence must be true of the code
and of Apple's current flow; the backend policy text (#611, live) and the mobile copy must say the same thing. Reports:
ops/reports/AUD-OPUS-FU2-118.md, AUD-SOL-FU2-118.md.

## B-SHEET-118 (builder, Claude Opus 5.5, T4) — mobile payment sheet P1 #342 + P2 #343 (+ P3 #344 merge-only restack)
Heads: #342 72821495 (base main, BEHIND), #343 af984441, #344 f629e0f9. Lands with recurring (backend #678-#701) and must work
against today's production backend too (guide rule 5: capability check or truthful fallback). Findings: #342 Sol RC 0/2/1
(mobile 5976926407), Opus RC 0/1/3 (5977006434; B-342-1 "nothing was charged" copy on unconfirmed codes); #343 Sol RC 0/5/0
(5976959713), Opus RC 0/1/2 (5977006549; B-343-1 "Payment received" before proof). Also map #661's reply codes (backend #661 @
c7649169 FIX ROUND 7 lists them) and the recurring codes (PLAN_CHANGE_UNCONFIRMED, SETUP_UNAVAILABLE, trial setup) to specific,
truthful copy with a working next action. Copy truth is the core: never claim charged/not charged/paid before proof. Recurring is
never one-time-only. Bring #342 up to main (merge-only) first. Restack #344 merge-only. FIX ROUND + READY on each at green heads.
Report: ops/reports/B-SHEET-118.md.

## AUD-OPUS-D12-118 / AUD-SOL-D12-118 — dunning D1 #687 and D2 #688
#687 @ f8e47bf4 (base main, BEHIND; FIX ROUND 1 READY), #688 @ b17f514c (FIX ROUND 2 READY). Prior at c2a901a8 (#687): Sol RC
(5975856225), Opus RC (5975919378); at 6627044c (#688): Sol RC 0/5/0 (5975856430), Opus RC 0/1/4 (5975919515). Decide each prior
finding (closing commit + failing-before test), then audit both heads deeply. Binding dunning rulings: retries Days 1/3/7; Day-10
lockout; 1A card update during dunning auto-charges the open invoice and unlocks on success; 2A cancel during dunning voids the invoice
and ends access now; voluntary cancel keeps access to period end; free/code grants never enter dunning. Check the D1 email copy "your
access stays on" against the Day-10 lockout (copy truth). Never-entitled check is unified by dunning (lands second vs #654/#628).
Reports: ops/reports/AUD-OPUS-D12-118.md, AUD-SOL-D12-118.md.

## B-WIZ-118 (builder, Claude Opus 5.5, T4: Stripe Connect onboarding, money setup) — mobile coach setup W1 #345 + W2 #346 (+ W3 #347 restack)
Heads: #345 a4e49588 (base main, BEHIND), #346 4522eb8e, #347 ea2c72d1. Findings: #345 Sol RC 0/3/0 (mobile 5976946494), Opus RC
0/2/3 (5977036236; B-345-1 cadence change dropped; B-329-5 create after unmount/account change); #346 Sol RC 0/2/1 (5976966221),
Opus RC 0/2/3 (5977036337). Must work against today's production backend (coach backend #674-#677 is not deployed yet: capability
check or truthful fallback). Bring #345 up to main (merge-only) first; restack #347 merge-only. FIX ROUND + READY at green heads.
Report: ops/reports/B-WIZ-118.md.

## AUD-OPUS-661-118 (Claude Opus 5.5) / AUD-SOL-661-118 (GPT-6.1 Sol) — #661 PaymentSheet + #702 (its tests-only piece)
#661 @ f80f0088c98cd078cffa5dd217a8fdc84ad631b2 (base main; 2,843 lines) and #702 @ 20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb (base
#661's branch agent/clinic/b-secrets-3; 513 lines). They land as one (rule 11). Operator FIX ROUND 8 moved one whole spec byte-identical
from #661 to #702 for size (B 5982239187, 5982239336); integrated tree unchanged from 5c25122d. Content statement: FIX ROUND 7
(5977850515) closing Sol B-661-3 (Sol RC 0/1/0 at c7ee15f0, 5977638148: ten never-activated rows hide the activated owner); #702
OPENING (5977876193). Opus's last APPROVE is old (957e3677). Dead Sol lens AUD-SOL-661R6-117 left probes on
audit/AUD-SOL-661R6-117/{661-selection,661-native-selection,661-native-verified}. Binding: hosted Checkout activates only via
checkout.session.completed; #661 also edits .github/workflows/ci.yml (CI gate, T4). Required checks may still be running when you start:
re-check them and the head right before posting. Recurring and the mobile sheet depend on #661's reply codes: name them in your report.
Reports: ops/reports/AUD-OPUS-661-118.md, AUD-SOL-661-118.md.

## QUEUED (operator launches as slots free, in this order)
B-RECUR6B-118 (#680 + #696/#701 after B-RECUR6A ends; dead Sol lens AUD-SOL-R34R5-117 probes on audit/AUD-SOL-R34R5-117/680-authority,
run 37187197172: B-680-2 residual, B-680-5 x2); fees lens pairs (F2+F3, F4+F4b,
F5+F6 deltas) after B-FEES15; recurring lens pairs after B-RECUR6B; coach pair after B-CM4; sheet pair after B-SHEET; AUD pairs D34
(#689/#690) and D5 (#691 + #642); HC pairs H2+H3, H4+H5, H6 (mobile #360-#364); B-LOCK (mobile #352/#353); wizard pair; N1-N4.
