# AUD-OPUS-INV3-121 — Claude Opus 5.5 lens, agent 121 wave (invite codes #658, then MSG3 #708-#711)

Started 12:38 PDT 10-05. Claim: ops/lanes121/claims/backend-658-4de7a6dc-opus. Notes/probes: ops/aud-121/AUD-OPUS-INV3-121/.
Worktree: /home/user/workspace/wt/AUD-OPUS-INV3-121-1 (detached at 4de7a6dc + local probe commit 3c4c49da, never pushed to the PR).

## Part 1 — b#658 @ 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0 (base main, behind 29; 2,960/3,000; merge-tree with main 5da537d6 clean)
- Prior Opus RC 5964473420 @ 08534e17 (A0/B1/C4). FR1 5999613642 (B-INV2-120).
- CI at head: all required checks green (build-and-test, community-live-tests incl. coach-code-tools.live, rls-live-tests, schema parity,
  forward + reversible migrations, CodeQL, danger, npm audit, rls-floor-guard, mwb-3-live-tests, banned casts, sbom).
- Own prior findings:
  - B-658-1 CLOSED (code + failing-before run 37346038154 + live proof). create writes coach_id = head, invited_by = sub; list/rotate/
    revoke/signups scoped by owns()/rowWhere()/ledgerWhere(); no team coach link for a sub (403); head manages all team codes.
  - C-658-2 CLOSED (manifest del entries; coverage spec green). C-658-5 malformed key CLOSED; replay-during-binding CLOSED (via B-658-6).
  - C-658-3, C-658-4, C-658-5 (owner profile) open as follow-ups (FREEZE), unchanged.
- NEW B-658-9 (introduced by the B-658-1 fix): an active sub-coach can bind the HEAD coach's package (free/prepaid) to a code via
  POST /coach/codes (coach-code-tools.service.ts:289-296 assertBindablePackage(scope.tenantId, ...)); every signup gets the head's paid
  package at amount_cents 0. On main the only binding path (InviteGrantService.setBinding :321-328) refuses a sub-coach (404), and all
  financial surfaces refuse active sub-coaches (common/guards/no-active-sub-coach.guard.ts). The head's unit test asserts the escalation
  (test/coach-code-tools.service.spec.ts:608-613 "the head coach's package").
  Fix rule: in create(), if scope.issuerId && (input.package_id || input.grant_mode) -> 403 code_package_head_coach_only (no row written),
  before assertBindablePackage; regression test (sub-coach + head package -> 403, 0 rows; head unchanged). Optional same guard is not
  needed in rotate (successor copies a binding only the head could set).
- Probe lane: audit/AUD-OPUS-INV3-121/658-1 run 37365771761 (pushed 12:48:38, queued in the Actions incident).
  Specs: test/aud-opus-inv3-121.probe.spec.ts (P1 expected FAIL, P2/P3/P4 pass) + coach-code-tools.service, controller,
  invite-attach-ledger, erasure-manifest-coverage.

## Follow-ups (C)
- C-658-3 / C-658-4 / C-658-5 (owner) / C-658-8: as in ops/reports/B-INV2-120.md (file:line and fix rule there), still open.

## HANDOFF
- In progress: waiting for lane 37365771761, then post the #658 verdict (REQUEST CHANGES A0/B1) unless the lane contradicts P1.
- Then MSG3: poll b#708-#711 comments every 5 min (max 60 min) for B-MSG-FIN-121 FIX ROUND 2 READY FOR AUDIT at the current heads.
