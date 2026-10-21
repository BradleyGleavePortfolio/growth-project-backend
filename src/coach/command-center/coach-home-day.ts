/**
 * HOME-BE (#161-9, #161-10): the coach Home's day, returned under `home` by
 * GET /coach/command-center/overview?include=home.
 *
 *   wins     this week's wins of the coach's clients now, newest first: a
 *            check-in streak milestone, a new lifting best, the goal weight
 *            reached. `count` is exact; `items` holds the newest 50.
 *   rings    today's counts: check-ins reviewed / submitted, client messages
 *            answered / received, and Needs-you clients contacted out of up
 *            to 5.
 *
 * The week (Monday to Sunday) and the day are the coach's own, in the coach's
 * zone. Every read is scoped by the caller's roster now and the sharing gate
 * (CommandCenterService.resolveScope + sharedWith), so another coach, and a
 * moved client's former coach, read none of it. No words are composed for the
 * coach to see; `draft.message` is the request the phone forwards to Roman
 * (POST /ai/gateway/invoke, capability draft.coach_message), never shown.
 *
 * Queries (all bounded by the roster and indexed): check-ins 1, client
 * messages today 1, coach replies today 1, nudges today 1, streak signals 1,
 * lifting bests 1, goal weights 1, client names 1 (only when there are wins).
 */
import type { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { clientWeek } from '../client-week';

/** The newest wins returned; `count` still counts every win this week. */
export const HOME_WINS_MAX = 50;
/** Reach-outs aims at up to five Needs-you clients a day (fewer if fewer need you). */
export const REACH_OUT_GOAL_MAX = 5;
/** A lifting best beats the client's top set of that lift in this many weeks before this week. */
export const LIFT_HISTORY_WEEKS = 52;
/** The client timeline's streak milestones (TimelineService.STREAK_THRESHOLDS). */
export const STREAK_MILESTONES = [7, 14, 30, 60, 90];

/** What the phone sends to POST /ai/gateway/invoke for Roman's congratulations draft. */
export interface HomeWinDraft {
  capability: 'draft.coach_message';
  subject_user_id: string;
  message: string;
}

/** What each kind of win carries beyond the common fields. */
export type HomeWinFacts =
  | { kind: 'checkin_streak'; streak_days: number }
  | { kind: 'lifting_best'; exercise: string; weight_lbs: number; reps: number }
  | { kind: 'goal_weight'; weight_lbs: number; goal_weight_lbs: number };

interface WinCommon {
  /** Stable per win: `<kind>:<source row id>`. */
  id: string;
  client_id: string;
  /** When the win happened (ISO instant). */
  at: string;
}

export type HomeWin = WinCommon & { client_name: string; draft: HomeWinDraft } & HomeWinFacts;

export interface CoachHomeDay {
  /** The coach's today, YYYY-MM-DD. */
  date: string;
  /** Monday of the coach's week, YYYY-MM-DD. */
  week_start: string;
  time_zone: string;
  wins: { count: number; items: HomeWin[] };
  rings: {
    check_ins: { reviewed: number; submitted: number };
    replies: { answered: number; received: number };
    reach_outs: { contacted: number; goal: number };
  };
}

export interface HomeDayScope {
  /** The signed-in head or sub-coach. */
  coachId: string;
  /** The head coach: CoachMessage threads carry their id. */
  ownerCoachId: string;
  /** The caller's roster now. */
  clientIds: string[];
  /** Clients whose check-ins and habits the caller reads. */
  habits: string[];
  /** Clients whose workouts the caller reads. */
  workouts: string[];
  /** Clients whose body metrics the caller reads. */
  weighIns: string[];
  /** Needs you: the overview's at-risk clients (latest risk above green). */
  needsYou: string[];
}

type WinFact = WinCommon & HomeWinFacts;

/** A logged day (@db.Date) as Prisma takes it. */
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
/** The day N days before `day` (both YYYY-MM-DD). */
const daysBefore = (day: string, n: number) =>
  new Date(asDate(day).getTime() - n * 86_400_000).toISOString().slice(0, 10);
const round1 = (n: number) => Math.round(n * 10) / 10;

function draftFor(win: WinFact): HomeWinDraft {
  const ask = 'Write a short, warm congratulations to this client';
  let message: string;
  if (win.kind === 'checkin_streak') {
    message = `${ask} for checking in ${win.streak_days} days in a row.`;
  } else if (win.kind === 'lifting_best') {
    // The lift name is client-typed: fenced, on one line, in quotes.
    const lift = sanitizePromptInput(win.exercise, 60).replace(/\s+/g, ' ').replace(/"/g, "'").trim();
    message = `${ask} for a new best on "${lift || 'a lift'}" this week: ${win.weight_lbs} lb for ${win.reps} reps.`;
  } else {
    message = `${ask} for reaching their goal weight of ${win.goal_weight_lbs} lb this week.`;
  }
  return { capability: 'draft.coach_message', subject_user_id: win.client_id, message };
}

/** Check-in streak milestones reached this week, the first signal per client and milestone. */
async function streakWins(prisma: PrismaService, ids: string[], from: Date, now: Date): Promise<WinFact[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.clientSignal.findMany({
    where: {
      user_id: { in: ids },
      signal_type: 'checkin_streak',
      value: { in: STREAK_MILESTONES },
      recorded_at: { gte: from, lte: now },
    },
    orderBy: [{ recorded_at: 'asc' }, { id: 'asc' }],
    select: { id: true, user_id: true, value: true, recorded_at: true },
  });
  const seen = new Set<string>();
  const wins: WinFact[] = [];
  for (const r of rows) {
    const key = `${r.user_id}:${r.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wins.push({
      id: `checkin_streak:${r.id}`,
      kind: 'checkin_streak',
      client_id: r.user_id,
      at: r.recorded_at.toISOString(),
      streak_days: r.value,
    });
  }
  return wins;
}

/**
 * New lifting bests this week, one per client and lift: the week's top set (the
 * heaviest weight with reps, more reps breaking a tie, as the phone's progress
 * screen ranks it) beats the client's top set of the same lift in the
 * LIFT_HISTORY_WEEKS before this week. A lift with no earlier set is not a best.
 * The same lift is workout history's (WorkoutService.getExerciseHistory): sets
 * logged under a catalog id match that id, plus that lift's sets logged with no
 * id by name, case-insensitive; a set with no id matches by name. Two different
 * catalog ids never merge because their labels match.
 * One pass over this week's sets, one over the history of only the clients and
 * lifts trained this week (WorkoutSession(user_id, date), ExerciseSet(workout_id)).
 */
async function liftingWins(
  prisma: PrismaService,
  ids: string[],
  weekStart: string,
  today: string,
): Promise<WinFact[]> {
  if (ids.length === 0) return [];
  const historyFrom = daysBefore(weekStart, LIFT_HISTORY_WEEKS * 7);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; user_id: string; exercise_name: string; w: number; r: number; at: Date }>
  >`
    WITH week AS (
      SELECT DISTINCT ON (ws."user_id", g.lift)
             es."id", ws."user_id", es."exercise_name", es."exercise_external_id" AS xid,
             lower(es."exercise_name") AS lname, t.w, t.r, ws."created_at" AS at
        FROM "WorkoutSession" ws
        JOIN "ExerciseSet" es ON es."workout_id" = ws."id"
        CROSS JOIN LATERAL (
          SELECT COALESCE('id:' || es."exercise_external_id", 'name:' || lower(es."exercise_name")) AS lift
        ) g
        CROSS JOIN LATERAL (
          SELECT u.w, u.r FROM unnest(es."weight_per_set", es."reps_per_set") AS u(w, r)
           WHERE u.w > 0 AND u.r > 0 ORDER BY u.w DESC, u.r DESC LIMIT 1
        ) t
       WHERE ws."user_id" = ANY(${ids}::text[])
         AND ws."date" >= ${weekStart}::date AND ws."date" <= ${today}::date
       ORDER BY ws."user_id", g.lift, t.w DESC, t.r DESC, ws."created_at" ASC, es."id" ASC
    ),
    -- The earlier top set per (client, catalog id or none, lower-cased name).
    hist AS MATERIALIZED (
      SELECT DISTINCT ON (ws."user_id", es."exercise_external_id", lower(es."exercise_name"))
             ws."user_id", es."exercise_external_id" AS xid, lower(es."exercise_name") AS lname, t.w, t.r
        FROM "WorkoutSession" ws
        JOIN "ExerciseSet" es ON es."workout_id" = ws."id"
        CROSS JOIN LATERAL (
          SELECT u.w, u.r FROM unnest(es."weight_per_set", es."reps_per_set") AS u(w, r)
           WHERE u.w > 0 AND u.r > 0 ORDER BY u.w DESC, u.r DESC LIMIT 1
        ) t
       WHERE ws."user_id" IN (SELECT "user_id" FROM week)
         AND (es."exercise_external_id" IN (SELECT xid FROM week)
              OR lower(es."exercise_name") IN (SELECT lname FROM week))
         AND ws."date" >= ${historyFrom}::date AND ws."date" < ${weekStart}::date
       ORDER BY ws."user_id", es."exercise_external_id", lower(es."exercise_name"), t.w DESC, t.r DESC
    )
    SELECT k."id", k."user_id", k."exercise_name", k.w, k.r, k.at
      FROM week k
      CROSS JOIN LATERAL (
        SELECT h.w, h.r FROM hist h
         WHERE h."user_id" = k."user_id"
           AND CASE WHEN k.xid IS NULL THEN h.lname = k.lname
                    ELSE h.xid = k.xid OR (h.xid IS NULL AND h.lname = k.lname) END
         ORDER BY h.w DESC, h.r DESC LIMIT 1
      ) b
     WHERE k.w > b.w OR (k.w = b.w AND k.r > b.r)`;
  return rows.map((r) => ({
    id: `lifting_best:${r.id}`,
    kind: 'lifting_best' as const,
    client_id: r.user_id,
    at: r.at.toISOString(),
    exercise: r.exercise_name,
    weight_lbs: round1(Number(r.w)),
    reps: Number(r.r),
  }));
}

/**
 * Goal weight reached this week: the client's first weigh-in this week that
 * meets or crosses UserProfile.target_weight_lbs from their weigh-in before it
 * (from either side, so losing and gaining goals both count). A client with no
 * earlier weigh-in, or already at the goal, has no win. A client reaches it
 * once: no win when any weigh-in in the LIFT_HISTORY_WEEKS before was already
 * at or past the goal, so scale swings around it do not repeat the win.
 */
async function goalWins(
  prisma: PrismaService,
  ids: string[],
  weekStart: string,
  today: string,
): Promise<WinFact[]> {
  if (ids.length === 0) return [];
  const historyFrom = daysBefore(weekStart, LIFT_HISTORY_WEEKS * 7);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; user_id: string; weight_lbs: number; goal: number; logged_at: Date }>
  >`
    SELECT DISTINCT ON (w."user_id") w."id", w."user_id", w."weight_lbs", p."target_weight_lbs" AS goal, w."logged_at"
      FROM "WeightLog" w
      JOIN "UserProfile" p ON p."user_id" = w."user_id"
      CROSS JOIN LATERAL (
        SELECT e."weight_lbs" FROM "WeightLog" e
         WHERE e."user_id" = w."user_id"
           AND (e."date", e."logged_at", e."id") < (w."date", w."logged_at", w."id")
         ORDER BY e."date" DESC, e."logged_at" DESC, e."id" DESC LIMIT 1
      ) prev
     WHERE w."user_id" = ANY(${ids}::text[])
       AND w."date" >= ${weekStart}::date AND w."date" <= ${today}::date
       AND p."target_weight_lbs" IS NOT NULL
       AND prev."weight_lbs" <> p."target_weight_lbs"
       AND (w."weight_lbs" - p."target_weight_lbs") * (prev."weight_lbs" - p."target_weight_lbs") <= 0
       -- Reached once: no earlier weigh-in in the window was already at or past the goal.
       AND NOT EXISTS (
         SELECT 1 FROM "WeightLog" e2
          WHERE e2."user_id" = w."user_id"
            AND e2."date" >= ${historyFrom}::date
            AND (e2."date", e2."logged_at", e2."id") < (w."date", w."logged_at", w."id")
            AND (e2."weight_lbs" - p."target_weight_lbs") * (prev."weight_lbs" - p."target_weight_lbs") <= 0
       )
     ORDER BY w."user_id", w."date", w."logged_at", w."id"`;
  return rows.map((r) => ({
    id: `goal_weight:${r.id}`,
    kind: 'goal_weight' as const,
    client_id: r.user_id,
    at: r.logged_at.toISOString(),
    weight_lbs: round1(Number(r.weight_lbs)),
    goal_weight_lbs: round1(Number(r.goal)),
  }));
}

type Rings = CoachHomeDay['rings'];

/** Today's check-ins of clients who share them, and how many are reviewed. */
async function checkInRing(
  prisma: PrismaService,
  ids: string[],
  today: string,
  dayFrom: Date,
  now: Date,
): Promise<Rings['check_ins']> {
  if (ids.length === 0) return { reviewed: 0, submitted: 0 };
  const groups = await prisma.checkIn.groupBy({
    by: ['reviewed_by_coach'],
    // Submitted in the coach's today. The day bound (a client's date is
    // within two days of the coach's) keeps it on CheckIn(user_id, date).
    where: {
      user_id: { in: ids },
      date: { gte: asDate(daysBefore(today, 2)), lte: asDate(daysBefore(today, -2)) },
      logged_at: { gte: dayFrom, lte: now },
    },
    _count: { _all: true },
  });
  let reviewed = 0;
  let submitted = 0;
  for (const g of groups) {
    submitted += g._count._all;
    if (g.reviewed_by_coach) reviewed += g._count._all;
  }
  return { reviewed, submitted };
}

/** Replies and Reach-outs: today's client messages, the coach side's answers, and nudges. */
async function contactRings(
  prisma: PrismaService,
  scope: HomeDayScope,
  dayFrom: Date,
  now: Date,
): Promise<Pick<Rings, 'replies' | 'reach_outs'>> {
  const { clientIds, ownerCoachId, needsYou } = scope;
  const goal = Math.min(REACH_OUT_GOAL_MAX, needsYou.length);
  if (clientIds.length === 0) return { replies: { answered: 0, received: 0 }, reach_outs: { contacted: 0, goal } };
  const today = { gte: dayFrom, lte: now };
  const [received, replies, nudges] = await Promise.all([
    // Messages a client sent in their thread with this coach today. A client
    // only ever sends in their own thread, so sender_id IN roster is "sent by
    // the client" (as the overview's unread count reads it).
    prisma.coachMessage.findMany({
      where: {
        coach_id: ownerCoachId,
        client_id: { in: clientIds },
        sender_id: { in: clientIds },
        deleted_at: null,
        created_at: today,
      },
      select: { client_id: true, created_at: true },
    }),
    // The coach side's latest message today per thread that a person sent (the
    // head, a sub-coach, or an approved Roman draft, which is sent as the
    // coach). Filtered before the latest is chosen: broadcast copies (one
    // message to many clients answers no one) and automated messages (the
    // coach welcome, package auto messages: CoachMessage.automated_by).
    prisma.coachMessage.findMany({
      where: {
        coach_id: ownerCoachId,
        client_id: { in: clientIds },
        sender_id: { notIn: clientIds },
        deleted_at: null,
        broadcast_delivery: { is: null },
        automated_by: null,
        created_at: today,
      },
      orderBy: [{ client_id: 'asc' }, { created_at: 'desc' }],
      distinct: ['client_id'],
      select: { client_id: true, created_at: true },
    }),
    goal === 0
      ? Promise.resolve([])
      : prisma.coachNudge.findMany({
          where: {
            coach_id: { in: [...new Set([scope.coachId, ownerCoachId])] },
            client_id: { in: needsYou },
            created_at: today,
          },
          distinct: ['client_id'],
          select: { client_id: true },
        }),
  ]);
  const lastReply = new Map<string, number>();
  for (const r of replies) if (r.client_id) lastReply.set(r.client_id, r.created_at.getTime());
  const answered = received.filter(
    (m) => m.client_id !== null && (lastReply.get(m.client_id) ?? 0) > m.created_at.getTime(),
  ).length;
  const nudged = new Set(nudges.map((n) => n.client_id));
  const contacted = needsYou.filter((id) => lastReply.has(id) || nudged.has(id)).length;
  return {
    replies: { answered, received: received.length },
    reach_outs: { contacted: Math.min(contacted, goal), goal },
  };
}

export async function loadHomeDay(
  prisma: PrismaService,
  scope: HomeDayScope,
  timeZone: string,
  now: Date,
): Promise<CoachHomeDay> {
  const week = clientWeek(now, timeZone);
  const [checkIns, contact, streaks, bests, goals] = await Promise.all([
    checkInRing(prisma, scope.habits, week.today, week.todayFrom, now),
    contactRings(prisma, scope, week.todayFrom, now),
    streakWins(prisma, scope.habits, week.from, now),
    liftingWins(prisma, scope.workouts, week.start, week.today),
    goalWins(prisma, scope.weighIns, week.start, week.today),
  ]);

  const facts = [...streaks, ...bests, ...goals].sort((a, b) =>
    a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1,
  );
  const newest = facts.slice(0, HOME_WINS_MAX);
  const names = new Map<string, string>();
  if (newest.length > 0) {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...new Set(newest.map((w) => w.client_id))] } },
      select: { id: true, name: true },
    });
    for (const r of rows) names.set(r.id, r.name);
  }
  const items = newest.map(
    (w): HomeWin => ({ ...w, client_name: names.get(w.client_id) ?? '', draft: draftFor(w) }),
  );
  return {
    date: week.today,
    week_start: week.start,
    time_zone: timeZone,
    wins: { count: facts.length, items },
    rings: { check_ins: checkIns, ...contact },
  };
}
