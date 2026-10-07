# JOBS125 — agent 125 wave 1 (13:55 PDT 10-06). Read /home/user/workspace/ops/lanes125/_COMMON_125.md first, then ONLY your entry.

Owner 13:50: "start one agent to audit every single one of these areas, seperately, in depth." Each AUDIT job is a FIND-AND-FIX
auditor for ONE area (agent 124's AUDIT20 list, ordered by launch-day importance). Trace the area end to end on the 10-07 build
(mobile main a1904f2f with eas.json production/clinic flags + production backend flags), find Bs and Us, fix what you can in at most
two PRs (one backend, one mobile), report everything. Stay inside your area: if you find a B in another area, one line under
"Other areas" in your report, do not fix it. Paths below are starting points, not limits (mobile: wt/RO-mobile/src; backend:
wt/RO-backend/src). Time box 80 minutes each.

## AUDIT-01-125 (Claude Opus 5.5) — Client first run: sign-up, consultation, onboarding, Day-1 first win (T4 auth)
The first five minutes every client sees. Sign up (email + password, Apple, Google), email confirmation, sign in, consultation
(screens/consultation), onboarding (screens/onboarding, screens/day-one), coach pairing / invite code at signup, coachless path
(no coach: featured coach + Roman card), Day1WinScreen / first-win, landing on Home. Backend: auth, onboarding, first-win,
invite-codes, coachless, users/profile. Every step must work for a fresh account with no coach, no plan and no data. Open PRs that
overlap (read first): b#785, b#783, m#413 (confirmation), m#409 (account switch caches), m#411 (offline onboarding drafts, draft),
b#782 (invite code input).

## AUDIT-02-125 (Claude Opus 5.5) — Coach first run: account, profile, first package, invite code, first client (T4 money/auth)
A new coach signs up, completes profile and setup (screens/coach/setup, settings), connects Stripe payouts (Connect onboarding and
its return), creates the first package (one-time and RECURRING; price, currency, cadence, what the client sees), makes an invite
code (CoachCodesScreen, InviteCodesScreen), and gets the first client linked and visible (ClientsList, ClientDetail). Backend:
packages, coach-connect, coach-money, payouts-v2, invite-codes, coach. Recurring packages are the most critical item of all. Open PRs
that overlap: m#407 (truthful Stripe setup), b#778 (package statistics), m#414 (day-1 coach alerts), b#777 + m#408 (Clients list).

## AUDIT-03-125 (Claude Opus 5.5) — Messaging: chat, coach inbox, read states, photos, new-message notifications (T4 PII)
Client and coach 1:1 chat (MessagesScreen both sides, ClientMessagesScreen, CoachInboxV2), messaging core v2 (on), send/receive,
ordering, read receipts and unread badges, photo and attachment send/view (who can open the media URL), long-press actions
(reply/edit/pin/delete), push for a new message and where tapping it opens, empty inbox, blocked users. Backend: messaging,
messages-safety, coach-media, notifications. A message, photo or preview reaching the wrong person is a B.

## AUDIT-04-125 (Claude Opus 5.5) — Booking and calendar (T4 access, core flow)
Client: see available times, book, reschedule (RescheduleSheet), cancel, upcoming sessions (ClientUpcomingSessionsScreen,
screens/client/calendar), paid vs included sessions. Coach: availability editor, booking options, appointment/session types,
booking inbox (accept/decline), time off, reminders (on). Backend: scheduling, booking reminders, calendar sync stays OFF (Google
Calendar/Meet unset). Hunt double-booking under normal single-user use, sessions shown to the wrong coach/client, a booked slot that
does not appear, reminder push that opens the wrong place. RUTHLESS SCOPE: no time-zone or DST hunting. Open PR overlap: b#781.

## AUDIT-05-125 (Claude Opus 5.5) — Roman chat: feel, speed, errors, history, approve-a-change (T4 AI/safety)
RomanChatScreen + useRomanChat, Roman conversations history (settings/RomanConversations*), consent gate (RomanAiConsentScreen;
consent v4 keeps day-1 Roman; v5 is v1.1 and flag-off), approve-to-adjust flow (roman-adjust, FEATURE_ROMAN_ADJUST_ENABLED on):
what the client sees, what the coach sees, what actually changes. Voice: butler and friend, never preachy; whole sentences; no
first-person product copy outside Roman's own replies. Errors: timeout, budget exhausted, consent withdrawn, crisis routing (must
route real crisis; must NOT send normal gym talk to emergency copy). Backend: roman, roman-adjust, ai, ai-consent, ai-egress,
ai-credits. Roman v1.1 (memory, playbooks) is flag-off and post-launch: do not audit it except to confirm it stays off.

## AUDIT-06-125 (Claude Opus 5.5) — Progress: weigh-ins, check-ins, photos, charts, timeline, progress report (T4 health data)
ProgressScreen + screens/client/progress, weight logging and units, check-ins (client submit, coach review), progress photos
(upload, who can see, deletion), charts with no data / one point / real data, TimelineScreen, ReportScreen / progress report.
Backend: weight, check-ins, timeline, insights, coach-media, data-export coverage of these. A coach seeing another coach's client
progress, a photo URL reachable by others, or a chart showing wrong numbers is a B.

## AUDIT-07-125 (Claude Opus 5.5) — Coach program builder and assignment (T3/T4 tenancy)
CoachWorkoutBuilderScreen (+ workoutBuilderAutosaveDiff/Undo/Access), screens/coach/programs, ProgramTemplatesScreen, MWB
templates/autosave + named regimes (on). Build a program, edit, save, assign to a client, what the client then sees
(WorkoutAssignmentDetailScreen, ClientWorkoutViewer), unassign/replace. Backend: workout-builder, regimes, programs/assignments,
exercise-library refs. Data loss on save/autosave and assignment to a client the coach does not own are Bs. Client-side workout
LOGGING was audited today (UX-WORKOUT-124): skip it except where assignment hands off to it. Open PR overlap: m#406.

## AUDIT-08-125 (Claude Opus 5.5) — Meal plans: daily plan, recipes, grocery/shopping, prep guide, coach templates, AI drafts (T3/T4)
ClientDailyMealPlanScreen, RecipesScreen/RecipeDetail, GroceryListScreen, ShoppingListScreen, PrepGuideScreen,
CoachMealTemplatesScreen, AIMealPlanDraftScreen (consent and coach approval before a client sees an AI plan). Backend: meal-plans,
real-meal-plans, recipes, lists, prep-guide, macros, ai drafts. Food LOGGING was audited today (UX-FOOD-124): skip it except where
a meal plan hands off to logging. Open PR overlap: m#404 (coach food review), b#780 (custom foods privacy).

## AUDIT-09-125 (Claude Opus 5.5) — Notifications: what is sent, when, where it opens, duplicates, quiet hours, settings (T4 PII)
Every push kind live on day 1 (messages, community, booking reminders, coach brief, check-ins, Roman, broadcasts, billing): the
trigger, the text (no health or private detail on the lock screen), the deep link target (must open the right screen for that
role), duplicates for one event, quiet hours, NotificationPreferencesScreen + "Mute all" honoured server-side, in-app
NotificationsScreen list and read state, permission prompt timing (screens/day-one/NotificationsScreen). Backend: notifications,
nudges, community notifications, scheduling reminders.

## AUDIT-10-125 (Claude Opus 5.5) — Community: hall, cohorts, posting, report and block (T4 store/legal, PII)
CommunityTabScreen, CommunityToday/Space/Thread/Composer, cohorts (client + CoachCommunityCohorts*), coach moderation
(CoachCommunityModeration), report and block (CommunitySafetyScreen, BlockedUsersScreen) — Apple 1.2 and Google UGC policy:
report on every post/comment/member, block that hides content both ways, a way to contact/escalate, terms acceptance, moderation
response. Coachless clients in the featured coach's community. Broadcasts (on) appear where expected. DMs and voice notes are OFF:
confirm no reachable entry point. Backend: community, broadcasts, leaderboard (only if reachable from community).

## AUDIT-11-125 (Claude Opus 5.5) — Wearables and Health Connect: connect, sync, display, disconnect (T4 health data, store)
screens/client/wearables, Apple Health (iOS production profile) and Health Connect (Android clinic profile only): permission
request (read-only, least privilege vs the Play declaration and app.json/app.config), the rationale/privacy activity, first sync,
what shows up for the client and for the coach, disconnect and what happens to stored data, deletion/export coverage. Backend:
wearables, health ingest. Compare with handoffs/op-123/DEVICE_PASS_10-07.md in tgp-agent-context (the owner's device test) so the
build matches what the owner will test.

## AUDIT-12-125 (Claude Opus 5.5) — Settings and account: profile, preferences, privacy, AI consent, export, deletion (T4)
SettingsScreen (client + coach), EditProfileScreen/ProfileScreen, PreferencesScreen (units etc.), Privacy / Trust Center,
RomanAiConsentScreen (grant/withdraw and its real effect), DataExportScreen, DeleteAccountScreen (Apple 5.1.1(v): in-app, reachable
for clients AND coaches; what happens to an active subscription and to coach payouts), sign out (clears private caches). Backend:
profile, users, consent, ai-consent, data-export, account-deletion. Open PR overlap: b#784 (deletion instructions), m#409.

## AUDIT-13-125 (Claude Opus 5.5) — Coach Home and risk board (T3/T4 tenancy)
CoachHomeScreen, screens/coach/command-center, CoachBriefScreen (coach brief live today), RiskBoardScreen + ClientRiskDetail,
ClientInsightScreen, cross-pillar. Numbers must be true (no fake 0% or placeholder stats), empty states for a coach with zero or
one client, each tile opens the right place, data scoped to the coach's own clients. Backend: coach, insights, engagement,
coach brief. Open PR overlap: m#414, b#777 + m#408.

## AUDIT-14-125 (Claude Opus 5.5) — Coach AI drafts: pending queue, AI workout/meal drafts, approving Roman's changes (T4 AI)
PendingAiDraftsScreen, AIWorkoutDraftScreen, AIMealPlanDraftScreen, Roman approve-to-adjust from the coach side. Nothing AI-made
reaches a client without coach approval where the product says it needs approval; consent respected (no client data to the model
without consent); AI budget pool and exhausted state with specific copy; approve/reject actually applies/discards. Backend: ai,
roman-adjust, coach AI budget, drafts.

## AUDIT-15-125 (GPT-6.1 Sol) — Habits and fasting: daily check-off, streaks, fasting timer (T2)
HabitsScreen + screens/client/habits, FastingScreen. Check off, undo, streak math on normal consecutive days, what the coach sees,
fasting start/stop/history, timer survives app background and reopen on the same day. Backend: habits, fasting. RUTHLESS SCOPE: no
midnight/time-zone hunting. If a fix needs a T4 change (auth, PII scoping), report it for an Opus builder (common item 6).

## AUDIT-16-125 (Claude Opus 5.5) — Coach team: sub-coaches, team invites, moving a client, permissions (T4 access)
TeamManagementScreen, TeamMembersScreen, SubCoachInviteModal, SubCoachDetailScreen, CoachTeamProfileScreen, ClientReassignModal.
Invite a sub-coach, accept, what the sub-coach can see and do (only assigned clients), head coach reassigns a client (messages,
plans, bookings follow or not, and the client is told truthfully), remove a sub-coach (access revoked). Backend: sub-coach,
sub-coaches, team, team-mode. Is this reachable on day 1 at all? If it is hidden or flag-off, say so and keep the audit short.

## AUDIT-17-125 (Claude Opus 5.5) — Invites and bulk invite: bulk invite, invite codes, who redeemed them (T4 linking)
BulkInviteScreen / CoachBulkInviteScreen, CoachInvitesScreen, InviteCodesScreen, InviteCodeRedeemersScreen, invite links and QR,
invite landing pages. A redeemed code links the right client to the right coach exactly once; the redeemers list shows only that
coach's redeemers; bulk invite emails go out with correct links and no other client's data. Coach codes (CoachCodesScreen) were
built today: check only how they interact with the older invite surfaces (two systems confusing a coach is a U). Backend:
invite-codes, invite-grant, invite-landing, connect. Open PR overlap: b#782.

## AUDIT-18-125 (GPT-6.1 Sol) — Exercise library and education (T2)
ExerciseLibraryScreen, ExerciseDetailScreen (demo media loads, missing media fallback), search quality for common lifts,
EducationScreen, DeliverablesScreen + screens/client/deliverables, lessons. Backend: exercise-library, exercise-catalog, lessons.
Broken media URLs, empty lists for real queries, dead links, content that makes a health/medical claim (false claim = B).

## AUDIT-19-125 (GPT-6.1 Sol) — Help and failure states: support chat, report a problem, offline and server errors (T2)
SupportInboxScreen / support chat (Crisp), "report a problem", Help centre links (m#415 is open for coach help links: read it). Then
sweep what the main screens show offline and on a server 5xx/timeout: Home, Log, Workout, Messages, Calendar, Roman, Progress,
coach Home, Clients. Generic errors, spinners that never end, blank screens and missing retry are Us; a dead end on a core flow is a
B. Prefer one shared fix (an existing error-state component) over twenty screen edits. Keep the PR under 800 lines.

## AUDIT-20-125 (GPT-6.1 Sol) — App-wide polish: dark mode, large text, screen readers, cold start, list scrolling (T2)
Dark mode contrast on the main client and coach screens (theme tokens vs hard-coded colours), Dynamic Type / font scaling (clipped
or overlapping text on the main flows), accessibility labels/roles on primary buttons and tab bar, cold start (what blocks the first
render: synchronous storage reads, big imports, waterfalls of requests on Home), list performance (FlatList vs ScrollView+map on long
lists: messages, clients, food search, exercise library). Fix the highest-value items only; one mobile PR under 800 lines.

# LENS PAIR L1 — agent 124's open PRs (owner TOP PRIORITY: money bulletproof, food and workout logging kick ass)

## AUD-OPUS-L1-125 (Claude Opus 5.5) and AUD-SOL-L1-125 (GPT-6.1 Sol) — independent lenses, one verdict each per PR at exact head
Two independent lenses review the same queue in this order; each PR gets one verdict from each lens. Never read the other lens's
verdict for that head before posting yours. Before each review: `gh api repos/BradleyGleavePortfolio/<repo>/pulls/<n> --jq .head.sha`
and the PR's own comments (builder FIX ROUND / READY lines, earlier verdicts). If a lens of your model already posted a verdict at
the CURRENT head (agent 124's lenses did on m#404 and m#406), skip that PR. If CI shows a real failure caused by the PR, REQUEST
CHANGES with the failing check named. Time box: 15 minutes per PR (T4 money 20), 150 minutes total; work the queue top to bottom.
Queue: b#776 (refund pauses billing), b#779 (Stripe webhook transaction), b#778 (package stats, paused pricing), m#410 (bank
authentication return), m#402 (ended plans restart), m#405 (full-refund pause copy), m#407 (truthful Stripe setup), m#412 (Android
digital purchase surfaces), b#780 (custom foods private), m#404 (coach food review; Opus lens only if no Opus verdict at head),
m#406 (offline workouts; Opus lens only, Sol approved at 9a334d12), b#785 (auth confirmation recovery; CI red — check why), m#413,
b#783, m#409, b#782, b#777, m#408, m#414, m#415, b#781, b#784. Skip b#762 (already dual-approved; held for an owner Stripe step) and
m#411 (draft, red).
Verdict comment first line, exactly: `AUDIT Claude Opus 5.5 — growth-project-<repo>#<n> @ <full sha> — VERDICT: APPROVE` (or
`AUDIT GPT-6.1 Sol — ...`, or `VERDICT: REQUEST CHANGES`). Then A/B/C counts, findings with ids like B-<pr>-<n>, file:line, the
one-sentence normal-user story for every B. Grade only against _COMMON_125 "What you hunt": APPROVE when there is no B. Cs are a
one-line list and never block. Lenses run NO local npm/jest/tsc/eslint except one targeted spec through heavy.sh when CI cannot
answer the question; probes through ci_lane.sh. Write each verdict in /home/user/workspace/ops/aud-125/<JOB>/<pr>.md before posting.
After each verdict append one line to /home/user/workspace/ops/lanes125/notify/<JOB>.txt: `<repo>#<n> @ <sha8> <VERDICT> B=<n>`.
Lenses never push code, merge or deploy.

# FIXER QUEUE (14:05) — fix rounds on agent 124's open PRs (agent 124's builders are gone; operator owns these PRs now)

## FIX-Q1-125 (Claude Opus 5.5, builder) — work this queue top to bottom; time box 25 minutes per item, 120 minutes total
You may push to the PR branches named here (they belong to the operator). Make your own worktree per PR from the PR head (absolute path,
`git -C /home/user/workspace/growth-project-<repo> fetch -q origin pull/<n>/head && git -C ... worktree add /home/user/workspace/wt/FIXQ1-<repo>-<n> FETCH_HEAD`,
then `git switch -c` the PR's head branch name and push to it). Fix only the Bs named (plus anything CI needs), nothing else. After each
push and green CI, post one comment whose first line is exactly
`FIX ROUND <k> (FIX-Q1-125, agent 125) — growth-project-<repo>#<n> @ <full head sha> — READY FOR DELTA AUDIT` listing each B fixed with
the test that proves it. Then write one line to /home/user/workspace/ops/lanes125/notify/FIX-Q1-125.txt and take the next item.
1. m#404 (coach food review, owner TOP PRIORITY) FIX ROUND 3: B-404-O1 from the Opus verdict at ab6d426b (read it on the PR): de-duplicate
   entries by id across timeline pages and keep paging from the last raw row; add a two-page test with shared boundary-day ids proving each
   entry counts once and day totals match. ALSO open one tiny backend PR (D1, T2): `orderBy: [{ date: 'desc' }, { id: 'desc' }]` on the
   coach timeline meals slice (src/coach/coach.service.ts ~284) + one spec; title `fix(coach): stable timeline meal paging`; READY comment
   with the normal FIX ROUND 1 (OPENING) first line from _COMMON_125 item 5.
2. b#785 (auth confirmation recovery, client first run) — CI red: "Banned cast tokens (R75 / R100.A2)" and "build-and-test". Read the
   failing job logs via `gh api repos/BradleyGleavePortfolio/growth-project-backend/actions/jobs/<job id>/logs` (job ids from
   `gh pr view 785 --json statusCheckRollup`), fix the banned cast(s) without weakening types, fix the test failure if it is the PR's own.
3. Then poll /home/user/workspace/ops/lanes125/notify/AUD-OPUS-L1-125.txt and AUD-SOL-L1-125.txt every 5 minutes: for each REQUEST
   CHANGES on an agent 124 PR (b#776-b#785, m#402-m#415), read that verdict on the PR and do the fix round the same way, money PRs first.
   If two lenses disagree on whether something is a B, fix it if the fix is small and safe; otherwise write it in your report for the operator.
Report /home/user/workspace/ops/reports/FIX-Q1-125.md (per item: PR, old head -> new head, Bs fixed, tests, CI).

# LENS QUEUE L2 (14:16) — auditor PRs (AUDIT-01..20-125), both L1 lenses after their L1 queue
Same verdict rules as LENS PAIR L1. The live queue is every open PR whose comments contain "READY FOR AUDIT" from an AUDIT-xx-125 or
FIX-Q1-125 job and that has no verdict of your model at its CURRENT head. Find them with:
`for r in backend mobile; do gh pr list --repo BradleyGleavePortfolio/growth-project-$r --state open --limit 100 --json number,headRefName,headRefOid,title --jq ".[]|select(.headRefName|startswith(\"agent125/\"))|\"$r#\\(.number) \\(.headRefOid) \\(.title)\""; done`
(branches are agent125/...). Order: money and private data first, then core flows (sign up, train, log food, book, message), then the
rest. Mobile PRs before backend PRs at equal weight (the 10-07 build only carries mobile main). 15 minutes per PR (T4 money 20).
Delta reviews (FIX ROUND k READY FOR DELTA AUDIT on a PR you already reviewed): review only the delta, 10 minutes.
Keep polling every 5 minutes until the operator sends WRAP UP or 16:30 PDT, whichever comes first.

# T4 FIX BUILDERS (14:24)

## B-DELIV-125 (Claude Opus 5.5, builder, T4 private data + money) — three escalated Bs from AUDIT-18-125. Time box 60 minutes (hard stop 15:25).
Read /home/user/workspace/ops/reports/AUDIT-18-125.md section "Not fixed (needs operator)" (B2, B3, B4) and the AUDIT-18 PRs (b#788,
m#418) so you do not collide with them (build on main; if you must touch the same file, keep it minimal and name the overlap).
- B2 (private data): coachless or unassigned clients reading Learn get every coach's lessons (src/lessons/lessons.service.ts:17-20,
  108-109; also completeLesson). Fix: no coach scope -> empty result (or the featured coach's lessons only if that is what the coachless
  product promises: check src/coachless), explicit coach scope on every read/write. Tests that fail on main.
- B3 (money): a client who bought a PDF/video deliverable cannot open it (mobile src/screens/client/deliverables/dropRow.tsx:176-187;
  backend src/coach-media/coach-media.service.ts:368 getBuyerSignedUrl has no route). Fix: an authenticated buyer route that calls the
  existing grant-scoped getBuyerSignedUrl (only the buyer with a live grant gets a short-lived URL), and the mobile row opens it.
- B4 (money/core): delivered meal-plan assignment ids are routed as dates (src/checkout/checkout.service.ts:965-968,
  dropRow.tsx:221-232). Smallest compatible fix per the report.
One backend PR + one mobile PR, each under 800 lines; the mobile change must degrade gracefully against today's production backend (the
new buyer route ships with tonight's deploy). READY comments per _COMMON_125 item 5 with job B-DELIV-125.

## B-WEARLIST-125 (Claude Opus 5.5, builder, T3) — cloud trackers light up from the server, no app update needed. Time box 50 min (hard stop 15:30).
Owner 14:30: "TURN THEM ON AND SHOW THEM PROUDLY!" The eight cloud connectors (Fitbit, Garmin, Oura, Polar, Strava, Wahoo, WHOOP,
Withings) are built (backend src/wearables/connectors, master switch FEATURE_WEARABLES_CLOUD_CONNECTORS in
src/wearables/cloud-connectors.feature.ts) but TGP has no provider keys yet (all *_CLIENT_ID/SECRET "unset"). m#421 (merged) hides every
cloud provider on the Connections screen (src/screens/client/wearables/ConnectionsScreen.tsx, connectableHere). Make the list server-driven
so each provider appears the moment it is really connectable, with no new app build:
- Backend PR: authenticated GET /wearables/providers (or the closest existing route family) returning the cloud providers that are
  connectable now = master switch on AND that provider's required credentials present (names only; never return values). Tests.
- Mobile PR: ConnectionsScreen shows a cloud provider row (with its Connect action using the existing OAuth start flow) only when the
  server lists it; on 404 / error / older server it behaves exactly as m#421 does now (hidden, no false claims). Proud presentation when
  listed: provider name, logo if the app already has one, one-line benefit ("Sleep, readiness and heart rate from your Oura ring").
  Tests for both states.
Read the m#421 diff first. Each PR under 500 lines. READY comments per _COMMON_125 item 5 with job B-WEARLIST-125.

## B-REPORTALERT-125 (Claude Opus 5.5, builder, T3 store/safety) — every user report reaches a human. Time box 45 min (hard stop 15:25).
AUDIT-03-125 N1 and AUDIT-10-125: message reports and community reports are saved, the report sheet promises review within 24 hours,
but nobody is alerted (Apple 1.2 requires timely action on reports). Backend PR only: when a message report or a community report is
created, send one email through the existing email service (Resend; sender already configured) to the support inbox the app already
uses (find the configured support/help address in code or env names; do not invent an address; if none exists, use an env var name
REPORTS_ALERT_EMAIL with a safe fallback to the existing support address constant) with: report id, kind, reason label, time, and a
note that it is a "self-harm or suicide" report when that is the reason (put that first in the subject). Never include message text,
health data or names of the reported content's author in the email body beyond the ids (PII minimal). Failure to send must never fail
the report itself (log + metric). Tests. Under 400 lines. Read b#789 (AUDIT-03, adds report reasons) and m#428 so you do not collide.

## B-ROMANADJ-125 (Claude Opus 5.5, builder, T3; core flow) — the client trains the sets the coach approved. Time box 60 min (hard stop 15:45).
AUDIT-07-125 + AUDIT-14-125 B2 (read both reports' B2 / item 4 sections first): a coach approves Roman's set change in the Action Queue,
the card says applied, but the client's workout screen still shows and starts the OLD sets. roman-adjust writes only
ClientWorkoutAssignmentSnapshot.exercises_json (backend src/workout-builder/workout-builder.service.ts replaceAssignmentSets, called from
src/roman-adjust/roman-adjust.service.ts ~393/467); mobile src/screens/client/WorkoutAssignmentDetailScreen.tsx renders and starts
data.workout_plan.exercises (lines ~63, ~79 buildActiveWorkoutExercises, ~138). m#422 (merged) changed this screen's loading; rebase on
current mobile main. Smallest safe fix (do exactly this):
- Backend PR: the client assignment reads (GET /me/assignments list item if it carries exercises, and the single assignment read the
  detail screen uses) add `roman_adjusted_sets: Array<{ order: number; sets: number }>` from the assignment's WorkoutAdjustmentProposal
  rows with status approved|edited (applied change sets_after), latest decision per order wins; empty array otherwise. Client-scoped
  (only the client's own assignment). Tests.
- Mobile PR: WorkoutAssignmentDetailScreen overlays those set counts by `order` onto workout_plan.exercises for display and for Start;
  field missing or empty (older server) = exactly today's behaviour. Coach live edits stay visible because only Roman's set counts are
  overlaid. Show a small "Updated by your coach" note on an adjusted exercise. Tests for overlay, missing field, mismatched order.
Each PR under 400 lines. READY comments per _COMMON_125 item 5 with job B-ROMANADJ-125.

## AUD-OPUS-L3-125 (Claude Opus 5.5) and AUD-SOL-L3-125 (GPT-6.1 Sol) — second lens pair, BACKEND queue only (from 14:45, stop 16:15)
Same rules as the AUD-*-L1-125 entry above (read it fully: verdict format, exact head, independence, no local test runs, notify line,
verdict file under /home/user/workspace/ops/aud-125/<JOB>/). The L1 pair now owns the MOBILE queue; you own BACKEND PRs. Skip any PR
where a lens of your model already posted a verdict at the CURRENT head (L1 lenses may have reached a few). Queue order (money and
safety first): b#791 (free package later priced: invite link stops granting free; T4 money, 20 min), b#795 (Roman: gym talk not sent
to 911, crisis section; safety, 20 min), b#792 (coach/purchase/content pushes: lock-screen PII, mute/quiet hours; T4), b#797 (coach
search and client profile reach), b#798 (Learn shows only own coach's lessons), b#793 (AI draft Save edits), b#794 (invite codes Who
joined), b#796 (coach edits of approved meal plan reach client; check CI green first), then FIX-Q1 deltas on b#776 / b#778 / b#785, then
any new agent125/* backend PRs (B-DELIV, B-ROMANADJ, B-WEARLIST, B-REPORTALERT builders) — list with:
for n in $(gh pr list --repo BradleyGleavePortfolio/growth-project-backend --state open --limit 100 --json number,headRefName --jq '.[]|select(.headRefName|startswith("agent125/"))|.number'); do echo $n; done
Time box 15 minutes per PR (T4 money/safety 20). Re-check the head sha right before posting.

## VERIFY-EXT-125 (GPT-6.1 Sol, verifier; owner 14:42 "I WANT A SOL SUBAGENT ON THIS") — check another model's findings list. Hard stop 15:30.
Input: /home/user/workspace/ops/lanes125/VERIFY-EXT-125-input.md (owner-pasted list). READ-ONLY job: no code, no PRs, no issue edits.
For EVERY item (issues via `gh issue view <n> --repo BradleyGleavePortfolio/growth-project-<repo>`; code via the read-only worktrees
/home/user/workspace/wt/RO-backend and /home/user/workspace/wt/RO-mobile after `git fetch -q origin main`, read with `git show origin/main:<path>`
/ `git grep ... origin/main`), decide one verdict with file:line evidence on current main:
- CONFIRMED-DAY1: the defect is real on main AND a normal user can hit it on day 1 (feature on in production: check
  .github/fly-env-desired-state.json for backend FEATURE_* flags; mobile EXPO_PUBLIC_FF_* flags in eas.json profile "clinic" (extends
  production) — absent = default in src/config/featureFlags.ts). Give the one-sentence normal-user story and grade B/U/C per
  _COMMON_125 "What you hunt" (RUTHLESS SCOPE: B only for normal-user money/private data/safety/data loss/reachable security/store-legal/
  false claim/core-flow dead end).
- CONFIRMED-NOT-DAY1: real, but behind an OFF flag, ops-only (e.g. restore procedure), dev-only, or not reachable by a normal user.
- FIXED-ON-MAIN: already fixed (name the PR/commit). - IN-FLIGHT: an open PR fixes it (name it; do not re-review the PR).
- WRONG: the claim is false (show why).
For CONFIRMED-DAY1 B items give the smallest safe fix (files, ~lines, tier) so the operator can route a builder.
Spend most time on the 10 highest-priority items; backlog items get a quick reachability check (flag on/off, still present) only.
Operator preliminary notes, verify independently, do not trust: mobile #260 undo looks behind EXPO_PUBLIC_FF_MWB_UNDO (not in eas.json);
backend #407 looks behind FEATURE_ROMAN_FIRST_PAYMENT (absent from desired state); backend #732 dedup key still uses start/end
(src/wearables/ingestion/dedup.util.ts) — check whether on-device ingest from Health Connect AND HealthKit is live and whether rewritten
records really reach ingest twice; mobile #275 RootNavigator.bootstrapAuth (src/navigation/RootNavigator.tsx ~435, ~670) has no in-flight
guard — check whether TokenManager/refresh already single-flights refresh, which would make the race harmless.
Output: /home/user/workspace/ops/reports/VERIFY-EXT-125.md with a table (item | verdict | grade | evidence file:line | one-line note),
then a short "Route now" list (only CONFIRMED-DAY1 B) and "Post-launch" list. Append one line to
/home/user/workspace/ops/lanes125/notify/VERIFY-EXT-125.txt when done. No local npm/jest/tsc.

## B-ROMANIQ-125 (Claude Opus 5.5, builder, T4 AI) — Roman's intelligence bump: current-generation models. Time box 55 min (hard stop 15:40).
Owner 14:44: "Has roman recieved his intelligence bump? Lets work on that too!" Today every product AI path calls claude-sonnet-4-6
(Feb 2026, two generations old, $3/$15 per MTok): Roman turns (src/roman/anthropic-client.provider.ts ROMAN_MODEL_PHASE_1), coach AI
drafts (src/ai/coach/coach-ai.constants.ts COACH_AI_MODEL), coach daily brief (src/coach/brief/coach-brief.service.ts:73
BRIEF_CLAUDE_MODEL = COACH_AI_MODEL; uses temperature at ~:1560). Current Anthropic lineup (docs.anthropic.com models overview, fetched
14:50): claude-sonnet-5-5 ($2/$10, fast, adaptive thinking default effort high), claude-opus-5-5 ($4/$20, moderate), claude-haiku-4-5-20251001
(background, unchanged). One backend PR, under 300 lines:
1. Roman turns + coach AI drafts -> 'claude-sonnet-5-5'. Coach daily brief -> its own constant 'claude-opus-5-5' (runs once per coach per
   day; latency does not matter; best reasoning). Update every price table the spend caps use (ROMAN_PRICE_PER_MTOK in
   src/roman/roman.constants.ts, the per-model list in anthropic-client.provider.ts, coach AI budget pricing, brief pricing if any) so caps
   never under-count; unknown-model fallback stays at the highest rate.
2. API compatibility FIRST: read the current Anthropic docs (pplx_sdk.content.fetch on docs.anthropic.com / platform.claude.com pages for
   Sonnet 5.5 / Opus 5.5 and the "migrating" / "what's new" page) for breaking changes: temperature/top_p with adaptive thinking,
   assistant prefill, thinking defaults and how to set effort or disable thinking for low-latency chat, stop reasons, max_tokens, and
   whether @anthropic-ai/sdk 0.104.1 accepts these ids/params. Roman chat must stay fast and streaming: set thinking/effort explicitly so
   first-token latency does not regress (state your choice and the doc line in the PR body). Keep Roman's safety router model
   (ROMAN_SAFETY_ROUTER_MODEL_ID) unchanged unless it is the retired id.
3. Update tests that pin model ids or prices; r11-seams prompt hash must not change (prompts untouched). If the R100 / quality-gate (G1-G30)
   workflow can run live in CI, make sure it runs on this PR and report its result; if it cannot, say so.
4. PR body: before/after table (path, old model, new model, old price, new price), the API-compat notes with doc URLs, and the kill/rollback
   (revert the constants). READY comment per _COMMON_125 item 5 with job B-ROMANIQ-125.

## B-HC732-125 (Claude Opus 5.5, builder, T4 health data) — Health Connect rewritten records must replace, not duplicate. Time box 40 min (hard stop 15:35).
VERIFY-EXT-125 (report /home/user/workspace/ops/reports/VERIFY-EXT-125.md, "Route now" section: read it first) confirmed backend issue
#732 as the only new day-1 B: an Android client corrects an already-imported night's sleep in its source app; the record posts again
with the same source_record_id and a new interval; ingest dedups on the interval hash, so a second row is inserted and the sleep total
inflates. Do exactly the Route-now fix: in src/wearables/ingestion/ingestion.service.ts, inside the existing transaction before
createMany, for each incoming record identity (user_id, provider, metric, source_record_id) with a non-null source id, delete the stored
rows for that identity, then insert the complete incoming sample set for it (group series samples first so a heart-rate record keeps its
whole series). Null-id behaviour and the interval hash unchanged. No migration (the column/index exist: check prisma/schema.prisma), no
mobile change, no new flag. Tests: 480 -> 450 replaces (total 450); unchanged same-id resubmission stays one version; same-id HR series
keeps the full incoming series; null source id keeps today's behaviour. One backend PR under 300 lines, "Fixes #732" in the body. READY
comment per _COMMON_125 item 5 with job B-HC732-125.

# SAFETY PASSES (owner 14:59: "AI in the workout builder, community AI triage and diagnostic AI: each needs its own reviewed safety pass -> do that now")
Common to SAFE-MWBAI-125 / SAFE-TRIAGE-125 / SAFE-DIAG-125 (Claude Opus 5.5, T4 AI). Time box 35 min, hard stop 15:40. Read-only by
default; you MAY open ONE fix PR under 300 lines if a blocker has a small, safe fix (READY comment per _COMMON_125 item 5). Never flip a
flag, never touch production config, never merge or deploy. Code: /home/user/workspace/wt/RO-backend and RO-mobile after
`git fetch -q origin main`, read via `git show origin/main:<path>` / `git grep ... origin/main`. Production flags:
.github/fly-env-desired-state.json (flags / gates / excluded), env defaults in src/common/env-validation.ts; mobile flags in eas.json
profile "clinic" (extends production) + src/config/featureFlags.ts. "R2b acceptance" is an older gate named in the manifest notes: find
what it required (git grep R2b in docs/ and src/, and the SoT) and say whether it is met.
Safety checklist (verdict per item, file:line): 1 consent: every client-data AI call checks the AI consent ledger
(FEATURE_AI_CONSENT_LEDGER_ENABLED is on in production) and the client's box-2 consent; 2 data minimisation: exactly what personal/health
data goes to the model, nothing from other users; 3 tenancy: a coach can only run it on their own clients / own community; 4 human in the
loop: nothing AI-made reaches a client or changes their plan without a coach approving it; 5 prompt injection: client- or member-written
text inside prompts cannot change instructions or trigger actions; 6 output validation: strict schema, refusal/garbage handled, no
unvalidated writes; 7 domain safety: injuries/contraindications/medical claims/eating-disorder or crisis content handled (workouts: volume
and intensity bounds, injury substitutions; triage: self-harm content routed to humans, never auto-actioned); 8 cost: metered against the
coach AI pool / daily caps, rate-limited; 9 kill switch works (flag off = 404/disabled, UI hides); 10 logs: no prompts or health data in
logs/Sentry; 11 store/legal: Apple 5.1.2(i) third-party AI disclosure + permission, no false claims in UI copy; 12 mobile reachability:
does the 10-07 clinic build contain the UI (which flag), or does turning it on need a later build.
Output: /home/user/workspace/ops/reports/<JOB>.md: verdict GO (safe to flip now: name the exact flags/values and whether the mobile build
needs a flag too) / GO AFTER FIXES (list blockers with smallest fix, tier, ~lines; the PR if you opened one) / NO-GO (why); B/U/C per
_COMMON_125 "What you hunt" (here every item of the checklist that fails for a normal user on flip is a B). Append one line to
/home/user/workspace/ops/lanes125/notify/<JOB>.txt.

## SAFE-MWBAI-125 — AI in the workout builder: FEATURE_MWB_AI_LIVE_CREATE + AI gateway (AI_GATEWAY_ENABLED / _PROVIDER / _CAPABILITIES /
_REQUIRE_APPROVAL). Start at src/ai/gateway/ (ai-gateway.config.ts, ai-gateway.service.ts, mwb-live-create.feature.ts, materialisers/
create-workout-plan + edit-workout-plan, providers/), src/ai/gateway/ai-approval.service.ts, and the mobile workout builder entry points.
Also note how this differs from the coach AI drafts already live (src/ai/coach/, AUDIT-14-125 report) so the owner knows what is new.

## SAFE-TRIAGE-125 — Community AI triage: FEATURE_COMMUNITY_AI_TRIAGE (backend, needs FEATURE_COMMUNITY_API=true) + mobile
EXPO_PUBLIC_FF_COMMUNITY_AI_TRIAGE (featureFlags.ts ~237-250). Start at src/community/ai-triage/ (controller, feature, flag guard,
triage-output.schema.ts) and the coach report queue (m#428, AUDIT-10-125 report). Self-harm / crisis posts are the highest-stakes case.

## SAFE-DIAG-125 — Diagnostic AI: DIAGNOSTIC_AI_ENABLED (+ DIAGNOSTIC_RATE_LIMIT_PER_HOUR). Start at src/diagnostic/ (README.md,
ai-roadmap.service.ts, controllers). FIRST determine whether it may already be ON in production: the manifest says the name is present on
Fly with an unread value. Probe read-only from outside: call its routes on https://api.trygrowthproject.com/api/... without auth and
compare the status to a known flag-off route (404 when off vs 401/403 when on, per its guard); report the evidence. If it looks ON and
any checklist item fails, mark it URGENT at the top of the report and in the notify line.

## B-DROPS-125 (Claude Opus 5.5, auditor-builder, T4 money) — sell PDFs and videos on day 1. Time box 35 min (hard stop 15:40).
Owner 15:03: yes to turning on the buyer screen for purchased PDFs/videos in the 10-07 build, "But we need to make sure theres been a way
to assing videos and files to packages at coach package creation screens that works robustly!" Context: buyer side = DeliverablesScreen +
PurchaseUnpackScreen + dropRow, behind EXPO_PUBLIC_FF_DELIVERABLES (src/config/featureFlags.ts ~160-184; OFF in eas.json "clinic", which
extends "production"). b#798 (buyer signed-URL route) and m#434 (rows open files; delivered meal plan opens the right plan) are MERGED; read
ops/reports/B-DELIV-125.md and AUDIT-18-125.md first. Do, in order:
1. Trace the COACH flow end to end on current main, mobile + backend: Packages -> create/edit package -> Contents (or whatever screen
   attaches content) -> upload a PDF and a video (which storage: Supabase bucket / Mux; are the needed keys present? production secret
   names are listed in /tmp/flysecrets.txt) -> attach to the package / schedule the drop -> a client buys -> the drop is delivered ->
   the buyer opens it. For each step: works / broken (file:line) / missing. Any extra mobile flag gating the coach side?
2. Open ONE mobile PR (under 400 lines): set EXPO_PUBLIC_FF_DELIVERABLES "true" in eas.json for the profile(s) the 10-07 build uses
   ("clinic" via "production"; keep preview consistent) AND fix any small break you found in the coach attach flow or the buyer screens.
   If the coach flow needs backend changes, open ONE backend PR (under 300 lines). If the coach flow cannot be made robust in this box,
   say so plainly and still open the flag PR but mark it DO NOT MERGE in its title, so the operator decides.
3. Report /home/user/workspace/ops/reports/B-DROPS-125.md with the step table, B/U/C, PRs and heads. READY comments per _COMMON_125
   item 5 with job B-DROPS-125. Never merge or deploy.

## B-LEADER-125 (Claude Opus 5.5, auditor-builder, T3 privacy) — leaderboard inside Community. Time box 25 min (hard stop 15:30).
Owner 15:06: "Leaderboard: seems like a simple addition to flip on if it has great usability and good mobile screen path placement -
shopuld be near/inside the community space?" Facts (operator 15:08): backend src/leaderboard/ (opt-in, coach-roster scoped, recompute
scheduler) is ALREADY ON in production by default (LEADERBOARD_ENABLED unset = 'on'; leaderboard.service.ts:100, scheduler.ts:36).
Mobile LeaderboardScreen + LeaderboardSettingsScreen are registered in MoreStack (src/navigation/ClientNavigator.tsx ~506) but NOTHING
navigates to them (read src/screens/client/LEADERBOARD.md). The Community tab is ON in the clinic build (EXPO_PUBLIC_FF_COMMUNITY_TAB,
_HALL, _COHORTS). Do:
1. Quick audit (10 min): what the score is made of and whether it is truthful; opt-in default OFF and display name only (no health
   numbers, no full names, no other coach's clients); works for a coachless client (empty/hidden, never an error); loading/error/empty
   states; contrast and screen-reader labels. B/U/C per _COMMON_125.
2. ONE mobile PR (under 300 lines): a clear entry point inside the Community tab (e.g. a "Leaderboard" header action or a top row on the
   Hall that opens Leaderboard; opt-in settings reachable from that screen), registered on the navigator the Community tab uses (do
   not rely on cross-stack navigation that breaks back behaviour), plus any small fix from step 1. Tests for the entry point and the
   coachless case. If the audit finds a privacy B you cannot fix in the box, open no entry-point PR and report NO-GO.
Report /home/user/workspace/ops/reports/B-LEADER-125.md. READY comment per _COMMON_125 item 5 with job B-LEADER-125. Never merge/deploy.

## P-AIB-125 (Claude Opus 5.5, PLANNER, read-only) — AI master workout builder plan for agent 126. Time box 25 min (hard stop 16:10).
Owner 15:40, verbatim: "lets build it - world class, better UI and UX than any competitor, more per client intelligent, and smooth
transitions with haptic feedback layered in. I want the FUN part of being a trainer to be fun in-app. But, dont turn it off or hide it.
Push it live and ON! Lets get a planner agent on that for agent 126 - notated as his responsibility to do!"
Agent 126 (next operator, fresh budget, tonight; agent 127 after) EXECUTES this plan; you only plan. Inputs: the "AI MASTER WORKOUT
BUILDER" section of /home/user/workspace/tgp-agent-context/handoffs/op-125/HANDOFF.md (AIB-1..6 sketch), ops/reports/SAFE-MWBAI-125.md
(the 5 blockers, file:line), ops/reports/AUDIT-14-125.md (live per-client generator), ops/reports/AUDIT-07-125.md and any MWB/workout
builder audit, the mobile master workout builder screens and src/ai/gateway + src/ai/coach on current main (RO worktrees, git fetch +
git show origin/main:...). Deliver /home/user/workspace/tgp-agent-context/handoffs/op-125/AI_MASTER_BUILDER_PLAN.md (copy to
ops/reports/P-AIB-125.md), plain words first, then engineering:
1. Product: 5-8 coach jobs it nails (new program from a goal, edit by sentence, injury swaps, progress/deload a week, turn a template into
   a client-specific block, explain a change); the exact screens and taps (entry points in the builder and on the client page, prompt bar,
   quick-action chips, live diff preview with accept all / per change / undo, revision history); the "fun" layer (motion and transitions,
   expo-haptics moments: check it is installed, light on chip tap, success on accept, warning on reject; streaming or staged reveal so it
   feels alive; copy voice). A short competitor benchmark (Everfit, Trainerize, TrueCoach and 1-2 AI-first apps; web research with links)
   and what makes ours better.
2. Per-client intelligence: which signals feed the prompt (consultation goals, equipment, schedule, injuries and limitations, training
   history and logged loads, adherence, check-ins, recovery from Health Connect / Apple Health, coach's own past programs and style), how
   each is minimised and consent-gated (AI consent ledger), and how the coach's style is learned without Roman v1.1 being required.
3. Safety built in, not bolted on: the 12-point checklist from the SAFETY PASSES block in /home/user/workspace/ops/lanes125/JOBS125.md as
   acceptance criteria of the PRs; exercise-library ids only; hard bounds; injury/contraindication handling; no medical claims; coach
   approval of every change before any client sees it (the coach IS the approver; fix ai-approval.service.ts:92); metering against the
   coach AI pool with a clear out-of-credits state.
4. Launch state per the owner: ON and visible in the 10-07 build. Exact flags/values: backend FEATURE_MWB_AI_LIVE_CREATE, AI_GATEWAY_ENABLED,
   AI_GATEWAY_PROVIDER, AI_GATEWAY_CAPABILITIES (workout capabilities only), any mobile EXPO_PUBLIC_FF_* in eas.json clinic; the manifest
   PR; the kill switch for emergencies (server-side, no build).
5. PR slices in merge order: repo, title, files, ~lines (each under 600, hard cap 1500), tier, tests that must fail on main, dependencies,
   which can run in parallel, and model choice per call (current Anthropic ids are in ops/reports/B-ROMANIQ-125.md: claude-sonnet-5-5,
   claude-opus-5-5). A timeline for tonight (agents 126 then 127) so every mobile PR merges before the 10-07 build (assume build at
   10:00 PDT 10-07 unless the SoT says otherwise), with a cut line: what ships in the build if time runs short, and what follows in 1.1.
6. A ready-to-paste JOBS entry for each builder (same format as JOBS125.md entries), so agent 126 can launch them in minutes.
Read-only: no PRs, no pushes except committing the plan file to tgp-agent-context main (git pull first; commit as Bradley Gleave
<bradley@bradleytgpcoaching.com>; never name the clinic partner).

# LATE WAVE (owner 15:42: "spin up two more or 4 more agents to keep progress going! I want more PR progression before agent 126's takeover!")
Builders: hard stop 16:20, one PR each unless stated, READY comment per _COMMON_125 item 5. Lens pair L4 (Opus + Sol) reviews them.

## B-AIB1-125 (Claude Opus 5.5, builder, T4 money/AI) — AI builder foundations (AIB-1 of the AI MASTER WORKOUT BUILDER plan).
Read ops/reports/SAFE-MWBAI-125.md ("Not fixed" 1-2) and ops/reports/AUDIT-14-125.md (U2, U4, "Not fixed" 2-3) first. Two backend PRs:
PR-A metering: add 'draft.create_workout_plan' and 'draft.edit_workout_plan' to COACH_AI_METERED_CAPABILITIES
(src/ai-credits/ai-credits.constants.ts:39-70), AND meter Coach AI v1 (workout_program, meal_plan, client-insight in
src/ai/coach/coach-ai.service.ts): inject CoachAIBudgetService, run the same pre-check as AiGatewayService.invoke before the Anthropic
call (throw the existing budget-exhausted exception), recordUsage after it with the adapter's cost. Tests that fail on main.
PR-B approval: let the tenant coach approve/reject AI-authored drafts of their own clients in ai-approval.service.ts (~92-94: the
requester-cannot-decide rule must not block a coach deciding an AI/system-generated draft; keep it for human-requested drafts in
multi-user tenants), AND first add the roster check + materialised_ref write to SendNotificationMaterializer (AUDIT-14 C). Tests for
coach approves own AI draft, coach cannot decide another coach's client's draft, notification materialiser roster check.
Each PR under 400 lines. Never flip flags.

## B-AIASSIGN-125 (Claude Opus 5.5, builder, T3 workout) — "Approve & assign" really assigns (AUDIT-14 B1).
A coach generates an AI workout program for a client, taps Approve, and the days are not on the client's calendar (only unassigned
library plans are created). Fix exactly as AUDIT-14 "Not fixed" 1 says: in CoachAIService.approveDraft (src/ai/coach/coach-ai.service.ts
~255), after materializeWorkoutProgram, in one transaction write one ClientWorkoutAssignment + snapshot per created plan, reusing the
WorkoutBuilderService assignment fan-out (offset (week-1)*7 + (day-1) from a start date: next Monday in the client's timezone unless the
draft has one), one push to the client, and return `assigned_count` (mobile m#425 already reads it and switches its copy). Idempotent
on double-tap approve. Tests that fail on main. One backend PR under 400 lines. Do not touch src/ai/gateway or ai-approval.service.ts
(B-AIB1-125 owns them).

## L4-OPUS-125 / L4-SOL-125 (lens pair) — review the LATE WAVE PRs (B-AIB1-125 PR-A and PR-B, B-AIASSIGN-125) as they post READY,
plus any delta. Same lens rules as L3 (verdict comment at the exact head: "<Opus|Sol> verdict @ <sha>: APPROVE|REQUEST CHANGES B=<n>").
T4: money and AI approval paths get the full 12-point AI checklist from the SAFETY PASSES block where relevant. Stop 16:35 or at WRAP UP.

# FINAL WAVE (owner 16:58: "39.7k/45k creedits used - scale up to 3 agents to keep using your credits")
## FIX-AIB-125 (Claude Opus 5.5, fixer, T4) — one fix round each on backend #805 and #807. Hard stop 17:35.
Read ops/reports/L4-OPUS-125.md, ops/reports/L4-SOL-125.md and ops/reports/B-AIB1-125.md first; the verdict comments are on the PRs.
1. #807 (agent125/b-aib1-approve @ 0cdafb37) Opus B=1: a solo coach can approve their own assign-workout / assign-meal-plan draft that
   names another coach's client; that client gets the plan and a push. Fix in ai-approval.service.ts (~10 lines): refuse when any client
   id in the draft payload does not match the draft's client (and that client is not on the deciding coach's roster). Test that fails on
   the old head.
2. #805 (agent125/b-aib1-meter @ 41493e41) Sol B=1: sequential generations against a nearly empty coach AI pool skip debits. Make the
   pre-check + debit correct for back-to-back calls (reserve or re-check against the latest balance; never let a completed call go
   un-debited). Also merge origin/main in (b#806 merged; one import-line conflict in coach-ai.service.ts). Tests that fail on the old head.
Merge main in, never rebase or force-push. One push per PR if possible. Post a delta comment per PR: "FIX ROUND <n> DELTA <old>..<new>:
<what changed>" and a READY comment per _COMMON_125 item 5. Never merge or deploy.

## L5-OPUS-125 / L5-SOL-125 (lens pair) — review #805 and #807 at their NEW heads after FIX-AIB-125 posts READY (poll gh pr view every few
minutes; full review, the deltas are T4 money/AI). VERDICT FORMAT IS MANDATORY (ops/merge_if_dual.sh parses it): the comment's FIRST LINE
must be exactly
  AUDIT Claude Opus 5.5 (L5-OPUS-125) — growth-project-backend#<n> @ <40-hex head> — VERDICT: APPROVE        (or REQUEST CHANGES)
  AUDIT GPT-6.1 Sol (L5-SOL-125) — growth-project-backend#<n> @ <40-hex head> — VERDICT: APPROVE            (or REQUEST CHANGES)
then B/U/C counts and findings. Re-check the head right before posting. Stop 17:50.

# HEAD-START WAVE (owner 17:09: "wall clock time is the main constraint now - use your last 4k credits asap without any wasted work")
## HS-AIB5-125, HS-AIB4-125 and HS-AIB2-125 (Claude Opus 5.5 builders; HS-AIB2 runs plan entry "B-AIB2-126", added 17:23) — head start on agent 126's AI master builder PRs.
Run the entry "B-AIB5-126" (HS-AIB5) or "B-AIB4-126" (HS-AIB4) from tgp-agent-context/handoffs/op-125/AI_MASTER_BUILDER_PLAN.md
section 8 exactly, as an agent 125 worker under _COMMON_125 (not _COMMON_126). Read PART 1 "Exact screens and taps" / "The fun layer"
and PART 2 sections 2, 3 and 5 of the plan first. Use the branch name the entry gives (or agent126/<entry-slug> if none).
NO WASTED WORK RULE: this session may run out of credits at any minute. Commit and push to the branch at least every 15 minutes, and
open a DRAFT PR at the first push whose body keeps an up-to-date checklist "Done / Remaining / Next step" so agent 126's builder can
continue on the same branch without re-reading anything. Merge main in, never rebase or force-push. When the work is complete and CI
green, mark the PR ready and post the READY comment per _COMMON_125 item 5. Hard stop 18:15 PDT. Never merge, deploy or flip flags.
