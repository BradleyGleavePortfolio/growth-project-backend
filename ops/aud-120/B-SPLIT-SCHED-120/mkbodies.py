#!/usr/bin/env python3
"""Generate PR bodies for the S-SCHED-2 split (B-SPLIT-SCHED-120, agent 120).
usage: mkbodies.py <stack-json or ''>   (stack json: {"1": 712, ...}); writes body_<k>.md next to this file."""
import json, os, subprocess, sys

WT = "/home/user/workspace/wt/B-SPLIT-SCHED-120-2"
OUT = os.path.dirname(os.path.abspath(__file__))
M = "6fc88c457b917d74773f881ffed60c9d3f8d9d35"
TREE = "0595cfd70254cde577bf1cc3a844fa0c179c1d20"
MAIN = "ee55f814eb02b530e6578a168dc16c7ea7e2b07b"
SRC = "e18e8055454b04856d2c5ab5568d0a7127b74939"
U = "https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-"
stack = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}

BR = {
    1: "agent120/sched-split-1-foundation",
    2: "agent120/sched-split-2-test-infra",
    3: "agent120/sched-split-3-emitter",
    4: "agent120/sched-split-4-lifecycle",
    5: "agent120/sched-split-5-reminder-job",
    6: "agent120/sched-split-6-service-api",
    7: "agent120/sched-split-7-integrity-tests-a",
    8: "agent120/sched-split-8-integrity-tests-b",
    9: "agent120/sched-split-9-integrity-tests-c-live",
}


def git(*a):
    return subprocess.run(["git", "-C", WT] + list(a), capture_output=True, text=True, check=True).stdout


def sha(k):
    return git("rev-parse", BR[k]).strip()


def base(k):
    return "origin/main" if k == 1 else BR[k - 1]


TOP = sha(9)

P = {
    1: dict(
        title="feat(scheduling): schema, migration, types, diagnostics, slot rules and access",
        why="Persistent schema migration (booking revision, lifecycle and reminder delivery-state columns, the no-overlap exclusion constraint with its range preflight) and the new client read gate on open slots (SchedulingAccessService).",
        t4="Read-access change: YES (open slots: a client sees only the head coach or an active sub-coach assignment; SchedulingOpenSlotsService builds its own SchedulingAccessService when none is injected, so the gate is live from this piece). RLS/tenancy: no new table; SessionType, CoachingSession and NotificationDeliveryLog keep their enabled and forced RLS. Money/auth/PII: no. CI gate file: no.",
        t3="Schema migration: YES (20270222000000_scheduling_lifecycle_integrity, additive, with down.sql; byte-identical to M). Concurrency: the exclusion constraint is the floor that 4/9 maps to 409. Routes: no.",
        live="Live in this piece: the open-slots access gate and bookable-aware slot computation. Inert until later pieces: the new columns (4/9-6/9), the new types and DTO fields (6/9), the new notification kinds and orm-diagnostics helpers (3/9-5/9).",
        inter=None,
        tests="tsc clean; log-diagnostic-closed-enum 12/12, slot-computer-bookable 7/7, slot-computer 14/14, availability-overrides 10/10, scheduling.service (main's spec) 12/12, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, entitlement-guards-mounted 17/17, scheduling-providers 7/7, no-pii-in-logs 11/11, scout-diagnostics-boundary 33/33, booking-emitter 10/10, booking-reminder.job 20/20, booking-reminder-local-time 8/8, notification-emitters 29/29.",
        res="R1 (schema) lives here; the migration's semantic follow-through (no session_start_at column) too.",
    ),
    2: dict(
        title="test(scheduling): in-memory scheduling DB, service spec harness, seed script",
        why="Test infrastructure for the T4 stack: the in-memory Prisma double that models the per-coach advisory lock and the no-overlap constraint, which every later piece's specs run on.",
        t4="Read-access/RLS/money/PII/CI gate: no (tests and a development seed script only).",
        t3="Schema/routes/concurrency: no production code. The fake reads migration 20270222000000 (1/9) for the constraint shape.",
        live="No production code changes. scripts/seed-coach-session-types.ts is a development seed script (not run by the release).",
        inter="test/scheduling.service.spec.ts is the merged S-SCHED-2 spec except three cases that assert only what holds both before and after the lifecycle piece: \"cannot transition from completed back to scheduled\" and \"cannot cancel a completed session\" assert refusal (HttpException) plus status still `completed` (4/9 restores the 409 ConflictException form); \"rejects availability windows where end_minute <= start_minute\" asserts BadRequestException without the code (6/9 restores `INVALID_TIME` and the \", with a code\" title). The two `meeting_link_status` assertions arrive in 6/9 with the session view.",
        tests="tsc clean; scheduling.service 13/13 (on main's lifecycle and service), seed-coach-session-types 7/7.",
        res="R7 (service spec, main's \"reschedule never deletes claims\" kept against the fake) and the fake-db follow-through (start_at required, 4-column duplicate key, `$queryRaw` FOR SHARE counter, zone delegates) live here.",
    ),
    3: dict(
        title="feat(notifications): booking emitter with push, tap targets and local-time copy",
        why="Shared notification primitive rewrite (BookingEmitter): every booking event writes one in-app row and sends a real push with tap routing; user-facing copy (copy truth) and recipient time zones.",
        t4="Read-access/RLS/money: no. PII: copy and payloads carry no free-form error text; the emitter's no-pii legacy baseline entry is removed (count now 0). CI gate file: no.",
        t3="Shared notification primitive: YES. Schema/routes: no.",
        live="Live in this piece: booking notifications from main's lifecycle and reminder job go through the new emitter (one in-app row plus push, zone via main's resolveRecipientTimeZone, no clock time without a usable zone).",
        inter="src/scheduling/jobs/reminder.job.ts line 123: the emit callback type widens from `Promise<void>` to `Promise<unknown>` (the new emitter returns a delivery result); 5/9 replaces the whole job with M's version. test/booking-reminder-local-time.spec.ts keeps main's world and takes the S-SCHED-2 wording without the call-link sentence (main's job does not pass the link state); 5/9 brings M's version with the call-link sentence.",
        tests="tsc clean; booking-emitter 21/21, booking-reminder-local-time 8/8, booking-reminder.job 20/20, notification-emitters 29/29, no-pii-in-logs 11/11, scheduling.service 13/13, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, log-diagnostic-closed-enum 12/12, lockscreen-privacy 18/18, push-preference-defaults 16/16, notification-timezone-provenance 8/8, notification-local-time 11/11, billing-payout-failed 7/7, coach-new-purchase-prefs-routing 3/3, notification-prefs 15/15, purchase-fanout-coach-new-purchase 5/5, s-fee-r5-or-111-1 22/22, first-payment-throttle-rollback 3/3, drip-dispatcher.cron 32/32.",
        res="R4 (emitter: main's zone rules, constructor (notifications, prisma), no-zone copy variants, 24h body names the date, `tz` required) and R5 (emitter spec, main's B-643-1 cases ported) live here.",
    ),
    4: dict(
        title="feat(scheduling): session lifecycle integrity",
        why="Concurrency and state authority for bookings: per-coach advisory-locked request/reschedule re-validated on fresh rows, the exclusion-constraint floor mapped to 409 SLOT_TAKEN, compare-and-set transitions on the booking revision, fenced provider write-back.",
        t4="Read-access: booking writes go through SchedulingAccessService (1/9). RLS/money/PII: no (the lifecycle's no-pii legacy baseline entry is removed, count now 0). CI gate file: no.",
        t3="Concurrency and state authority: YES. Schema: uses 1/9's columns and constraint. Routes: no (main's service and controller still call it until 6/9).",
        live="Live in this piece: the new lifecycle behind main's SchedulingService (the new TransitionOptions and constructor arguments are optional, so main's service compiles and calls it unchanged until 6/9). Reschedule never deletes reminder claims (claims are keyed by start_at, main B-647-1).",
        inter=None,
        tests="tsc clean; scheduling.service 13/13 (the two completed-session cases assert 409 again), scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, availability-overrides 10/10, scheduling-providers 7/7, entitlement-guards-mounted 17/17, no-pii-in-logs 11/11, booking-emitter 21/21, booking-reminder.job 20/20, booking-reminder-local-time 8/8, google-calendar-webhook.controller 6/6, gcal-watch-startup 9/9, google-calendar.service 15/15, no-pii-probe-replays 13/13. The lifecycle's integrity regressions are in 7/9-9/9 because they drive the 6/9 service and the 5/9 job; 1,344 lifecycle lines leave no room for them here.",
        res="R2 (reschedule takes #634's runBookingTx and CAS, drops #634's claim deleteMany per main B-647-1) and the two inlined safeLogDiagnostic log sites live here.",
    ),
    5: dict(
        title="feat(scheduling): recoverable reminder delivery",
        why="Reminder delivery state machine: claims keyed (session, user, kind, start_at) with status, attempts, lease and per-channel receipts; recovery and catch-up passes; park and retire; the FOR SHARE generation fence before anything is sent.",
        t4="Concurrency: claim/lease semantics (promotion trigger in #634). RLS/money: no. PII: logs carry only closed-enum classes and catalogued codes (the job's no-pii legacy baseline entry is removed, count now 0). CI gate file: no.",
        t3="Concurrency and state authority: YES. Shared notification primitive consumer: YES. Schema: uses 1/9's delivery-state columns and main's start_at key.",
        live="Live in this piece: the new reminder job (still behind the BOOKING_REMINDERS_ENABLED switch semantics stated in #634).",
        inter=None,
        tests="tsc clean; booking-reminder.job 21/21, booking-reminder-local-time 8/8, scheduling-delivery-status-contract 4/4, no-pii-in-logs 11/11, booking-emitter 21/21, scheduling.service 13/13, drip-dispatcher.cron 32/32, scout-diagnostics-boundary 33/33, log-diagnostic-closed-enum 12/12.",
        res="R3 (job: 4-column key, start_at, no stale-revision reset, readFencedSession FOR SHARE fence, non-P2002 claim errors count as failed) and R6 (job spec, main's B-647-1 cases ported plus a FOR SHARE fence case) live here, with the reminder-claim-fake rewrite and the local-time world.",
    ),
    6: dict(
        title="feat(scheduling): scheduling service, routes and session view",
        why="Read-access change on the scheduling API: my-coaches, access-gated session types with the welcome rule, participant-only session reads (404 SESSION_NOT_FOUND otherwise), client views without coach-only fields, past/upcoming keyset pages, transition routes.",
        t4="Read-access change: YES (session reads participant-only; client views null coach_notes_md, provider_idempotency_key, video_meeting_id, calendar_event_id and hide video_url while pending). RLS/money/PII: no new table. CI gate file: no.",
        t3="Routes: YES (scheduling.controller). Cross-repo contract: mobile #325 consumes it.",
        live="After this piece every file under src/, prisma/ and scripts/ equals M; 7/9-9/9 change only tests and ci.yml.",
        inter=None,
        tests="tsc clean; scheduling.service 13/13 (final form), scheduling-reminder-delivery 21/21, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, entitlement-guards-mounted 17/17, availability-overrides 10/10, scheduling-providers 7/7, google-calendar-webhook.controller 6/6, gcal-watch-startup 9/9, google-oauth.service 9/9, google-feature-flag 2/2, calendar-oauth-kms 3/3, no-pii-in-logs 11/11, roles-enforced 2/2.",
        res="None of R1-R7 live here (byte-identical to #634 apart from the merged siblings).",
    ),
    7: dict(
        title="test(scheduling): lifecycle integrity spec, booking matrix to lifecycle rules",
        why="Regression proof for the T4 lifecycle: booking validation matrix, ownership, races with the double-booking control, lifecycle rules.",
        t4="Tests only.",
        t3="Tests only.",
        live="Tests only.",
        inter="test/scheduling-lifecycle-integrity.spec.ts is M's lines 1-1070 without the imports and helper used only by later blocks (`fs`, `path`, `Logger`, `Prisma`, `startMs`); 8/9 and 9/9 add them with the blocks that use them.",
        tests="scheduling-lifecycle-integrity 48/48.",
        res="Integrity spec follow-through (start_at, restated 4-column-key cases) is spread over 7/9-9/9 as the blocks land.",
    ),
    8: dict(
        title="test(scheduling): lifecycle integrity spec, fix-round regressions S-SCHED-3 to S-SCHED-5",
        why="Regression proof for the T4 fix rounds: revision-fenced transitions, fenced provisioning, keyset pages, archived welcome restore, recoverable channel-aware reminders, next-tick recovery, missed-claim recovery with safe diagnostics.",
        t4="Tests only.",
        t3="Tests only.",
        live="Tests only.",
        inter="test/scheduling-lifecycle-integrity.spec.ts is M's lines 1-2210 without `fs` and `path` (used only by 9/9's blocks).",
        tests="scheduling-lifecycle-integrity 85/85.",
        res="See 7/9.",
    ),
    9: dict(
        title="test(scheduling): lifecycle integrity spec end, live no-double-booking proof",
        why="CI gate file change (one spec added to the mwb-3-live-tests jest list) and the live Postgres proof of the no-double-booking floor.",
        t4="CI gate file: YES (.github/workflows/ci.yml, additive: a comment and one spec path in the mwb-3-live-tests list; no job, gate or permission change). RLS/money/PII: no.",
        t3="Tests only otherwise.",
        live="Tests and CI only. The tree at this head equals M.",
        inter=None,
        tests="scheduling-lifecycle-integrity 103/103 (local); scheduling-booking-concurrency.live runs in this PR's mwb-3-live-tests.",
        res="The live spec's new-start claim case (follow-through) lives here.",
    ),
}


def contents(k):
    rows = []
    tot = 0
    for line in git("diff", "--numstat", base(k), BR[k]).splitlines():
        a, d, f = line.split("\t")
        rows.append(f"| `{f}` | +{a} / -{d} |")
        tot += int(a) + int(d)
    return tot, rows


def body(k):
    p = P[k]
    tot, rows = contents(k)
    me = stack.get(str(k))
    chain = " <- ".join(
        (f"#{stack[str(i)]}" if str(i) in stack else f"{i}/9") + (" (this)" if i == k else "") for i in range(1, 10)
    )
    L = []
    L.append(f"Split piece {k}/9 of #634 (S-SCHED-2 native scheduling lifecycle), B-SPLIT-SCHED-120 (agent 120). Draft. Owner order 09:45 PDT 10-05: every piece under 1,500 changed lines.")
    L.append("")
    L.append("## Tier header")
    L.append("- **Tier:** T4 (max-tier rule: piece of the T4 S-SCHED-2 split).")
    L.append(f"- **Why:** {p['why']}")
    L.append(f"- **T4 trigger scan:** {p['t4']}")
    L.append(f"- **T3 trigger scan:** {p['t3']}")
    L.append("- **Bounded T1:** none.")
    L.append("- **Canonical builder:** B-SPLIT-SCHED-120 (agent 120), split of S-SCHED-2 (#634; builders agents 110-114, not self-audited).")
    L.append("- **Parent owner:** operator agent 120.")
    L.append(f"- **Acceptance evidence:** local (ops/heavy.sh, one spec at a time): {p['tests']} Full suite and live lanes in this PR's CI.")
    L.append("- **Promotion triggers:** any change to the access predicate, the exclusion constraint, the occupying-status set, the transition fence, the reminder claim/lease semantics or the reminder switch semantics re-opens T4 review (as #634). No behaviour change beyond the main-merge resolution is allowed in the split.")
    L.append("")
    L.append(f"## Contents ({tot} changed lines vs base `{'main' if k == 1 else BR[k-1]}`)")
    L.append("| File | Lines |")
    L.append("|---|---|")
    L += rows
    L.append("")
    L.append(p["live"])
    L.append("")
    if p["inter"]:
        L.append("## Intermediate lines (replaced by a later piece; the top equals M)")
        L.append(p["inter"])
        L.append("")
    else:
        L.append("Every file in this piece is byte-identical to M.")
        L.append("")
    L.append("## Split provenance")
    L.append(f"- Original: #634 (`agent110/s-sched-lifecycle`) @ `{SRC}` (30 files, +9,378/-1,286 vs merge-base 0d33c4d4).")
    L.append(f"- Reference merge M = `{M}` (branch `agent120/sched-split-0-merged-reference`): #634 @ e18e8055 merged with main `{MAIN}`, conflicts resolved once; `git show --remerge-diff {M[:8]}` shows every resolved hunk. M vs main: 33 files, +9,774/-1,454.")
    L.append(f"- Stack: {chain}. Land as one stack (MERGE_DEPENDENCY_GUIDE rule 11). #653 (S-SCHED-5 request auto-expiry) restacks onto 9/9.")
    L.append(f"- Top-tree equality: `git rev-parse {M[:8]}^{{tree}}` == `git rev-parse {TOP[:8]}^{{tree}}` (9/9 head `{TOP}`) == `{TREE}`; `git diff {M[:8]} {TOP[:8]}` is empty. No A/B fixes are included (the job is split only).")
    L.append("")
    L.append("## Main-merge resolutions (all in M; full list in ops report B-SPLIT-SCHED-120)")
    L.append("Main #643/#647 (B-643-1, B-647-1/2, C-647-2/3, migration 20270301000000 applied in prod) re-keyed reminder claims to (session_id, user_id, kind, start_at) NOT NULL with a FOR SHARE fence, made reschedule keep claims, and added zone provenance. R1 schema [1/9]; R2 lifecycle [4/9]; R3 reminder job [5/9]; R4 emitter [3/9]; R5 emitter spec [3/9]; R6 job spec [5/9]; R7 service spec [2/9, final in 6/9].")
    L.append(f"In this piece: {p['res']}")
    L.append("")
    L.append("## Prior verdicts on #634 (evidence reuse is each lens's decision, byte-identical code only)")
    L.append(f"- Opus APPROVE @ 3d989702: {U}5971916062")
    L.append(f"- Sol APPROVE @ 3d989702: {U}5971921481")
    L.append(f"- FIX ROUND 5 @ 3d989702: {U}5971822865")
    L.append(f"- Operator update-branch @ e18e8055: {U}5972077899")
    L.append(f"- Opus merge-only APPROVE @ e18e8055: {U}5972118900 (Sol has no verdict at e18e8055)")
    L.append("")
    L.append("## Decisions")
    L.append("- D1 migration 20270222000000 sorts before the applied 20270301000000: keep the name (recommended default; the newer-than-20270316000000 rule does not apply to existing migrations). The two commute (20270222 adds state columns, indexes and the constraint; 20270301 adds start_at); `prisma migrate deploy` applies the unapplied one. Alternative: rename to a timestamp newer than 20270316000000.")
    L.append("- Reminder switch: unchanged from #634 (unset means off; set `BOOKING_REMINDERS_ENABLED=on` through the B-FLAGS manifest in the deploy window). Pairs with mobile #325 (OR-112-13).")
    return f"S-SCHED-2 split {k}/9: {p['title']}", "\n".join(L) + "\n"


if __name__ == "__main__":
    meta = {}
    for k in range(1, 10):
        t, b = body(k)
        open(os.path.join(OUT, f"body_{k}.md"), "w").write(b)
        meta[k] = dict(title=t, head=BR[k], base=("main" if k == 1 else BR[k - 1]), sha=sha(k), lines=contents(k)[0])
    json.dump(meta, open(os.path.join(OUT, "pieces_meta.json"), "w"), indent=1)
    for k, m in meta.items():
        print(k, m["lines"], m["sha"][:8], m["title"])
