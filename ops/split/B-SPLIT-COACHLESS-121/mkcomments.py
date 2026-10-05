#!/usr/bin/env python3
"""Writes comment_<pr>.md for each piece and superseded_657.md. Usage: mkcomments.py <evidence.json>
evidence.json: {"<pr>": {"head": sha, "ci": "text", "local": "text"}, "_lane": "text"}"""
import json, sys
ev = json.load(open(sys.argv[1]))
pieces = {
  "721": (1, "migration 20270301000000_coachless_featured_coach + down.sql, schema.prisma (3 models + back-relations), account-deletion manifest decisions (main-merge resolution 4), live RLS spec + its rls-live-tests step (resolution 3)", 797),
  "722": (2, "FEATURE_COACHLESS_HOME (ENV_RULES, fly manifest unset, runbook row: resolutions 1-2), feature-flags key coachless_home (students only), errors, guard, coach-code lookup, featured-coach config service, Roman card prompt service, Home service, home spec, fixture variant", 1290),
  "723": (3, "idempotent coach-code redemption service (resolution 5: describeFailure in two log calls), DTOs, controllers (/coachless/*, /admin/featured-coach), module + app.module, README, redemption spec, fixture restored to the M file", 1113),
}
money = """Money list self-check (stack-wide; this stack moves no money and opens no checkout):
- webhook order/redelivery: n/a (no webhook code). Redeem replay: one CoachCodeRedemption row per (user, Idempotency-Key); a completed key replays the stored response (`replayed: true`); the same key with another code is 422 `idempotency_key_reused`.
- concurrency/lock order: claim = INSERT on the (user_id, idempotency_key) unique; a losing duplicate polls the winner then replays or answers 409 `redemption_in_progress`; failed or stale (>60 s) claims are reclaimed by a conditional updateMany (exactly one retry wins). The only writer of User.coach_id stays `InviteCodesService.attachUserToCoachByCode` (unchanged; conditional attach, no re-parenting), so a double execution after a stale reclaim answers already_attached for the same coach and takes no second seat. Featured config save: audited in the same transaction, cache invalidated.
- terminal states: completed rows replay; failed rows are retryable; erasure removes the user's ledger and prompt rows, ledger rows naming an erased coach, and detaches the featured coach / editor (manifest, split 1/3).
- pagination/completeness: no lists returned; packages_available is a count of the coach's active, unarchived packages.
- currency/minor units: featured package is passed through from CoachPackage (amount_cents, currency) with no arithmetic.
- copy truth: COACHLESS_ERROR_MESSAGE says what happened and the next step; no first person, no emojis, no exclamation marks; mobile maps `code`. Flag off: every client route answers 404 `coachless_disabled`."""
for pr, (k, contents, size) in pieces.items():
    e = ev[pr]
    body = f"""FIX ROUND 1 (OPENING, B-SPLIT-COACHLESS-121, agent 121) — growth-project-backend#{pr} @ {e['head']}

COACHLESS split {k}/3 of #657 (A1-COACHLESS: coachless Home, featured coach, coach-code redemption). Split only: no behaviour change beyond the main-merge resolution (PR body items 1-5). Size {size:,} changed lines (under 1,500).
Contents: {contents}.
Stack: #721 (base main) <- #722 <- #723. Land as one stack, bottom-up (A5 rule 11). Top tree of #723 == reference M `f3f0d659` tree `0279a4f54646f0a9e4bc70b45e1a28ec424faae8` (branch agent121/coachless-split-0-merged-reference).

| Finding | Change | Commit | Test |
|---|---|---|---|
| none (opening; #657 was never reviewed) | split + main-merge resolutions in the PR body (each in the piece that owns the file) | {e['head'][:8]} | evidence below; full suite in this PR's CI |

Prior probes from both lenses: none exist for #657 (no AUDIT comments, no ops/aud-*/ notes for it); nothing to replay.
Local (ops/heavy.sh, one at a time): {e['local']}
{ev.get('_lane','')}

{money}

CI at this head: {e['ci']}

Overlap rule with #658: whichever of this stack and #658 lands second maps #658's code_revoked / code_expired / code_exhausted in ATTACH_TO_COACHLESS (src/coachless/coach-code-redemption.service.ts:46-53, split 3/3).
Operator decisions (report ops/reports/B-SPLIT-COACHLESS-121.md): D1 migration name kept (default keep), D2 CoachCodeRedemption.coach_id erasure = delete (default delete).

READY FOR AUDIT
"""
    open(f"comment_{pr}.md", "w").write(body)
sup = f"""SUPERSEDED (B-SPLIT-COACHLESS-121, agent 121) — growth-project-backend#657 @ c25960a8b82ed4dd6bea0b7da9f1d77ce783078d

This PR (3,184 lines, over the 3,000 ceiling and never reviewed) is split into three pieces under 1,500 lines each (owner A1.2):
- #721 COACHLESS split 1/3 (base main) @ {ev['721']['head']}: schema, migration, RLS live suite, erasure decisions (797)
- #722 COACHLESS split 2/3 (base #721) @ {ev['722']['head']}: flag, errors, featured coach, Home and Roman card services (1,290)
- #723 COACHLESS split 3/3 (base #722) @ {ev['723']['head']}: idempotent coach-code redemption, routes, module (1,113)

Main 5da537d6 was merged once (reference agent121/coachless-split-0-merged-reference @ f3f0d659): three union conflicts (fly manifest, launch-flags runbook, ci.yml) and two semantic resolutions required by main's gates (erasure manifest decisions for the three coachless tables; describeFailure in two redemption log calls). Top tree of #723 == tree of f3f0d659. Review and land the split stack; this PR stays open (not closed) per the operator rule and should not be merged.
"""
open("superseded_657.md", "w").write(sup)
print("ok")
