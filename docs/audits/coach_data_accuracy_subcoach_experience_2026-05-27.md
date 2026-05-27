**Coach Data Accuracy & Sub-Coach Experience --- Prioritized Issue Register**

*All findings from direct source inspection of BradleyGleavePortfolio/growth-project-backend. Issues are ordered by priority: P0 (experience-breaking, fix immediately) → P1 (data integrity, fix soon).*

**🔴 P0 --- Experience-Breaking: Fix Before Any Coach Onboards a Sub-Coach**

**SC-1 --- Sub-Coaches Are Completely Blocked From the Command Center**

**The Problem**

src/coach/command-center/command-center.controller.ts:62 applies \@UseGuards(JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard) at the class level. src/common/guards/no-active-sub-coach.guard.ts:15--18 throws ForbiddenException for any user with an active TeamSubCoachAssignment row. The guard message says \"billing or financial surfaces\" --- but it is applied to the **entire** Command Center: overview, at-risk, win-streaks, inbox, and action-queue. None of these are financial endpoints.

A sub-coach who opens the app sees a completely blank Command Center. No roster overview, no at-risk clients, no win-streaks, no inbox. They have been assigned clients and have no operational view of them whatsoever. The guard was intended to block sub-coaches from the ltv-metrics controller (which is genuinely financial) but was applied at the wrong level and now gates the entire coaching operational surface.

**Big-Picture Solution**

Remove NoActiveSubCoachGuard from CommandCenterController entirely. Move it only to LtvMetricsController and any billing-adjacent controllers where financial data genuinely should be head-coach-only. This is a one-line change on command-center.controller.ts:62 --- remove the guard from the class decorator. Note that this fix alone is not sufficient: SC-2 must also be fixed simultaneously, otherwise sub-coaches are unblocked but still see empty data.

**SC-2 --- Command Center Queries Scope by User.coach_id, Which Is Always the Head Coach\'s ID for Sub-Coaches**

**The Problem**

Even after removing the guard (SC-1), every query in command-center.service.ts resolves clients via where: { coach_id: coachId, role: \'student\', deleted_at: null }. Under the Phase 11 overlay model (documented in sub-coach-assignment.service.ts:17--29): \"User.coach_id ALWAYS points at the head coach.\" A sub-coach\'s ID never appears in User.coach_id --- their clients are scoped through SubCoachAssignment rows.

This means getOverview(), getAtRisk(), getWinStreaks(), getInbox(), and getActionQueue() all return zero clients for any sub-coach, regardless of how many clients they\'ve been assigned. The SubCoachScopeService.getAuthorizedClientIds() method exists precisely to solve this (sub-coach-scope.service.ts:50--78) but is never called from the Command Center.

**Big-Picture Solution**

Inject SubCoachScopeService into CommandCenterService. At the top of each public method, replace the inline prisma.user.findMany({ where: { coach_id: coachId } }) roster resolution with:

const clientIds = await this.subCoachScope.getAuthorizedClientIds(coachId);

getAuthorizedClientIds() already handles both cases: head coaches get their full roster via User.coach_id; sub-coaches get their assigned clients via SubCoachAssignment. The clientIds array is already the input to every subsequent query in each service method --- no further logic changes required. SC-1 and SC-2 together are a two-file fix that fully restores the Command Center for sub-coaches.

**SC-3 --- Sub-Coach Engagement Score Rewards Sending One Message Over Reviewing 40 Client Check-Ins**

**The Problem**

sub-coach-analytics.service.ts:52--60 --- Signal 1, worth +20 points out of 100 --- detects sub-coach activity by checking whether the sub-coach sent at least one CoachMessage in the last 7 days. The code comment admits this is a proxy: // +20 logged in within 7 days (proxy: sent at least one message in the last 7 days).

The outcome is perverse:

-   A sub-coach who logs in every day, reads every check-in, approves every workout, and reviews all client progress but sends no messages: **0/20**

-   A sub-coach who sends one message on Monday and ignores the platform all week: **20/20**

This is the single highest-weighted individual signal in the scoring model. It actively punishes the most conscientious sub-coaches (who let their clients lead conversations) and rewards superficial engagement. A head coach using this score to evaluate their team is being given backwards information.

The other three signals have similar proxy problems: Signal 2 checks \"responded within 48h of a check-in\" (good), Signal 3 checks \"created or updated a workout routine this calendar week\" (reasonable), Signal 4 checks \"≥70% session-day adherence across the team\" (correct concept, right metric). Signal 1 is the outlier that corrupts the entire score.

**Big-Picture Solution**

Replace Signal 1 with a composite \"active coaching\" signal built from actions that only happen when the sub-coach is genuinely working:

-   **Check-in review**: Did the sub-coach open (read) any client check-in this week? Track via a CheckInRead event or a read_at timestamp on CheckIn rows. Worth +10.

-   **Workout approval**: Did the sub-coach approve or reject any pending workout this week? This is already an auditable action. Worth +10.

If neither event type exists yet, add a coach_session signal emission on any authenticated request from a coach-role user (lightweight middleware, fires once per hour per user to avoid noise). Signal 1 then becomes: clientSignal.findFirst({ where: { user_id: subCoachId, signal_type: \'coach_session\', recorded_at: { gte: sevenDaysAgo } } }). This correctly answers \"was this sub-coach actively using the platform this week\" without requiring them to send a message.

**SC-4 --- Client Assignment and Reassignment Send No Notification to the Affected Client**

**The Problem**

sub-coach-reassign.service.ts --- the single entry point for all client → sub-coach assignment changes --- contains zero notification dispatches. Searching the file for notification, notify, push, emitter, and nudge returns no results. When a head coach assigns a client to a sub-coach, or moves a client from one sub-coach to another, the client receives no communication of any kind.

The client opens the app and discovers a stranger is now reviewing their check-ins, approving their workouts, and managing their programme --- with no explanation. They have no context that a change has occurred, no introduction to the new coach, and no acknowledgement that their previous coaching relationship has ended. Most clients will interpret this as a platform malfunction. The silent handoff is especially damaging for fitness coaching because the client-coach relationship is personal: trust in the platform depends on feeling that the platform is in control of these transitions, not hiding them.

**Big-Picture Solution**

After the serializable transaction commits in runReassignTransaction(), dispatch three actions:

**1. Notify the client** via push notification + automatic in-app message from the new sub-coach:

\"Hi \[client name\], I\'m \[sub-coach first name\] and I\'ll be your coach from here. Looking forward to working with you --- feel free to message me anytime! 👋\"

This message is created via MessagingService.sendAsCoach(newSubCoachId, clientId, { body: \... }) using the same pattern as all other coach messages. It creates a natural conversation starter and immediately establishes the new coaching relationship.

**2. Notify the new sub-coach** via push: \"\[Client name\] has been added to your roster.\" with a deep link to the client profile.

**3. Notify the previous sub-coach** (on reassignment, not first assignment): \"\[Client name\] has been moved to another coach\'s roster.\" --- so they are not left wondering why the client disappeared from their list.

All three notifications use NotificationsService and CoachAlertEmitter which already exist in src/notifications/. The AuditLog entry already written at the end of the transaction serves as the traceable record. This is a pure wiring task --- no new infrastructure required.

**🟡 P1 --- Data Integrity: Fix Before Coaches Make Decisions From These Numbers**

**CC-1 --- pending_actions Is a Duplicate of open_alerts**

**The Problem**

command-center.service.ts:255 returns pending_actions: openAlerts. Line 252 also returns open_alerts: openAlerts. These are the same variable. The Command Center shows two KPI tiles displaying identical numbers. A coach seeing \"Open Alerts: 4\" and \"Pending Actions: 4\" cannot distinguish between them because there is no distinction. One tile is meaningless.

**Big-Picture Solution**

pending_actions should be a compound count of items requiring direct coach action: pending workout approvals + threads where is_coach_turn = true + flagged weight logs not yet acknowledged. All of this data is available in the same Promise.all block that populates getOverview(). This separates \"things TGP has flagged\" (open_alerts) from \"things you need to actively do right now\" (pending_actions) --- a meaningful and useful distinction for a coach starting their day.

**CC-2 --- active_today Counts Internal System Signal Events, Not Client Check-Ins**

**The Problem**

command-center.service.ts:186--189 computes active_today from ClientSignal rows where recorded_at \>= oneDayAgo. ClientSignal includes PTM model recalculations, background streak updates, weight log writes, and system events --- not just coach-visible check-in forms. A client who submitted no check-in but had a background PTM prediction run at midnight appears as \"active today.\" Meanwhile check_in_rate_7day queries the actual CheckIn table --- so these two metrics measure different things with no explanation.

**Big-Picture Solution**

Change active_today to query CheckIn WHERE logged_at \>= today_midnight in the coach\'s timezone --- the same table as check_in_rate_7day. Both tiles then measure the same thing (submitted check-in forms) at different time windows. If tracking raw app sessions is separately valuable, add a distinct last_seen_today tile querying ClientSignal with a clear label, so \"checked in\" and \"opened the app\" are never conflated.

**CC-3 --- At-Risk top_factor Gives Coaches Three Generic Strings Instead of Real PTM Factors**

**The Problem**

command-center.service.ts:302--310 --- topFactorLabel() --- produces one of: \"No recent activity\", \"No app activity in N days\", \"High churn risk --- multiple signals fired\", or \"Declining engagement signals.\" The PtmPrediction.factors column contains per-factor contribution data (e.g. \"streak dropped 14→0, contribution −0.28\") which is already parsed and surfaced correctly in churn-intervention.service.ts:246--247. The command center ignores this column entirely.

**Big-Picture Solution**

Include the factors column in getRiskBoardForCoach(). Replace topFactorLabel() with parseFactors(p.factors).label --- the same logic already proven in churn-intervention.service.ts. Coaches see the actual behavioural reason for a red/amber flag (e.g. \"No check-in in 9 days\", \"Streak dropped from 14 to 0\", \"Weight not logged this week\") rather than a generic bucket label.

**CC-4 --- Inbox Builds Thread State From 1,000 Messages In-Memory: Threads Beyond Position 1,000 Disappear**

**The Problem**

command-center.service.ts:425--448 fetches the most recent 1,000 CoachMessage rows and iterates them in JavaScript to build a per-client thread map. A coach with a long message history may have threads whose last message was beyond position 1,000. Those threads never appear in the inbox. The coach sees total_unread: 3 but only 2 threads visible --- the missing thread has unread messages counted in the total but no visible row to tap.

**Big-Picture Solution**

Replace with a findMany({ distinct: \[\'client_id\'\], orderBy: \[{ client_id: \'asc\' }, { created_at: \'desc\' }\] }) query. This returns exactly one row per thread (the latest message) with no row limit, using the existing index. Thread count is always accurate regardless of message history depth.

**CC-5 --- Check-In Rate Is Binary Participation, Not Adherence**

**The Problem**

command-center.service.ts:242 divides the count of distinct clients who checked in at least once in 7 days by rosterSize. A client who checked in once in 7 days is counted identically to one who checked in all 7 days. A coach with 10 clients each checking in once gets check_in_rate_7day: 1.0 --- displayed as 100% --- even though average daily adherence is 14%.

**Big-Picture Solution**

Change the numerator from distinct user_ids to total check-in rows submitted. Divide by rosterSize × 7. Rename the field check_in_adherence_7day. The coach sees \"your clients submitted 43% of expected check-ins last week\" --- an honest signal that drives intervention rather than false confidence.

**EFF-1 --- Effectiveness Score riskDeltaComponent Executes 2 DB Queries Per Client in a Loop**

**The Problem**

coach-effectiveness.service.ts:306--330 loops over all eligible clients and issues two sequential prisma.ptmPrediction.findFirst calls per client --- one for the earliest prediction and one for the latest in the 60-day window. A coach with 50 eligible clients = 100 sequential DB round-trips every time the scheduler fires. With 20 coaches on the platform this is 2,000 sequential queries per scheduled run.

**Big-Picture Solution**

Replace the per-client loop with two bulk queries: fetch all predictions within the broadest relevant window for all eligible client IDs in one findMany, then group and filter per-client in memory. Reduces 2N sequential queries to 2 regardless of roster size.

**EFF-2 --- Coaches Cannot See Their Own Effectiveness Score**

**The Problem**

CoachEffectivenessService.getLatest() and listHistory() have no coach-facing controller endpoint. The score is only accessible via the owner-only admin surface. A coach who earns a high score never sees it. A coach who scores poorly gets no signal to improve. The system monitors coaches without giving them the feedback loop that would make the monitoring worthwhile.

**Big-Picture Solution**

Add GET /coach/my-effectiveness to coach.controller.ts scoped to the calling coach\'s own ID. Return the latest score, bucket, component breakdown, and a 30-entry trend history. Coaches see their own performance data and understand which behaviours (messaging frequency, client retention, risk reduction) lift their score.

**EFF-3 --- CoachEffectivenessService Computes Zero Scores for All Sub-Coaches**

**The Problem**

coach-effectiveness.service.ts:207--218 resolves clients via User WHERE coach_id = coachId. For a sub-coach, User.coach_id is always the head coach\'s ID --- so the client list is always empty, and the score always returns { score: 0, bucket: \'developing\', factors: \[empty_roster\] }. Every sub-coach on the platform permanently shows as \"developing\" with zero score on the head coach\'s team dashboard.

**Big-Picture Solution**

Inject SubCoachScopeService. Replace the direct prisma.user.findMany call with SubCoachScopeService.getAuthorizedClientIds(coachId) followed by prisma.user.findMany({ where: { id: { in: clientIds } } }). One change, correct scores for all coaches.

**LTV-1 --- estimated_ltv Is Derived From a 6-Month Industry Average on New Accounts, Displayed as a Real Number**

**The Problem**

ltv-metrics.service.ts:197--207 uses a hardcoded 6-month lifespan stub whenever fewer than 3 cancellations exist. estimated_ltv_cents is computed as rpcmCents × 6 and displayed as a dollar figure. A new coach with 10 clients at \$300/month sees \$1,800 estimated LTV per client --- a number derived entirely from an industry default. The lifespan_is_estimate: true flag is in the API response but the mobile client renders the dollar figure without a visible caveat.

All the data needed for a real calculation already exists in ClientPurchase: created_at (when a client started paying), canceled_at (when they stopped --- non-null means churned), entitlement_active (the canonical \"still paying\" flag), and billing_type = \'recurring\' to filter to subscription clients.

**The Correct LTV Formula Using Existing Data**

**Step 1 --- Churned client tenure:**\
For every recurring purchase where canceled_at IS NOT NULL:

tenure_months = (canceled_at - created_at) / 30.44

This is real historical data --- the exact lifespan of every client who has ever left.

**Step 2 --- Live client tenure (conservative lower bound):**\
For every recurring purchase where entitlement_active = true:

tenure_so_far_months = (now - created_at) / 30.44

Every live client has *at least* this much tenure. Their true final tenure is still growing, so using now is conservative --- it pulls the blended average down slightly, which is the honest direction to err.

**Step 3 --- Blend both pools:**

all_tenures = churned_tenures + live_tenures_so_far\
blended_avg_tenure_months = mean(all_tenures)

As the coach\'s client base matures, live clients age into their real tenure and the blended average converges to the true number automatically --- no manual recalibration ever needed.

**Step 4 --- LTV:**

RPCM = MRR / active_client_count\
LTV = RPCM × blended_avg_tenure_months

**Edge case --- re-subscribers:** A client who cancels and re-subscribes produces two ClientPurchase rows. Group by client_user_id and sum tenure across all rows for that client before averaging. This correctly credits the coach for total relationship length.

**Big-Picture Solution**

Replace the entire stub block in ltv-metrics.service.ts:177--207 with this logic. Remove the 3-cancellation threshold and the 6-month fallback completely --- even one real data point (a single live client who has been subscribed 2 months) produces a more accurate LTV than an industry average. The new calculation degrades gracefully: a brand-new coach with their first client on Day 1 shows a small real tenure number rather than a fabricated 6-month figure.

The mobile UI behaviour changes based on data maturity:

-   **0 clients ever:** Show LTV: --- with tooltip \"Start adding clients to calculate LTV.\"

-   **1--4 total client tenures:** Show the real calculated number with an asterisk and tooltip \"Based on \[N\] client(s) --- will become more accurate as your roster grows.\"

-   **5+ total client tenures:** Show the number with no caveat --- the sample is large enough to trust.

This requires zero schema changes. All required fields (created_at, canceled_at, entitlement_active, billing_type, client_user_id) already exist on ClientPurchase.

**LTV-2 --- net_revenue_retention_pct Is Gross Logo Retention, Not NRR**

**The Problem**

ltv-metrics.service.ts:269--271 computes this as 100 - churn_rate. The code comment explicitly calls it a stub. True NRR credits coaches for clients who upgrade their package --- it can exceed 100%. The current metric cannot exceed 100% and ignores all expansions. A coach who moves half their clients to a higher tier sees no improvement in this number.

**Big-Picture Solution**

Rename the field to gross_logo_retention_pct internally. Display it in the mobile UI as \"Retention Rate\" (not \"NRR\") with a tooltip: \"Calculated as 1 minus your monthly churn rate. True Net Revenue Retention (which credits you for upgrades) is coming soon.\" Add a ClientPurchase.upgraded_from_purchase_id foreign key to enable true NRR once upgrade tracking is built.

**LTV-3 --- zero_churn_streak and all_time_peak_rpcm Are Gamified Vanity Metrics That Are Currently Inaccurate**

**Context**

zero_churn_streak counts consecutive months with zero cancellations. all_time_peak_rpcm is the highest revenue-per-client-per-month the coach has ever achieved. Both are motivational \"personal best\" metrics --- essentially gamification elements designed to encourage coaches to keep their streak alive and chase their peak.

**Are they useful?** Yes, genuinely --- for the right coach. A coach tracking their zero-churn streak will intervene proactively on at-risk clients to protect it. A coach comparing current RPCM to their all-time peak has a concrete target. These are the same mechanics as fitness app streak counters, and they work for the same psychological reasons.

**The current problem** (ltv-metrics.service.ts:279--290): zero_churn_streak is re-computed in-memory from cancellation history on every load. all_time_peak_rpcm calls estimatePeakRpcm() which returns the **current** RPCM --- not a historical maximum --- because the persistence table was never built. A coach who had their best month in March and is now in a slower period sees all_time_peak_rpcm showing today\'s lower number. The streak resets to zero on every cold compute if monthly boundary logic glitches. The metrics are broken, not conceptually wrong.

**Big-Picture Solution**

Build the coach_ltv_peak table:

CREATE TABLE coach_ltv_peak (\
coach_user_id UUID PRIMARY KEY REFERENCES \"User\"(id),\
peak_rpcm_cents INT NOT NULL DEFAULT 0,\
peak_month DATE,\
zero_churn_streak INT NOT NULL DEFAULT 0,\
last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now()\
);

Add a monthly cron (alongside coach-effectiveness.scheduler.ts) that upserts peak_rpcm_cents = MAX(current, existing_peak) and correctly recalculates zero_churn_streak from the month boundary. getMetrics() reads from this table for both fields. The metrics become accurate historical values and the gamification elements work as intended.

**Coach Effectiveness Score --- What Is It?**

The CoachEffectivenessScore is an internally computed 0--100 rating for each coach, calculated on a schedule and stored append-only in CoachEffectivenessScore rows. It is built from four weighted components:

  ----------------------- ----------------------- -----------------------------------------------------------------------------------------------
  Component               Weight                  What It Measures

  Completion              30%                     \% of clients enrolled in the last 120 days who reached a completed_90day outcome

  Risk Delta              25%                     Average reduction in PTM churn-risk score over each client\'s first 60 days

  Retention               25%                     \% of clients still on the platform 60+ days after assignment

  Engagement              20%                     Capped average message exchanges per client per week (cap prevents outliers gaming the score)
  ----------------------- ----------------------- -----------------------------------------------------------------------------------------------

Buckets: developing (\< 50), consistent (50--74), high-performer (≥ 75).

Currently it is used exclusively on the owner\'s admin dashboard to rank coaches. It has the three problems documented above (EFF-1, EFF-2, EFF-3). Once those are fixed, it becomes a genuinely useful tool --- both as an owner management signal and as a coach self-improvement feedback loop.
