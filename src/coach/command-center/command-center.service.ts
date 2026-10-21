// src/coach/command-center/command-center.service.ts
//
// CommandCenterService — backs the 5 P0 endpoints under
// /coach/command-center/* (overview, at-risk, win-streaks, inbox,
// action-queue, dismiss). All reads are scoped to the calling coach's
// roster (req.user.id); a coach never sees data outside their own
// students. Owners pass through CoachGuard and reuse the same code path
// (their req.user.id treated as a coach_id).
//
// Performance:
//   * No N+1 queries — roster IDs are resolved once and reused.
//   * Aggregations run in parallel via Promise.all.
//   * Pagination + limits clamped server-side so a single coach cannot
//     drag the DB to its knees by passing limit=999999.
//
// Privacy:
//   * Raw PTM risk_score and success_score are NEVER returned (Phase 1E
//     doctrine — owner-only). The at-risk endpoint sets risk_score=null
//     for all callers (the AdminPtmService.getRiskBoardForCoach path
//     already does this; we preserve it).

import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AdminPtmService } from '../../admin/ptm/admin-ptm.service';
import { CoachAlertsService, ROMAN_SAFETY_ALERT_TYPES, currentCoachAlerts } from '../coach-alerts.service';
import { SubCoachScopeService } from '../../sub-coach/sub-coach-scope.service';
import { COACH_FITNESS_SCOPES, ConsentScope, ConsentService } from '../../consent/consent.service';
import { CHURN_FACTOR_SCOPES, coachVisibleFactors } from './churn-factor-scopes';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
import { type CoachHomeDay, loadHomeDay } from './coach-home-day';
import type { CoachRiskBoardRow } from '../../admin/ptm/admin-ptm.service';
import type { PtmRiskBucket } from '../../ptm/ptm.types';

// ── Response types (mirrors mobile commandCenterApi.ts) ─────────────────

export interface CommandCenterOverview {
  roster_size: number;
  active_today: number;
  check_in_rate_7day: number;
  open_alerts: number;
  at_risk_count: number;
  win_streak_count: number;
  unread_messages: number;
  pending_actions: number;
  /** HOME-BE: only with ?include=home (see coach-home-day.ts). */
  home?: CoachHomeDay;
}

export interface AtRiskEntry {
  user_id: string;
  display_name: string;
  bucket: 'red' | 'amber' | 'green';
  risk_score: null;
  last_active_at: string | null;
  top_factor: string;
  days_since_checkin: number;
}

export interface AtRiskResponse {
  items: AtRiskEntry[];
  total_at_risk: number;
}

export interface WinStreakEntry {
  user_id: string;
  display_name: string;
  streak_days: number;
  streak_type: 'check_in' | 'workout' | 'weight_log';
  streak_started_at: string;
}

export interface WinStreaksResponse {
  items: WinStreakEntry[];
  total_active_streaks: number;
}

export interface InboxThread {
  thread_id: string;
  client_id: string;
  client_name: string;
  last_message_preview: string;
  last_message_at: string;
  unread_count: number;
  is_coach_turn: boolean;
}

export interface InboxResponse {
  threads: InboxThread[];
  total_unread: number;
}

export type ActionQueueAlertType =
  | 'missed_checkins'
  | 'weight_not_logged'
  | 'no_message_exchange'
  | 'high_churn_risk'
  | 'build_week_gate'
  | 'bloodwork_review'
  | 'roman_urgent_reply'
  | 'roman_eating_disorder_reply'
  | 'roman_crisis_reply';

export interface ActionQueueItem {
  alert_id: string;
  client_id: string;
  client_name: string;
  alert_type: ActionQueueAlertType;
  message: string;
  created_at: string;
  dismissed_at: string | null;
  /**
   * Roman safety alerts only (owner 22a, 57w): the client's message that
   * prompted the reply, in full, and when they sent it. Null once the client
   * deleted that chat, and always null on a crisis alert (ROMAN-CRISIS-ALERT).
   */
  quote?: string | null;
  sent_at?: string | null;
}

/**
 * Owner 57w / 57x: line 1 of the Roman safety alert card, built when the
 * client's current coach reads the queue (the stored row names no one).
 */
const SAFETY_CARD_LINE: Partial<Record<string, (name: string) => string>> = {
  roman_urgent_reply: (name) =>
    `Urgent: Roman sent ${name} a medical safety reply. Check in with them →`,
  roman_eating_disorder_reply: (name) =>
    `Roman sent ${name} an eating-disorder safety reply. Check in with them →`,
  // ROMAN-CRISIS-ALERT, approved word for word: the first name only.
  roman_crisis_reply: (name) =>
    `Roman sent ${name.trim().split(/\s+/)[0] || name} a crisis safety reply. Please check in with them today.`,
};

export interface ActionQueueResponse {
  items: ActionQueueItem[];
  total_pending: number;
}

const ONE_DAY_MS = 86_400_000;

function clamp(n: number | undefined, fallback: number, max: number): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const MAP_ALERT_TYPE_LOGGER = new Logger('mapAlertType');

function mapAlertType(backendType: string): ActionQueueAlertType {
  switch (backendType) {
    case 'risk_red_transition':
      return 'high_churn_risk';
    case 'consecutive_misses':
      return 'missed_checkins';
    case 'streak_dropped':
      return 'missed_checkins';
    case 'finance_eod_gap':
      return 'weight_not_logged';
    case 'bloodwork_review':
      return 'bloodwork_review';
    case 'roman_urgent_reply':
      return 'roman_urgent_reply';
    case 'roman_eating_disorder_reply':
      return 'roman_eating_disorder_reply';
    case 'roman_crisis_reply':
      return 'roman_crisis_reply';
    default:
      // Unknown backend alert types are bucketed as high_churn_risk so
      // the mobile client still renders a row, but log a warning so we
      // notice and add an explicit mapping rather than silently
      // mis-categorising new alert types.
      MAP_ALERT_TYPE_LOGGER.warn(`Unknown alert type: ${backendType}`);
      return 'high_churn_risk';
  }
}

function buildThreadId(id1: string, id2: string): string {
  return [id1, id2].sort().join(':');
}

// CF-SHARE-GATE-128: client ids by Coach sharing switch.
interface SharedClientIds {
  habits: string[]; // "Check-ins and habits": check-in counts and streaks
  workouts: string[]; // "Workouts": workout streaks
  weighIns: string[]; // "Body metrics" (HOME-BE): weigh-ins and goal weight
  allFour: string[]; // all four: the churn-risk score reads all four kinds of logs
}

// CoachAlert types built from a client's logs follow that log's switch:
// missed check-ins and a dropped streak come from check-ins, the red-risk
// alert from the churn-risk score. Other types (finance, bloodwork) are not
// one of the four fitness switches and are unchanged.
const CHECK_IN_ALERT_TYPES = ['consecutive_misses', 'streak_dropped'];
const RISK_ALERT_TYPES = ['risk_red_transition'];

function visibleAlertsWhere(clientIds: string[], shared: SharedClientIds): Prisma.CoachAlertWhereInput {
  return {
    OR: [
      { alert_type: { in: CHECK_IN_ALERT_TYPES }, client_id: { in: shared.habits } },
      { alert_type: { in: RISK_ALERT_TYPES }, client_id: { in: shared.allFour } },
      { alert_type: { notIn: [...CHECK_IN_ALERT_TYPES, ...RISK_ALERT_TYPES] }, client_id: { in: clientIds } },
    ],
  };
}

/**
 * Owner 4 and B-R1F: a Roman safety alert, and the client's message on its
 * card, is for the client's current coach only. The caller must be the
 * client's coach of record: an assistant on the team, or a coach the client
 * has left, never sees, counts or dismisses it. Other alert types keep the
 * team rule.
 */
function safetyAlertsForCurrentCoach(callerId: string): Prisma.CoachAlertWhereInput {
  return {
    AND: [
      {
        OR: [
          { alert_type: { notIn: [...ROMAN_SAFETY_ALERT_TYPES] } },
          currentCoachAlerts(callerId),
        ],
      },
    ],
  };
}

/**
 * Owner 57q and the team chain: an alert is written to the client's coach of
 * record, so a team sub-coach's own client's alerts carry the sub-coach's id
 * and a delegated client's carry the head coach's. A sub-coach's queue reads
 * both; a head coach reads only their own id, as before. Another sub-coach's
 * id is never in the set.
 */
function alertCoachIds(callerId: string, ownerCoachId: string): string | { in: string[] } {
  return ownerCoachId === callerId ? callerId : { in: [ownerCoachId, callerId] };
}

/** One action queue row; a Roman safety alert gets its card line and quote. */
function queueItem(
  alert: {
    id: string;
    client_id: string;
    alert_type: string;
    message: string;
    created_at: Date;
    acknowledged_at: Date | null;
    client?: { name: string | null } | null;
  },
  quote: { content: string; created_at: Date } | undefined,
): ActionQueueItem {
  const clientName = alert.client?.name ?? 'Unknown';
  const line = SAFETY_CARD_LINE[alert.alert_type];
  return {
    alert_id: alert.id,
    client_id: alert.client_id,
    client_name: clientName,
    alert_type: mapAlertType(alert.alert_type),
    message: line ? line(clientName) : alert.message,
    created_at: alert.created_at.toISOString(),
    dismissed_at: alert.acknowledged_at?.toISOString() ?? null,
    ...(line
      ? { quote: quote?.content ?? null, sent_at: quote?.created_at.toISOString() ?? null }
      : {}),
  };
}

// ── CC-3: PtmPrediction.factors parsing ─────────────────────────────────
//
// PtmPrediction.factors is a JSON array of { key, label, contribution }
// objects (highest contribution = strongest churn driver). This mirrors
// the proven logic in churn-intervention.service.ts (PtmFactor / isPtmFactor
// / parseFactors) — replicated here rather than imported because that
// service is owned by another unit (READ-only for this work) and the
// helpers there are file-private. The top factor is factors[0].label after
// sorting by contribution desc.
interface PtmFactor {
  key: string;
  label: string;
  contribution: number;
}

function isPtmFactor(raw: unknown): raw is PtmFactor {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    typeof r.label === 'string' &&
    typeof r.contribution === 'number'
  );
}

function parseFactors(raw: Prisma.JsonValue | null | undefined): PtmFactor[] {
  if (!Array.isArray(raw)) return [];
  const factors: PtmFactor[] = [];
  for (const item of raw) {
    if (isPtmFactor(item)) factors.push(item);
  }
  return factors.sort((a, b) => b.contribution - a.contribution);
}

@Injectable()
export class CommandCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminPtm: AdminPtmService,
    private readonly alertsService: CoachAlertsService,
    // SC-2: SubCoachScopeService is the single source of truth for "which
    // clients can THIS coach see?". A HEAD coach gets their own roster; a
    // SUB-coach gets only their assigned clients (SubCoachAssignment
    // overlay). It is @Optional so the existing positional-construction
    // unit tests (which pass only 3 deps) still build the service; when it
    // is absent we fall back to the legacy head-coach roster query so
    // behaviour is unchanged for head coaches. In production it is wired
    // via the @Global SubCoachModule export.
    @Optional() private readonly subCoachScope?: SubCoachScopeService,
    // CF-SHARE-GATE-128: the client's Coach sharing switches. Deliberately
    // NOT @Optional: ConsentModule is @Global, so DI always injects it and
    // boot fails if it ever cannot. Only positional unit tests omit it.
    private readonly consent?: ConsentService,
  ) {}

  // CF-SHARE-GATE-128, #SHARE-SIMPLE: whose logs the signed-in head or sub-coach (`coachId`) may read:
  // ConsentService's one roster check (the head's id names only alert and message rows). The owner account has
  // no Command Center roster (getAuthorizedClientIds is coach-only), so there
  // is no owner bypass to keep here.
  private async sharedWith(coachId: string, clientIds: string[]): Promise<SharedClientIds> {
    if (!this.consent) {
      return { habits: clientIds, workouts: clientIds, weighIns: clientIds, allFour: clientIds };
    }
    const granted = await this.consent.grantedScopesByClient(coachId, clientIds, COACH_FITNESS_SCOPES);
    const has = (id: string, scope: string) => granted.get(id)?.has(scope) === true;
    return {
      habits: clientIds.filter((id) => has(id, ConsentScope.FITNESS_HABITS_PROGRESS)),
      workouts: clientIds.filter((id) => has(id, ConsentScope.FITNESS_WORKOUTS)),
      weighIns: clientIds.filter((id) => has(id, ConsentScope.FITNESS_BODY_METRICS)),
      allFour: clientIds.filter((id) => COACH_FITNESS_SCOPES.every((s) => has(id, s))),
    };
  }

  // ── SC-2: roster scope resolution ─────────────────────────────────────
  //
  // Resolves the set of client ids the caller may see, plus the
  // `ownerCoachId` under which their CoachAlert / CoachMessage rows are
  // stored. For a head coach both are straightforward (own roster, own id).
  // For a sub-coach: clientIds come from the SubCoachAssignment overlay,
  // while alerts/messages remain owned by the HEAD coach (CoachMessage and
  // CoachAlert carry the head coach's id as coach_id — see
  // SubCoachScopeService.getHeadCoachIdForSubCoach), so we scope those
  // tables by (coach_id = head, client_id IN assigned) rather than the
  // sub-coach's own id. Alerts about the sub-coach's own clients are under
  // the sub-coach's id, so alert reads use alertCoachIds.
  private async resolveScope(
    coachId: string,
  ): Promise<{ clientIds: string[]; ownerCoachId: string }> {
    if (this.subCoachScope) {
      const clientIds = await this.subCoachScope.getAuthorizedClientIds(coachId);
      const headId =
        await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
      return { clientIds, ownerCoachId: headId ?? coachId };
    }
    // Legacy fallback (unit tests / unwired): head-coach roster only.
    const rosterRows = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null },
      select: { id: true },
    });
    return { clientIds: rosterRows.map((r) => r.id), ownerCoachId: coachId };
  }

  // Resolve client ids + a name map for the caller's authorized roster.
  private async resolveScopeWithNames(coachId: string): Promise<{
    clientIds: string[];
    ownerCoachId: string;
    nameMap: Map<string, string>;
  }> {
    const { clientIds, ownerCoachId } = await this.resolveScope(coachId);
    if (clientIds.length === 0) {
      return { clientIds, ownerCoachId, nameMap: new Map() };
    }
    const rows = await this.prisma.user.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true },
    });
    return {
      clientIds,
      ownerCoachId,
      nameMap: new Map(rows.map((r) => [r.id, r.name])),
    };
  }

  // ── /overview ────────────────────────────────────────────────────────
  // HOME-BE: `home` adds the coach Home's day (coach-home-day.ts); `now` is
  // for tests. Without it the response and its queries are unchanged.
  async getOverview(
    coachId: string,
    opts: { home?: boolean; now?: Date } = {},
  ): Promise<CommandCenterOverview> {
    const at = opts.now ?? new Date();
    const zone = opts.home
      ? resolveRecipientTimeZone(this.prisma, coachId).then((z) => z ?? 'America/Los_Angeles')
      : undefined;
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * ONE_DAY_MS);
    const oneDayAgo = new Date(now - ONE_DAY_MS);

    // SC-2: roster scoping now flows through SubCoachScopeService. A head
    // coach sees their full roster; a sub-coach sees only their assigned
    // clients. `ownerCoachId` is the head coach id under which CoachAlert /
    // CoachMessage rows are stored (sub-coaches share the head's threads).
    const { clientIds, ownerCoachId } = await this.resolveScope(coachId);
    const rosterSize = clientIds.length;

    if (rosterSize === 0) {
      const none = { habits: [], workouts: [], weighIns: [], needsYou: [] };
      return {
        roster_size: 0,
        active_today: 0,
        check_in_rate_7day: 0,
        open_alerts: 0,
        at_risk_count: 0,
        win_streak_count: 0,
        unread_messages: 0,
        pending_actions: 0,
        ...(zone
          ? { home: await loadHomeDay(this.prisma, { coachId, ownerCoachId, clientIds, ...none }, await zone, at) }
          : {}),
      };
    }

    // CF-SHARE-GATE-128: check-in tiles and streaks read only clients who
    // share Check-ins and habits; the at-risk count only clients who share all
    // four; alerts follow visibleAlertsWhere. Messages are not a switch.
    const shared = await this.sharedWith(coachId, clientIds);

    const [
      activeTodayGroups,
      checkInsLast7dCount,
      openAlerts,
      pendingActions,
      latestPredictionGroups,
      winStreakGroups,
      unreadMessages,
    ] = await Promise.all([
      // CC-2: active_today = clients with a REAL CheckIn in the last 24h.
      // Previously this counted ClientSignal rows (PTM recalcs, streak
      // updates, app_open pings) which are system-generated telemetry, not
      // deliberate client activity, so the tile over-counted. CheckIn is the
      // actual "client showed up and logged" event. groupBy(user_id) gives
      // DISTINCT active clients (a client who checked in twice counts once).
      this.prisma.checkIn.groupBy({
        by: ['user_id'],
        where: { user_id: { in: shared.habits }, logged_at: { gte: oneDayAgo } },
        _count: { _all: true },
      }),
      // CC-5: total check-in EVENTS across the roster in the last 7d (not the
      // number of distinct clients) so the rate below is a frequency.
      this.prisma.checkIn.count({
        where: {
          user_id: { in: shared.habits },
          logged_at: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.coachAlert.count({
        where: {
          coach_id: alertCoachIds(coachId, ownerCoachId),
          client_id: { in: clientIds },
          acknowledged_at: null,
          ...visibleAlertsWhere(clientIds, shared),
          ...safetyAlertsForCurrentCoach(coachId),
        },
      }),
      // CC-1: pending_actions is a DISTINCT source from open_alerts. Open
      // alerts are proactive system-fired CoachAlert rows; pending actions
      // are unreviewed client check-ins still awaiting the coach's review
      // (CheckIn.reviewed_by_coach = false). This is the genuine "coach has
      // work queued" count the tile is meant to surface, and it moves
      // independently of the alert count. (Chosen interpretation — the
      // controller has no separate task-queue table; reviewed_by_coach is
      // the schema's explicit per-item coach-action flag.)
      this.prisma.checkIn.count({
        where: { user_id: { in: shared.habits }, reviewed_by_coach: false },
      }),
      this.prisma.ptmPrediction.groupBy({
        by: ['user_id'],
        where: { user_id: { in: shared.allFour } },
        _max: { computed_at: true },
      }),
      this.prisma.clientSignal.groupBy({
        by: ['user_id'],
        where: {
          user_id: { in: shared.habits },
          signal_type: 'checkin_streak',
          value: { gte: 3 },
          recorded_at: { gte: sevenDaysAgo },
        },
        _max: { value: true },
      }),
      // CC+SC P1c: unread-for-coach counts only messages SENT BY THE CLIENT
      // (sender_id IN the scoped client set). The previous filter
      // `NOT: { sender_id: ownerCoachId }` excluded only the HEAD coach's
      // own sends, so a message sent by a SUB-coach (sender_id = subCoachId,
      // which is neither ownerCoachId nor a client) was mis-counted as
      // unread / client-side. A client only ever sends in their own thread,
      // so `sender_id IN clientIds` is exactly "sent by a client"; every
      // coach-side send (head OR sub) is excluded because their ids are not
      // in the client set. Head-coach semantics are unchanged.
      this.prisma.coachMessage.count({
        where: {
          coach_id: ownerCoachId,
          client_id: { in: clientIds },
          read_at: null,
          sender_id: { in: clientIds },
        },
      }),
    ]);

    // At-risk count: fetch latest prediction per user, count those with risk > 0.3
    let atRiskCount = 0;
    let atRiskIds: string[] = [];
    const orPairs = latestPredictionGroups
      .filter((g) => g._max.computed_at != null)
      .map((g) => ({
        user_id: g.user_id,
        computed_at: g._max.computed_at as Date,
      }));
    if (orPairs.length > 0) {
      const where = { OR: orPairs };
      if (zone) {
        // HOME-BE: Needs you needs the ids; the default read below is unchanged.
        const latest = await this.prisma.ptmPrediction.findMany({ where, select: { user_id: true, risk_score: true } });
        atRiskIds = latest.filter((p) => p.risk_score > 0.3).map((p) => p.user_id);
        atRiskCount = atRiskIds.length;
      } else {
        const latestPredictions = await this.prisma.ptmPrediction.findMany({ where, select: { risk_score: true } });
        atRiskCount = latestPredictions.filter((p) => p.risk_score > 0.3).length;
      }
    }

    // CC-5: check_in_rate_7day is an adherence FREQUENCY, not binary
    // participation. The old formula counted DISTINCT clients with ≥1
    // check-in in 7d divided by roster size, so 10 clients each logging a
    // single check-in showed 100% — indistinguishable from 10 clients
    // logging daily. The intended KPI is "how completely did the roster
    // hit its expected check-ins?":
    //
    //   rate = total check-in events (7d) / (rosterSize * 7)
    //
    // expecting one check-in per client per day (7 per client per week).
    // Clamped to [0,1] so an over-achiever roster can't exceed 100%.
    // Of the clients whose check-ins this coach can see.
    const expectedCheckIns = shared.habits.length * 7;
    const checkInRate =
      expectedCheckIns > 0
        ? Math.min(checkInsLast7dCount / expectedCheckIns, 1)
        : 0;

    return {
      roster_size: rosterSize,
      active_today: activeTodayGroups.length,
      check_in_rate_7day: Math.round(checkInRate * 100) / 100,
      open_alerts: openAlerts,
      at_risk_count: atRiskCount,
      win_streak_count: winStreakGroups.length,
      unread_messages: unreadMessages,
      pending_actions: pendingActions,
      // Needs you is the at-risk set above (the phone's Needs-you list).
      ...(zone
        ? {
            home: await loadHomeDay(
              this.prisma,
              { coachId, ownerCoachId, clientIds, ...shared, needsYou: [...new Set(atRiskIds)] },
              await zone,
              at,
            ),
          }
        : {}),
    };
  }

  // ── /at-risk ─────────────────────────────────────────────────────────
  async getAtRisk(
    coachId: string,
    opts: { bucket?: 'red' | 'amber'; limit?: number },
  ): Promise<AtRiskResponse> {
    const limit = clamp(opts.limit, 50, 100);

    // P1a (CC+SC): resolve the authorized client-id set FIRST and build the
    // risk board against THAT set. Previously the board was built with the
    // raw `coachId`, which makes getRiskBoardForCoach derive the roster from
    // `User.coach_id = coachId`. For a sub-coach that yields NOTHING (their
    // assigned clients belong to the head coach, not to the sub-coach via
    // coach_id), so the at-risk list came back EMPTY before we even reached
    // the intersection below. Passing `clientIds` makes the board score
    // exactly the clients the caller may see. For a head coach `clientIds`
    // is their full roster, so the board is identical to before — behaviour
    // unchanged.
    const { clientIds: rosterIds } = await this.resolveScope(coachId);
    // CF-SHARE-GATE-128: the churn-risk score and its top factor read all four
    // kinds of logs, so a client appears here only while sharing all four.
    const { allFour: clientIds } = await this.sharedWith(coachId, rosterIds);
    if (clientIds.length === 0) {
      return { items: [], total_at_risk: 0 };
    }
    const board = await this.adminPtm.getRiskBoardForCoach(coachId, {
      bucket: opts.bucket as PtmRiskBucket | undefined,
      limit,
      clientIds,
    });

    // Defence-in-depth: the board is already scoped to `clientIds`, but we
    // still intersect so any future change to the board path cannot widen
    // the visible set. (For both head and sub coach this is now a no-op.)
    const allowed = new Set(clientIds);
    const scoped = board.data.filter((row) => allowed.has(row.user_id));

    const filtered = opts.bucket
      ? scoped
      : scoped.filter(
          (row) => row.bucket === 'red' || row.bucket === 'amber',
        );

    // CC-3: surface the REAL top churn factor from PtmPrediction.factors.
    // The risk board (Phase 1E) intentionally omits the factors blob, so we
    // read the latest prediction per displayed user and parse its factors
    // (sorted by contribution desc — same approach proven in
    // churn-intervention.service.ts). Falls back to an activity-based label
    // only when a user has no parseable factors.
    const topFactorMap = await this.loadTopFactors(
      coachId,
      filtered.map((r) => r.user_id),
    );

    const now = Date.now();
    const items: AtRiskEntry[] = filtered.map((row) => {
      const lastSignalMs = row.last_signal_at
        ? new Date(row.last_signal_at).getTime()
        : null;
      // New clients (no signal yet) get 0, not 999, so the UI doesn't
      // present them as catastrophically inactive.
      const daysSinceSignal =
        lastSignalMs != null
          ? Math.max(0, Math.floor((now - lastSignalMs) / ONE_DAY_MS))
          : 0;

      return {
        user_id: row.user_id,
        display_name: row.name,
        bucket: row.bucket as 'red' | 'amber' | 'green',
        risk_score: null,
        last_active_at: row.last_signal_at,
        top_factor: this.topFactorLabel(row, topFactorMap.get(row.user_id)),
        days_since_checkin: daysSinceSignal,
      };
    });

    return { items, total_at_risk: items.length };
  }

  // CC-3: load the highest-contribution factor LABEL per user from the
  // latest PtmPrediction.factors blob. Returns a map user_id -> label (only
  // for users that have at least one parseable factor).
  // CHURN-LABELS-132: only a factor the client shares with this coach, under
  // the same grant as sharedWith (churn-factor-scopes.ts).
  private async loadTopFactors(
    coachId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (userIds.length === 0) return result;

    // Latest prediction per user (mirrors the (user_id, computed_at) index).
    const groups = await this.prisma.ptmPrediction.groupBy({
      by: ['user_id'],
      where: { user_id: { in: userIds } },
      _max: { computed_at: true },
    });
    const orPairs = groups
      .filter((g) => g._max.computed_at != null)
      .map((g) => ({
        user_id: g.user_id,
        computed_at: g._max.computed_at as Date,
      }));
    if (orPairs.length === 0) return result;

    const predictions = await this.prisma.ptmPrediction.findMany({
      where: { OR: orPairs },
      select: { user_id: true, factors: true },
    });
    const granted = this.consent
      ? await this.consent.grantedScopesByClient(coachId, userIds, CHURN_FACTOR_SCOPES)
      : null;
    for (const p of predictions) {
      const shared = granted === null ? 'all' : granted.get(p.user_id) ?? new Set<string>();
      const factors = coachVisibleFactors(parseFactors(p.factors), shared);
      if (factors.length > 0) result.set(p.user_id, factors[0].label);
    }
    return result;
  }

  // CC-3: prefer the real PtmPrediction factor label; otherwise fall back to
  // an activity-based heuristic (no factors recorded yet / new client).
  private topFactorLabel(
    row: CoachRiskBoardRow,
    realTopFactor?: string,
  ): string {
    if (realTopFactor) return realTopFactor;
    if (!row.last_signal_at) return 'No recent activity';
    const days = Math.floor(
      (Date.now() - new Date(row.last_signal_at).getTime()) / ONE_DAY_MS,
    );
    if (days >= 7) return `No app activity in ${days} days`;
    if (row.bucket === 'red') return 'High churn risk — multiple signals fired';
    return 'Declining engagement signals';
  }

  // ── /win-streaks ─────────────────────────────────────────────────────
  async getWinStreaks(
    coachId: string,
    opts: { minStreak?: number; limit?: number },
  ): Promise<WinStreaksResponse> {
    const minStreak =
      opts.minStreak != null && Number.isFinite(opts.minStreak) && opts.minStreak > 0
        ? Math.floor(opts.minStreak)
        : 3;
    const limit = clamp(opts.limit, 50, 100);

    // SC-2: roster scoped via SubCoachScopeService (head = full roster,
    // sub = assigned clients only).
    const { clientIds, nameMap } = await this.resolveScopeWithNames(coachId);
    if (clientIds.length === 0) {
      return { items: [], total_active_streaks: 0 };
    }
    // CF-SHARE-GATE-128: check-in streaks only for clients who share Check-ins
    // and habits, workout streaks only for clients who share Workouts.
    const shared = await this.sharedWith(coachId, clientIds);
    const sevenDaysAgo = new Date(Date.now() - 7 * ONE_DAY_MS);

    const checkInStreaks = await this.prisma.clientSignal.findMany({
      where: {
        user_id: { in: shared.habits },
        signal_type: 'checkin_streak',
        value: { gte: minStreak },
        recorded_at: { gte: sevenDaysAgo },
      },
      orderBy: [{ value: 'desc' }, { recorded_at: 'desc' }],
      select: { user_id: true, value: true, recorded_at: true },
    });

    // Deduplicate per user — keep highest-value row
    const perUserBest = new Map<string, { value: number; recorded_at: Date }>();
    for (const s of checkInStreaks) {
      const existing = perUserBest.get(s.user_id);
      if (!existing || s.value > existing.value) {
        perUserBest.set(s.user_id, { value: s.value, recorded_at: s.recorded_at });
      }
    }

    const workoutWindow = new Date(
      Date.now() - (minStreak + 3) * ONE_DAY_MS,
    );
    const workoutStreaks = await this.prisma.clientSignal.groupBy({
      by: ['user_id'],
      where: {
        user_id: { in: shared.workouts },
        signal_type: 'workout_logged',
        recorded_at: { gte: workoutWindow },
      },
      _count: { _all: true },
      _min: { recorded_at: true },
    });

    const items: WinStreakEntry[] = [];
    const seen = new Set<string>();

    for (const [userId, info] of perUserBest) {
      if (items.length >= limit) break;
      seen.add(userId);
      const streakDays = Math.round(info.value);
      items.push({
        user_id: userId,
        display_name: nameMap.get(userId) ?? userId,
        streak_days: streakDays,
        streak_type: 'check_in',
        streak_started_at: new Date(
          info.recorded_at.getTime() - streakDays * ONE_DAY_MS,
        ).toISOString(),
      });
    }

    for (const g of workoutStreaks) {
      if (items.length >= limit) break;
      if (seen.has(g.user_id)) continue;
      if ((g._count?._all ?? 0) < minStreak) continue;
      const minRecorded = g._min?.recorded_at;
      if (!minRecorded) continue;
      items.push({
        user_id: g.user_id,
        display_name: nameMap.get(g.user_id) ?? g.user_id,
        streak_days: g._count._all,
        streak_type: 'workout',
        streak_started_at: minRecorded.toISOString(),
      });
    }

    items.sort((a, b) => b.streak_days - a.streak_days);

    return { items, total_active_streaks: items.length };
  }

  // ── /inbox ───────────────────────────────────────────────────────────
  async getInbox(
    coachId: string,
    opts: { limit?: number; unreadOnly?: boolean },
  ): Promise<InboxResponse> {
    const limit = clamp(opts.limit, 20, 50);

    // SC-2: roster scoped via SubCoachScopeService. `ownerCoachId` is the
    // head coach id under which CoachMessage rows are stored (a sub-coach's
    // threads live under the head coach's coach_id; sender_id captures who
    // actually sent), so we filter messages by (coach_id = owner,
    // client_id IN assigned).
    const { clientIds, ownerCoachId, nameMap } =
      await this.resolveScopeWithNames(coachId);
    if (clientIds.length === 0) {
      return { threads: [], total_unread: 0 };
    }

    // CC-4: the latest message per thread is fetched with `distinct` on
    // client_id ordered by created_at desc, which returns exactly ONE row
    // per client (their newest message) regardless of total message volume.
    // The previous implementation pulled a `take: 1000` global slice and
    // built threads from whatever fell inside it, so a thread whose latest
    // message sat beyond the 1000-row window silently DISAPPEARED from the
    // displayed list — yet its unread messages still counted in the
    // independently-computed total_unread, leaving the two numbers
    // inconsistent. Using distinct-per-client guarantees every thread with
    // any message is represented, so displayed threads and the unread total
    // describe the same set.
    const latestMessages = await this.prisma.coachMessage.findMany({
      where: {
        coach_id: ownerCoachId,
        client_id: { in: clientIds },
      },
      orderBy: { created_at: 'desc' },
      distinct: ['client_id'],
      select: {
        id: true,
        sender_id: true,
        client_id: true,
        body: true,
        read_at: true,
        created_at: true,
      },
    });

    const threadMap = new Map<string, (typeof latestMessages)[number]>();
    for (const msg of latestMessages) {
      if (!msg.client_id) continue;
      if (!threadMap.has(msg.client_id)) {
        threadMap.set(msg.client_id, msg);
      }
    }

    // CC+SC P1c: per-thread unread = messages SENT BY THE CLIENT and not yet
    // read. As in getOverview, `sender_id IN clientIds` selects exactly the
    // client-authored messages — a SUB-coach's outgoing message
    // (sender_id = subCoachId) is correctly treated as coach-side sent, so
    // it neither bumps the unread badge nor flips the thread to "client's
    // turn". The old `NOT: { sender_id: ownerCoachId }` only excluded the
    // head coach's own sends and therefore mis-counted sub-coach sends.
    const unreadCounts = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      where: {
        coach_id: ownerCoachId,
        client_id: { in: clientIds },
        read_at: null,
        sender_id: { in: clientIds },
      },
      _count: { _all: true },
    });
    const unreadMap = new Map<string, number>();
    for (const u of unreadCounts) {
      if (u.client_id == null) continue;
      unreadMap.set(u.client_id, u._count._all);
    }

    const threads: InboxThread[] = [];
    for (const [clientId, latestMsg] of threadMap) {
      const unreadCount = unreadMap.get(clientId) ?? 0;
      if (opts.unreadOnly && unreadCount === 0) continue;
      const preview = (latestMsg.body ?? '').slice(0, 120);
      // CC+SC P1c: it is the coach's turn to reply iff the latest message was
      // sent BY THE CLIENT (sender_id === this thread's client_id). The old
      // check `sender_id !== ownerCoachId` treated a sub-coach's outgoing
      // message as "client's turn / coach turn pending" because a sub-coach's
      // sender_id is not the head coach's id. Comparing against the thread's
      // own client_id is robust for head and sub coaches alike: any
      // coach-side send (head OR sub) yields is_coach_turn = false.
      const isCoachTurn = latestMsg.sender_id === clientId;
      threads.push({
        thread_id: buildThreadId(ownerCoachId, clientId),
        client_id: clientId,
        client_name: nameMap.get(clientId) ?? clientId,
        last_message_preview: preview,
        last_message_at: latestMsg.created_at.toISOString(),
        unread_count: unreadCount,
        is_coach_turn: isCoachTurn,
      });
    }

    threads.sort(
      (a, b) =>
        new Date(b.last_message_at).getTime() -
        new Date(a.last_message_at).getTime(),
    );

    // CC-4: total_unread is the sum of the unread counts of the threads we
    // actually return, so the tile and the visible list always agree. (When
    // unreadOnly is off, every thread with messages is present, so this is
    // also the roster-wide unread total.)
    const visible = threads.slice(0, limit);
    const totalUnread = visible.reduce((sum, t) => sum + t.unread_count, 0);

    return { threads: visible, total_unread: totalUnread };
  }

  // ── /action-queue ────────────────────────────────────────────────────
  async getActionQueue(
    coachId: string,
    opts: { limit?: number; before?: string },
  ): Promise<ActionQueueResponse> {
    const limit = clamp(opts.limit, 50, 100);
    const cursor = opts.before ? new Date(opts.before) : undefined;
    const cursorValid = cursor && Number.isFinite(cursor.getTime());

    // SC-2: alerts are scoped to the SubCoachScope-resolved client set. A
    // sub-coach only sees alerts for the clients assigned to them (client_id
    // IN assigned), under the head coach's id or their own (alertCoachIds).
    // A head coach with no clients sees nothing.
    const { clientIds, ownerCoachId } = await this.resolveScope(coachId);
    if (clientIds.length === 0) {
      return { items: [], total_pending: 0 };
    }

    // CF-SHARE-GATE-128: alerts built from a client's logs follow that log's
    // Coach sharing switch (visibleAlertsWhere).
    const shared = await this.sharedWith(coachId, clientIds);
    const baseWhere: Prisma.CoachAlertWhereInput = {
      coach_id: alertCoachIds(coachId, ownerCoachId),
      client_id: { in: clientIds },
      acknowledged_at: null,
      ...visibleAlertsWhere(clientIds, shared),
      ...safetyAlertsForCurrentCoach(coachId),
    };
    const where: Prisma.CoachAlertWhereInput = {
      ...baseWhere,
      ...(cursorValid ? { created_at: { lt: cursor } } : {}),
    };

    const [alerts, totalPending] = await Promise.all([
      this.prisma.coachAlert.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        include: { client: { select: { name: true } } },
      }),
      this.prisma.coachAlert.count({
        where: baseWhere,
      }),
    ]);
    const quotes = await this.safetyQuotes(alerts);
    const items = alerts.map((alert) => queueItem(alert, quotes.get(alert.id)));
    return { items, total_pending: totalPending };
  }

  // ── /action-queue/:alertId ───────────────────────────────────────────
  /**
   * Owner 57d: one Roman safety alert by id, for the tap of its push or inbox
   * row. The same fields as its queue row, and the same rule: only the
   * client's coach of record reads it. Another coach, an assistant, a former
   * coach, another alert type or a deleted message is the same 404. A crisis
   * alert has no message to quote.
   */
  async getSafetyAlert(alertId: string, coachId: string): Promise<ActionQueueItem> {
    const { clientIds, ownerCoachId } = await this.resolveScope(coachId);
    const alert = await this.prisma.coachAlert.findFirst({
      where: {
        id: alertId,
        alert_type: { in: [...ROMAN_SAFETY_ALERT_TYPES] },
        coach_id: alertCoachIds(coachId, ownerCoachId),
        client_id: { in: clientIds },
        ...safetyAlertsForCurrentCoach(coachId),
      },
      include: { client: { select: { name: true } } },
    });
    const quote = alert ? (await this.safetyQuotes([alert])).get(alert.id) : undefined;
    if (!alert || (!quote && alert.alert_type !== 'roman_crisis_reply')) {
      throw new NotFoundException('Alert not found');
    }
    return queueItem(alert, quote);
  }

  /**
   * The client's own message behind each Roman safety alert in the page, by
   * alert id: only that one message, only while its chat exists (a chat the
   * client deleted is erased, and so is the quote). Never for a crisis alert.
   */
  private async safetyQuotes(
    alerts: Array<{ id: string; client_id: string; alert_type: string; payload: Prisma.JsonValue }>,
  ): Promise<Map<string, { content: string; created_at: Date }>> {
    const refs = new Map<string, Array<{ alertId: string; clientId: string }>>();
    for (const a of alerts) {
      const p = a.payload as { roman_message_id?: unknown } | null;
      if (a.alert_type === 'roman_crisis_reply' || !SAFETY_CARD_LINE[a.alert_type]) continue;
      if (typeof p?.roman_message_id !== 'string') continue;
      refs.set(p.roman_message_id, [
        ...(refs.get(p.roman_message_id) ?? []),
        { alertId: a.id, clientId: a.client_id },
      ]);
    }
    const out = new Map<string, { content: string; created_at: Date }>();
    if (refs.size === 0) return out;
    const rows = await this.prisma.romanMessage.findMany({
      where: { id: { in: [...refs.keys()] }, role: 'user', session: { deleted_at: null } },
      select: { id: true, user_id: true, content: true, created_at: true },
    });
    for (const row of rows) {
      for (const ref of refs.get(row.id) ?? []) {
        if (ref.clientId === row.user_id) out.set(ref.alertId, row);
      }
    }
    return out;
  }

  // ── /action-queue/:alertId/dismiss ───────────────────────────────────
  async dismissAlert(
    alertId: string,
    coachId: string,
  ): Promise<{ ok: true }> {
    // P1b (CC+SC): route the dismiss authorization through the SAME
    // SubCoachScope resolution used by the list path. CoachAlert rows are
    // owned by the HEAD coach (coach_id = ownerCoachId); a sub-coach could
    // LIST their assigned clients' alerts (action-queue is scoped by
    // ownerCoachId + client_id IN assigned) but could NOT dismiss them,
    // because the old dismiss path scoped by the raw sub-coach id
    // (acknowledge(alertId, subCoachId)) — which matched no rows and 404'd.
    // We now authorize the ack on (coach_id = ownerCoachId, client_id IN
    // assigned). For a head coach ownerCoachId is their own id and clientIds
    // is their full roster, so this is equivalent to the legacy ownership
    // check — head-coach behaviour unchanged. A sub-coach dismissing an
    // alert for a client NOT assigned to them still 404s (no IDOR). Like the
    // list, a sub-coach's alerts may be under their own id (alertCoachIds).
    const { clientIds, ownerCoachId } = await this.resolveScope(coachId);
    // CoachAlertsService.acknowledgeForScope is idempotent and IDOR-safe:
    //   * updateMany/findFirst scoped to (coach_id, client_id IN allowed)
    //   * NotFoundException for alerts outside the allowed client set (an
    //     empty allow-set therefore matches nothing → NotFoundException)
    //   * returns existing row if already acknowledged (no double-write)
    await this.alertsService.acknowledgeForScope(
      alertId,
      alertCoachIds(coachId, ownerCoachId),
      clientIds,
      safetyAlertsForCurrentCoach(coachId),
    );
    return { ok: true };
  }
}
