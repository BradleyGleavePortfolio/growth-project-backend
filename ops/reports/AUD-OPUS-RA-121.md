# AUD-OPUS-RA-121 (Claude Opus 5.5 lens, agent 121) — Roman A1 b#667 + A2 b#665 first full review (T4)

Started 12:41 PDT 2026-10-05 (from `date`).
Heads: b#667 bacd83e10ff0e00dc5165dd223da8b4745e3c82a (base main d23fa317, 296 behind, draft, 1,832), b#665
eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5 (base #667, draft, 2,282). Claims: ops/lanes121/claims/backend-667-bacd83e1-opus,
backend-665-eb7cb7a8-opus. Notes/probes: ops/aud-121/AUD-OPUS-RA-121/. Worktrees: wt/AUD-OPUS-RA-121-665 (read),
wt/AUD-OPUS-RA-121-lane1 (probe lane).

## Status
- 12:41 claimed, read _COMMON_121, entry, SoT A1/A6/A9.1/A9.2 Roman, #651 Opus RC 5964857917 + Sol RC 5964898255 (history),
  B-SCHED-ROMAN-115 report, both PR bodies.
- 12:56 probe lane pushed: audit/AUD-OPUS-RA-121/665-1, run 37366663415 (queued; GitHub runner incident). Specs: probe +
  roman-client-context + roman-context-round2 + dunning lockout route table, plus tsc.
- Main merge: `git merge-tree --write-tree origin/main eb7cb7a8` is clean (121a70d4); none of the APIs the pieces use changed on main
  since d23fa317 (consultation-view, consultation-answers, orm-diagnostics, sanitize-prompt-input, client-ai-context, src/roman); the
  schema delta since d23fa317 is money-only.
- PR CI at both heads: all checks green (10-03 runs).

- 13:19 lane still queued 22 min -> item 11: single probe spec via ops/heavy.sh (13:20); it waited for a slot (3 slots busy).
- 13:35 HEADS MOVED before posting: #667 bacd83e1 -> c5102cae659f87a4487a5756c52e8ab303664968 (FIX ROUND 1),
  #665 eb7cb7a8 -> 98cfac5563ca6c78505477a3c59b0d65d8eb0def (FIX ROUND 1 + merge of A1). Per _COMMON_121: stopped both PRs,
  NO verdict posted. Lane run 37366663415 cancelled (never started), heavy.sh job stopped before it ran (no probe results exist),
  worktrees removed, audit/AUD-OPUS-RA-121/665-1 deleted, claims marked released. Sol's comments on #667/#665 were not read.
- 13:33 operator mail (owner 13:29 edge-case freeze) applied to the classification below.

## Findings at the OLD heads (never posted; code-reading counterexamples, probes never ran)
#667 @ bacd83e1: A0 / B1 / C1
- B-667-1 roman-consultation.source.ts:85-88: `completed = any screening item answered`. A PATCH-saved intake with P1=no and P2..P7
  unanswered reads completed:true, clearance:false, so the contract's conservative rule for an unanswered screen
  (roman-guardrail.contract.ts:47 in #666/#668) never fires. Fix: completed only when every SCREENING_KEYS item is yes/no (or the
  intake's completed_at is set); partial = completed:false. Probe B-667-1.
- C-667-1 docs/roman-client-context.md: ctx-v2 (code ctx-v3), "Never read: CoachingSession" (bookings read a narrow select), no
  upcoming_sessions row, consultation row says C05 not landed; types.ts:311-317 same stale C05 comment.
#665 @ eb7cb7a8: A0 / B3 / C3
- B-665-1 roman-client-context.service.ts:546-562 + 1198-1219: wearable samples from every connected provider are summed/averaged
  together (provider not even selected). Main's policy (ingestion.service.ts:180-246 resolveBest; WearableSample comment
  "cross-provider overlap ... resolved at read time"): preferred provider per metric, else most recently recorded. Apple Health +
  Oura gives 12.6 h last night instead of 6.3 h, 12,200 steps instead of 6,100. Fix: select provider + recorded_at, apply the same
  precedence per metric before aggregation (preference rows via one query or the Q1 user select).
- B-665-2 roman-context.controller.ts:37-50 + test/dunning-v2-lockout-allowlist-route-table.spec.ts:178: GET /roman/context/me sits
  under the guard's `/roman/*` carve-out (dunning-lockout.guard.ts:91,211-214, "so Roman can explain the lockout") and returns the
  coach's plan, meal plan, guidelines, targets and coach messages to a locked-out client. The spec header forbids pasting a path in
  without answering "may a locked-out, non-paying client call this?". Fix: keep the route locked (exact carve-out in the guard, drop
  the spec line, guard test), or operator ruling. Probe B-665-2.
- B-665-3 roman-client-context.service.ts:407-413, 489-501, 503-512, 780-788: coach-owned rows are filtered to the HEAD coach, but
  delegated sub-coaches send with sender_id = sub-coach in the head-coach thread (messaging.service.ts:296-323, 746-747) and assign
  workouts as themselves (program-delivery.service.ts:225). Roman drops those messages and that plan ("no plan") for a delegated
  client. The same read also ignores the client's block list (messaging.service.ts:389-403), so a blocked coach's messages come
  back through Roman and the disclosure route. Fix: read the thread as MessagingService does for the client (any sender in the
  head-coach thread, minus a blocked other party); accept plan/meal-plan rows from the head coach or the open SubCoachAssignment
  sub-coach. Probes B-665-3.
- C-665-1 :560 `take: 600` desc silently cuts the oldest local day(s): partial sums reported as full days. Fix: aggregate per
  metric/day in SQL, or drop a day the cap cut into and record it in data_quality.truncated.
- C-665-2 roman-context-invalidation.ts:7-9 says macro-target and profile writes call the hook; nothing does (only
  client-ai-context). Bounded by the 15 s TTL. Fix: wire or correct the comment.
- C-665-3 macro "simple" display (macros.service.ts:135-150, 7 days calories + protein only when N4 = never): Roman's context
  carries carbs/fat regardless. Fix: carry macro_display_mode so the contract follows the app.
Prior findings closed (verified in code): B-651-10 (coded 503/500, specific copy, sanitized logs), C-651-4 (evict on lookup, 500 cap,
generation pruned; fence still holds), C-651-7 (service header).

## Day-1 coach pool debit + client daily cap (entry requirement)
- No CoachAIBudget / recordUsage / ai-credits reference in src/roman at #667, #665, #666 0ec835ca, #668 fabc2268, #669 6386c00b, #670
  fb671019, or the C2 source branch agent115/roman-651-r2-wip-unsplit. The turn path (provider call roman.service.ts:1014,
  reserveDailySpend :978/:1224, settleSpend :1041/1057/1096/1102) is in #668: missing coach-pool debit = B on #668 (RB lens pair /
  B-ROMAN-C2 builder).
- Client cap: per-client turn limit exists on main (assertWithinRateLimit, 50 free / 500 pro user turns per rolling 24 h,
  constants ROMAN_RATE_LIMIT_FREE_PER_DAY/PRO_PER_DAY, not env; 429; controller #668 :119). The "daily cap" #668 adds
  (assertDailyCapacity :1183, reserveDailySpend :1224; env ROMAN_DAILY_COST_CAP_USD default 25) aggregates ALL users' Roman spend
  (where: capability only): a platform kill switch, not a per-client cap. Mapping its 503 ROMAN_CAPACITY_REACHED to "You've used
  your maximum AI allotment today." would be false copy for clients who used nothing.

## Where these stand at the NEW heads (quick code check only, not a verdict)
- B-667-1 (partial screen = completed): addressed in c5102cae (commit: "complete screen needs all seven answers").
- B-665-1 (providers summed): addressed in 98cfac55 (per-metric preferred provider read, service.ts:376-379).
- B-665-2 (GET /roman/context/me reachable while dunning-locked): NOT addressed (spec line 178 still lists it; guard unchanged).
  Under the 13:29 rule: a locked user can call it on purpose and read the coach's paid program = still B (money given away),
  operator may rule otherwise. Recommended default: keep it a B, fix = exact deny for roman/context in the guard.
- B-665-3 (sub-coach rows dropped): NOT addressed (service.ts:564/874 still sender_id in [head coach, client]). Delegated
  clients are normal use for team coaches: Roman says "no plan" / misses the sub-coach's messages = false customer-facing claim
  = still B. The blocked-coach half is reclassified "C (edge, deferred to 10k clients)".
- C-667-1, C-665-1..3 stand as C (C-665-2 is edge: deferred).

## Cross-PR notes for the operator (not findings on #667/#665)
- #668: with /roman/* allowed while locked, a locked client's Roman turn is grounded with the full coach plan/meal plan via the
  context; the turn path should drop coach-owned blocks for a locked caller (RB pair).

## Follow-ups (C)
- C-667-1 docs/roman-client-context.md + types.ts:311-317 stale (version, CoachingSession, upcoming_sessions, C05). Check at c5102cae (doc was touched).
- C-665-1 wearable `take: 600` silently cuts the oldest day(s).
- C-665-2 invalidation comment vs wiring (15 s TTL bounds it) — C (edge, deferred to 10k clients).
- C-665-3 simple macro display mode not carried into Roman's context.
- C (edge, deferred to 10k clients): blocked coach's messages resurface via Roman / disclosure route (part of old B-665-3).

## HANDOFF
- No verdict posted on #667 or #665 by this lens: both heads moved at ~13:35 PDT while the probe lane was still queued.
- New heads need a fresh Opus lens re-review: #667 c5102cae659f87a4487a5756c52e8ab303664968, #665
  98cfac5563ca6c78505477a3c59b0d65d8eb0def. Carry B-665-2 and B-665-3 (sub-coach part) as the open items to check;
  probe file ready: ops/aud-121/AUD-OPUS-RA-121/probes/audit-opus-ra121.probe.spec.ts (B-665-2 and B-665-3 blocks apply as-is;
  B-665-1 block's persona rows may need `recorded_at`).
- Day-1 coach-pool debit missing in #667-#670 (B on #668 turn path); #668's "daily cap" is global, not per client.
- Verdict drafts (old heads, unposted): ops/aud-121/AUD-OPUS-RA-121/verdict-667.md, verdict-665.md.
- Cleanup done: worktrees removed, audit branch deleted, lane run cancelled, claims released.
