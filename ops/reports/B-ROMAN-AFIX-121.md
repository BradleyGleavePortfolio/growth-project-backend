# B-ROMAN-AFIX-121 (agent 121) — Roman A1 #667 + A2 #665 FIX ROUND 1

Written 2026-10-05 13:51 PDT.

## Result
- #667 head c5102cae659f87a4487a5756c52e8ab303664968 (was bacd83e1). FIX ROUND 1 + READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6002677425. Size 2,387/3,000.
- #665 head 4dde3ffed2f21937bc036203eb90afc0d84ecd5e (was eb7cb7a8; two pushes this round: 98cfac55 at 13:31 Sol fixes, 4dde3ffe at 13:47 Opus fixes per operator 13:37). FIX ROUND 1 + READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6002677821. Size 2,992/3,000 (no room left).
- Fixed: Sol B-667-1/2/3, B-665-1/2/3/4; Opus draft B-667-1 (= Sol B-667-2), B-665-1 (= Sol B-665-1), B-665-2 (lockout), B-665-3 (sub-coach). Open Bs: none known.
- Evidence: local heavy.sh failing-before ops/reports/B-ROMAN-AFIX-121-local-before.txt; after ops/reports/B-ROMAN-AFIX-121-local-after.txt (184/185; the red is Sol C-665-1, deferred C). Comment bodies: ops/reports/B-ROMAN-AFIX-121/c667.md, c665.md.
- CI: PR CI queued at both heads (runner incident). Lane ci/B-ROMAN-AFIX-121-2 run 37371944893 (Sol + Opus probes + specs at 4dde3ffe) queued; branch kept for that evidence. Lane 1 (37369979538) cancelled, branch deleted.

## Follow-ups (C)
- C-667-1 docs/roman-client-context.md lines 1, 29-31, 55-56 (ctx-v2, CoachingSession "never read", endpoint text) and roman-client-context.types.ts:311-317 (C05 sentence). Rule: doc states shipped behaviour.
- C-665-1 roman-client-context.service.ts:248-257,293-299 memo holds 501 after insertion. C (edge, deferred to 10k clients). Rule: evict before insert.
- Blocked coach's messages in Roman context (service coachMessage read). C (edge, deferred; operator 13:37). Rule: apply MessagingService.filterBlockedAuthors.
- Opus C-665-2 roman-context-invalidation.ts:7-9 comment overstates callers. Rule: wire or correct.
- Opus C-665-3 simple macro display: carry macro_display_mode.
- UTC ymdOf still used for coach message, community post and macro effective_from labels. Rule: use localDateOf.
- Sub-coach messages labelled 'coach' under the head coach first name (copy precision).

## Operator decisions
- Accept ROMAN_CONTEXT_MAX_QUERIES 16 -> 17 (sub-coach overlay read in parallel with Q1). Default: accept.
- Accept the 13:31 Sol push ~3 minutes before the 40-minute mark (two pushes on #665 in one round, per 13:37 order). Default: accept.

## HANDOFF
- Heads: #667 c5102cae659f87a4487a5756c52e8ab303664968, #665 4dde3ffed2f21937bc036203eb90afc0d84ecd5e. Both READY FOR AUDIT; next: Sol RA + Opus RA re-review at these heads (re-review rule: prior Bs fixed + changed lines).
- B-ROMAN-BFIX-121 merges #665 4dde3ffe into #666; conflicts possible in test/roman/roman-client-context.spec.ts and test/roman/fixtures/roman-personas.ts (subCoachOverlays + subCoachAssignment delegate added).
- Coach-pool debit and per-client daily cap stay with #668 (BFIX).
- Left: CI at both heads and lane 37371944893 still queued; delete ci/B-ROMAN-AFIX-121-2 after it completes. Roman lock released; worktrees removed.
