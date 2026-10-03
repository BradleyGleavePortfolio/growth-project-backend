// test/roman/fixtures/roman-personas.ts
//
// In-memory Prisma double + the P1–P5 personas from PLAN_roman_intelligence
// §7.1, shared by the R3 context specs and the R8 eval harness. No network,
// no DB. The double honours the where/orderBy/take shapes the
// RomanClientContextService actually issues (equality, gte/lte/lt/in/not,
// OR, one level of relation filter) and counts every call so the query
// budget can be asserted.
//
// Clock: NOW = 2026-10-01T00:30:00Z, which is Wed 2026-09-30 17:30 in
// America/Los_Angeles — the PT/UTC boundary fixture from §7.3.

import type { PrismaService } from '../../../src/prisma.service';
import type {
  RomanConsultationSummary,
  RomanSafetyIntakeSource,
} from '../../../src/roman/context/roman-client-context.types';

export const NOW = new Date('2026-10-01T00:30:00.000Z');
export const LOCAL_TODAY_PT = '2026-09-30';

export const COACH_A = { id: 'coach-A', name: 'Alex Rivera', role: 'coach', deleted_at: null };
export const COACH_B = { id: 'coach-B', name: 'Bea Okafor', role: 'coach', deleted_at: null };

export const P1 = 'user-maya';
export const P2 = 'user-dan';
export const P3 = 'user-lee';
export const P4 = 'user-zelda';
export const P5 = 'user-omar';

// Canary strings that must never appear in another user's rendered block.
export const CANARIES = [
  'ZELDA-CANARY',
  'Zelda',
  'Quark',
  'COACH-PRIVATE-CANARY',
  'Omar',
  'OMAR-GUIDELINE-CANARY',
  'OLD-COACH-CANARY',
  '2777',
  '3111',
  '2222',
  'maya@example.com',
  'user-maya',
  '1992-03-15',
  '+1-555',
  'Lopez',
];

const D = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

// ─── rows ────────────────────────────────────────────────────────────────────

const users = [
  {
    id: P1,
    email: 'maya@example.com',
    phone: '+1-555-0100',
    name: 'Maya Lopez',
    role: 'student',
    coach_id: COACH_A.id,
    coach: COACH_A,
    notification_prefs: { timezone: 'America/Los_Angeles' },
    profile: {
      user_id: P1,
      height_cm: 165,
      current_weight_lbs: 166.9,
      target_weight_lbs: 150,
      date_of_birth: D('1992-03-15'),
      sex: 'female',
      activity_level: 'moderate',
      goal_type: 'fat_loss',
      workout_experience: 'beginner',
      has_gym_membership: true,
      preferred_snacks: ['almonds', 'apple'],
      dietary_pattern: 'omnivore',
      dietary_restrictions: ['dairy-free'],
      workout_days_per_week: 3,
      equipment_access: ['dumbbells', 'bench'],
      macro_target_calories: 1600,
      macro_target_protein_g: 120,
      macro_target_carbs_g: 170,
      macro_target_fat_g: 50,
      bio: 'Busy mom of two.',
      meals_per_day: 4,
      water_goal_oz: 80,
      injuries: [],
      food_preferences: { likes: ['salmon'], dislikes: ['cilantro'] },
      preferred_training_time: 'morning',
    },
  },
  {
    id: P2,
    email: 'dan@example.com',
    phone: null,
    name: 'Dan Whitfield',
    role: 'student',
    coach_id: COACH_A.id,
    coach: COACH_A,
    notification_prefs: { timezone: 'America/Los_Angeles' },
    profile: {
      user_id: P2,
      height_cm: 180,
      current_weight_lbs: 212,
      target_weight_lbs: 190,
      date_of_birth: D('1968-05-02'),
      sex: 'male',
      activity_level: 'light',
      goal_type: 'fat_loss',
      workout_experience: 'beginner',
      has_gym_membership: false,
      preferred_snacks: [],
      dietary_pattern: null,
      dietary_restrictions: [],
      workout_days_per_week: 2,
      equipment_access: ['bands'],
      macro_target_calories: 1500,
      macro_target_protein_g: 150,
      macro_target_carbs_g: 120,
      macro_target_fat_g: 50,
      bio: null,
      meals_per_day: 3,
      water_goal_oz: null,
      injuries: ['left knee'],
      food_preferences: null,
      preferred_training_time: null,
    },
  },
  {
    id: P3,
    email: 'lee@example.com',
    phone: null,
    name: 'Lee',
    role: 'student',
    coach_id: null,
    coach: null,
    notification_prefs: null,
    profile: {
      user_id: P3,
      height_cm: null,
      current_weight_lbs: null,
      target_weight_lbs: null,
      date_of_birth: null,
      sex: 'prefer_not_to_say',
      activity_level: 'moderate',
      goal_type: 'maintenance',
      workout_experience: 'beginner',
      has_gym_membership: false,
      preferred_snacks: [],
      dietary_pattern: null,
      dietary_restrictions: [],
      workout_days_per_week: null,
      equipment_access: [],
      macro_target_calories: null,
      macro_target_protein_g: null,
      macro_target_carbs_g: null,
      macro_target_fat_g: null,
      bio: null,
      meals_per_day: null,
      water_goal_oz: null,
      injuries: [],
      food_preferences: null,
      preferred_training_time: null,
    },
  },
  {
    id: P4,
    email: 'zelda@example.com',
    phone: null,
    name: 'Zelda Quark',
    role: 'student',
    coach_id: COACH_A.id,
    coach: COACH_A,
    notification_prefs: { timezone: 'America/Los_Angeles' },
    profile: {
      user_id: P4,
      sex: 'female',
      goal_type: 'muscle_gain',
      macro_target_calories: 2777,
      injuries: [],
      equipment_access: [],
      dietary_restrictions: [],
      preferred_snacks: [],
    },
  },
  {
    id: P5,
    email: 'omar@example.com',
    phone: null,
    name: 'Omar Haddad',
    role: 'student',
    coach_id: COACH_B.id,
    coach: COACH_B,
    notification_prefs: { timezone: 'America/New_York' },
    profile: {
      user_id: P5,
      sex: 'male',
      goal_type: 'maintenance',
      macro_target_calories: 3111,
      injuries: [],
      equipment_access: [],
      dietary_restrictions: [],
      preferred_snacks: [],
    },
  },
  {
    id: COACH_A.id,
    email: 'alex@example.com',
    name: COACH_A.name,
    role: 'coach',
    coach_id: null,
    coach: null,
    notification_prefs: null,
    profile: null,
  },
];

const macroTargets = [
  // P1 — current coach, live, effective
  {
    id: 'mt-maya-1',
    client_id: P1,
    coach_id: COACH_A.id,
    calories_kcal: 1450,
    protein_g: 115,
    carbs_g: 150,
    fats_g: 45,
    fiber_g: 25,
    notes: 'Protein first at breakfast.',
    effective_from: D('2026-09-20'),
    archived_at: null,
  },
  // P1 — an OLD coach's row: must be excluded (coach_id != current coach)
  {
    id: 'mt-maya-old',
    client_id: P1,
    coach_id: COACH_B.id,
    calories_kcal: 2222,
    protein_g: 100,
    carbs_g: 200,
    fats_g: 60,
    fiber_g: null,
    notes: 'OLD-COACH-CANARY',
    effective_from: D('2026-08-01'),
    archived_at: null,
  },
  // P1 — a future-dated row: not yet effective
  {
    id: 'mt-maya-future',
    client_id: P1,
    coach_id: COACH_A.id,
    calories_kcal: 1400,
    protein_g: 115,
    carbs_g: 140,
    fats_g: 45,
    fiber_g: null,
    notes: null,
    effective_from: D('2026-10-15'),
    archived_at: null,
  },
  {
    id: 'mt-zelda',
    client_id: P4,
    coach_id: COACH_A.id,
    calories_kcal: 2777,
    protein_g: 180,
    carbs_g: 300,
    fats_g: 80,
    fiber_g: null,
    notes: 'ZELDA-CANARY macros',
    effective_from: D('2026-09-01'),
    archived_at: null,
  },
  {
    id: 'mt-omar',
    client_id: P5,
    coach_id: COACH_B.id,
    calories_kcal: 3111,
    protein_g: 200,
    carbs_g: 350,
    fats_g: 90,
    fiber_g: null,
    notes: null,
    effective_from: D('2026-09-01'),
    archived_at: null,
  },
];

const food = (
  user_id: string,
  date: string,
  calories: number,
  protein_g: number,
  carbs_g: number,
  fat_g: number,
  loggedAt: string,
  q = 1,
  name = 'Food item',
  meal_type = 'LUNCH',
) => ({
  user_id,
  date: D(date),
  logged_at: new Date(loggedAt),
  quantity_multiplier: q,
  meal_type,
  food_item: { calories, protein_g, carbs_g, fat_g, name },
});

const loggedFood = [
  // P1 today (PT 2026-09-30): 780 kcal / 62 g protein
  food(P1, '2026-09-30', 320, 30, 20, 12, '2026-09-30T15:10:00Z', 1, 'Greek yogurt bowl', 'BREAKFAST'),
  food(P1, '2026-09-30', 460, 32, 50, 14, '2026-09-30T20:45:00Z', 1, 'Chicken rice bowl', 'LUNCH'),
  // P1 yesterday and earlier
  food(P1, '2026-09-29', 1500, 110, 150, 45, '2026-09-29T23:00:00Z'),
  food(P1, '2026-09-28', 1420, 118, 140, 44, '2026-09-28T23:00:00Z'),
  food(P1, '2026-09-25', 1900, 90, 220, 60, '2026-09-25T23:00:00Z'),
  // P1 8 days ago — outside the window
  food(P1, '2026-09-22', 999, 99, 99, 99, '2026-09-22T23:00:00Z'),
  // P4 canary — same day, must not leak into P1
  food(P4, '2026-09-30', 2777, 200, 300, 80, '2026-09-30T15:00:00Z', 1, 'ZELDA-CANARY food'),
];

const catalog = [
  { id: 'ex-1', slug: 'goblet-squat', name: 'Goblet Squat' },
  { id: 'ex-2', slug: 'db-bench-press', name: 'Dumbbell Bench Press' },
  { id: 'ex-3', slug: 'romanian-deadlift', name: 'Romanian Deadlift' },
];

const planA = {
  name: 'Full Body B',
  type: 'strength',
  program: { name: 'Program A Foundations' },
  exercises: [
    {
      exercise_external_id: 'ex-1',
      sets: 3,
      reps_or_duration_seconds: 10,
      notes: 'Chest tall, knees track toes',
      order: 0,
      archived_at: null,
    },
    {
      exercise_external_id: 'ex-2',
      sets: 3,
      reps_or_duration_seconds: 8,
      notes: null,
      order: 1,
      archived_at: null,
    },
    {
      exercise_external_id: 'ex-3',
      sets: 3,
      reps_or_duration_seconds: 8,
      notes: 'Hinge, soft knees',
      order: 2,
      archived_at: null,
    },
  ],
};
const planC = {
  name: 'Gentle Start A',
  type: 'mobility',
  program: { name: 'Program C Gentle Start' },
  exercises: [
    {
      exercise_external_id: 'ex-1',
      sets: 2,
      reps_or_duration_seconds: 8,
      notes: null,
      order: 0,
      archived_at: null,
    },
  ],
};
const planZ = {
  name: 'ZELDA-CANARY Day',
  type: 'strength',
  program: { name: 'ZELDA-CANARY Program' },
  exercises: [],
};

const assignments = [
  // P1: completed Mon 9/28 (RPE 7), completed 9/23, scheduled Thu 10/01 (next), Sat 10/03
  {
    id: 'a1',
    client_id: P1,
    assigned_by_coach_id: COACH_A.id,
    scheduled_for: new Date('2026-09-23T14:00:00Z'),
    completed_at: new Date('2026-09-23T15:00:00Z'),
    post_rpe: 6,
    post_notes: null,
    snapshot: null,
    workout_plan: { ...planA, name: 'Full Body A' },
  },
  {
    id: 'a2',
    client_id: P1,
    assigned_by_coach_id: COACH_A.id,
    scheduled_for: new Date('2026-09-28T14:00:00Z'),
    completed_at: new Date('2026-09-28T15:00:00Z'),
    post_rpe: 7,
    post_notes: 'Felt strong',
    snapshot: null,
    workout_plan: { ...planA, name: 'Full Body B' },
  },
  {
    id: 'a3',
    client_id: P1,
    assigned_by_coach_id: COACH_A.id,
    scheduled_for: new Date('2026-10-01T14:00:00Z'),
    completed_at: null,
    post_rpe: null,
    post_notes: null,
    snapshot: null,
    workout_plan: planA,
  },
  {
    id: 'a4',
    client_id: P1,
    assigned_by_coach_id: COACH_A.id,
    scheduled_for: new Date('2026-10-03T14:00:00Z'),
    completed_at: null,
    post_rpe: null,
    post_notes: null,
    snapshot: null,
    workout_plan: { ...planA, name: 'Full Body A' },
  },
  // P1 — assigned by the OLD coach: excluded
  {
    id: 'a-old',
    client_id: P1,
    assigned_by_coach_id: COACH_B.id,
    scheduled_for: new Date('2026-10-02T14:00:00Z'),
    completed_at: null,
    post_rpe: null,
    post_notes: 'OLD-COACH-CANARY',
    snapshot: null,
    workout_plan: { ...planA, name: 'OLD-COACH-CANARY Session' },
  },
  // P2
  {
    id: 'a-dan',
    client_id: P2,
    assigned_by_coach_id: COACH_A.id,
    scheduled_for: new Date('2026-10-02T14:00:00Z'),
    completed_at: null,
    post_rpe: null,
    post_notes: null,
    snapshot: null,
    workout_plan: planC,
  },
  // P4 canary
  {
    id: 'a-z',
    client_id: P4,
    assigned_by_coach_id: COACH_A.id,
    scheduled_for: new Date('2026-10-01T14:00:00Z'),
    completed_at: null,
    post_rpe: null,
    post_notes: 'ZELDA-CANARY',
    snapshot: null,
    workout_plan: planZ,
  },
];

const workoutSessions = [
  {
    user_id: P1,
    date: D('2026-09-26'),
    workout_name: 'Walk + core',
    workout_type: 'cardio',
    duration_minutes: 35,
    intensity: 'light',
    _count: { exercises: 2 },
  },
  {
    user_id: P4,
    date: D('2026-09-26'),
    workout_name: 'ZELDA-CANARY lift',
    workout_type: 'strength',
    duration_minutes: 60,
    intensity: 'hard',
    _count: { exercises: 8 },
  },
];

const weightLogs = [
  { user_id: P1, date: D('2026-09-16'), weight_lbs: 168.4 },
  { user_id: P1, date: D('2026-09-23'), weight_lbs: 167.6 },
  { user_id: P1, date: D('2026-09-30'), weight_lbs: 166.9 },
  { user_id: P4, date: D('2026-09-30'), weight_lbs: 277.7 },
];

const checkIns = [
  {
    user_id: P1,
    date: D('2026-09-30'),
    type: 'morning',
    mood: 4,
    energy: 3,
    soreness: 2,
    sleep_hours: 6.5,
    notes: 'Slept badly, kids up.',
  },
  {
    user_id: P4,
    date: D('2026-09-30'),
    type: 'morning',
    mood: 5,
    energy: 5,
    soreness: 1,
    sleep_hours: 8,
    notes: 'ZELDA-CANARY check-in',
  },
];

const guidelines = [
  {
    coach_id: COACH_A.id,
    client_id: P1,
    content: 'Keep dairy out. Protein at every meal. Walk on rest days.',
  },
  { coach_id: COACH_B.id, client_id: P1, content: 'OLD-COACH-CANARY guideline' },
  { coach_id: COACH_B.id, client_id: P5, content: 'OMAR-GUIDELINE-CANARY' },
  { coach_id: COACH_A.id, client_id: P4, content: 'ZELDA-CANARY guideline' },
];

const coachMessages = [
  {
    coach_id: COACH_A.id,
    client_id: P1,
    sender_id: COACH_A.id,
    body: 'Great week Maya - protein looked solid.',
    created_at: new Date('2026-09-29T18:00:00Z'),
  },
  // client → coach: INCLUDED since ctx-v2 (ruling #6: both directions)
  {
    coach_id: COACH_A.id,
    client_id: P1,
    sender_id: P1,
    body: 'Thanks Alex, knee felt fine on the squats.',
    created_at: new Date('2026-09-29T19:00:00Z'),
  },
  // old-coach thread: excluded (not the current coach)
  {
    coach_id: COACH_B.id,
    client_id: P1,
    sender_id: P1,
    body: 'OLD-COACH-CANARY thread message',
    created_at: new Date('2026-09-29T19:30:00Z'),
  },
  {
    coach_id: COACH_A.id,
    client_id: P4,
    sender_id: COACH_A.id,
    body: 'ZELDA-CANARY message',
    created_at: new Date('2026-09-29T18:00:00Z'),
  },
];

const mealAssignments = [
  {
    client_id: P1,
    assigned_by_coach_id: COACH_A.id,
    starts_on: D('2026-09-28'),
    ends_on: null,
    daily_meal_plan: {
      archived_at: null,
      name: 'Dairy-free 1450',
      slots: [
        {
          order: 0,
          slot_label: 'Breakfast',
          meal_template: { name: 'Egg scramble', calories_kcal: 380, protein_g: 30 },
        },
        {
          order: 1,
          slot_label: 'Lunch',
          meal_template: { name: 'Chicken bowl', calories_kcal: 520, protein_g: 42 },
        },
      ],
    },
  },
  {
    client_id: P4,
    assigned_by_coach_id: COACH_A.id,
    starts_on: D('2026-09-01'),
    ends_on: null,
    daily_meal_plan: { archived_at: null, name: 'ZELDA-CANARY plan', slots: [] },
  },
];

// Tables the builder must NEVER read (coach-private / other users' data).
// Bookings (ctx-v3): the builder reads title / time / status of UPCOMING
// sessions with the CURRENT coach, never coach_notes_md (canary below), never
// past or declined sessions, never another coach's.
export const coachingSessions = [
  {
    coach_id: COACH_A.id,
    client_id: P1,
    title: 'Form check: squat',
    status: 'scheduled',
    start_at: new Date('2026-10-06T17:00:00Z'),
    end_at: new Date('2026-10-06T17:45:00Z'),
    coach_notes_md: 'COACH-PRIVATE-CANARY about Maya',
  },
  {
    coach_id: COACH_A.id,
    client_id: P1,
    title: 'PAST-SESSION-CANARY',
    status: 'completed',
    start_at: new Date('2026-09-01T17:00:00Z'),
    end_at: new Date('2026-09-01T17:45:00Z'),
    coach_notes_md: 'COACH-PRIVATE-CANARY past',
  },
];
export const communityWins = [{ user_id: P4, title: 'ZELDA-CANARY' }];

const communityPosts = [
  {
    author_id: P1,
    scope: 'cohort',
    title: 'Week 3 done',
    body: 'Hit every session this week, first time ever.',
    visibility: 'active',
    deleted_at: null,
    created_at: new Date('2026-09-28T16:00:00Z'),
  },
  // P1's deleted post: excluded
  {
    author_id: P1,
    scope: 'cohort',
    title: 'DELETED-POST-CANARY',
    body: null,
    visibility: 'active',
    deleted_at: new Date('2026-09-29T00:00:00Z'),
    created_at: new Date('2026-09-27T16:00:00Z'),
  },
  // P1's hidden (moderated) post: excluded
  {
    author_id: P1,
    scope: 'cohort',
    title: 'HIDDEN-POST-CANARY',
    body: null,
    visibility: 'hidden',
    deleted_at: null,
    created_at: new Date('2026-09-27T17:00:00Z'),
  },
  // another member in the same cohort: never
  {
    author_id: P4,
    scope: 'cohort',
    title: 'ZELDA-CANARY post',
    body: 'Zelda wrote this',
    visibility: 'active',
    deleted_at: null,
    created_at: new Date('2026-09-29T16:00:00Z'),
  },
];

const wearableConnections = [
  { user_id: P1, provider: 'OURA', status: 'connected', last_synced_at: new Date('2026-09-30T14:00:00Z'), disconnected_at: null, encrypted_access_token: 'WEARABLE-TOKEN-CANARY' },
  { user_id: P1, provider: 'WHOOP', status: 'revoked', last_synced_at: null, disconnected_at: new Date('2026-09-01T00:00:00Z'), encrypted_access_token: 'WEARABLE-TOKEN-CANARY' },
  { user_id: P4, provider: 'OURA', status: 'connected', last_synced_at: new Date('2026-09-30T14:00:00Z'), disconnected_at: null, encrypted_access_token: 'WEARABLE-TOKEN-CANARY' },
];

const sample = (user_id: string, metric: string, value: number, start: string, end = start) => ({
  user_id,
  metric,
  value,
  start_at: new Date(start),
  end_at: new Date(end),
  source_tz: 'America/Los_Angeles',
});

const wearableSamples = [
  // P1 — 2026-09-29 and 2026-09-30 in HER local days (America/Los_Angeles,
  // PDT = UTC-7; C-R3-1 buckets by the client's local day, sleep by the
  // local morning it ends). NOW is 2026-09-30 17:30 PT.
  sample(P1, 'STEPS', 4000, '2026-09-29T15:00:00Z'), // 08:00 PT 09-29
  sample(P1, 'STEPS', 4200, '2026-09-30T01:00:00Z'), // 18:00 PT 09-29
  sample(P1, 'RESTING_HEART_RATE_BPM', 58, '2026-09-29T13:00:00Z'),
  sample(P1, 'HRV_MS', 44, '2026-09-29T13:00:00Z'),
  sample(P1, 'SLEEP_TOTAL_MIN', 402, '2026-09-29T05:30:00Z', '2026-09-29T13:00:00Z'), // ends 06:00 PT 09-29
  sample(P1, 'RECOVERY_SCORE', 71, '2026-09-29T13:00:00Z'),
  sample(P1, 'STEPS', 6100, '2026-09-30T18:00:00Z'), // 11:00 PT 09-30
  sample(P1, 'RESTING_HEART_RATE_BPM', 60, '2026-09-30T13:00:00Z'),
  sample(P1, 'SLEEP_TOTAL_MIN', 378, '2026-09-30T06:00:00Z', '2026-09-30T13:00:00Z'), // last night, ends 06:00 PT 09-30
  sample(P1, 'SLEEP_EFFICIENCY_PCT', 88, '2026-09-30T06:00:00Z', '2026-09-30T13:00:00Z'),
  // P1 — outside the 7-day window
  sample(P1, 'STEPS', 99999, '2026-09-20T18:00:00Z'),
  // P4 canary
  sample(P4, 'STEPS', 31111, '2026-09-30T18:00:00Z'),
];

// ─── tiny where-matcher ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number | string);
  const bv = b instanceof Date ? b.getTime() : (b as number | string);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date || typeof cond !== 'object') return cmp(value, cond) === 0;
  const c = cond as Record<string, unknown>;
  // relation filter (nested object without operator keys)
  const ops = ['gte', 'lte', 'lt', 'gt', 'in', 'not', 'equals'];
  if (!Object.keys(c).some((k) => ops.includes(k))) {
    return value !== null && typeof value === 'object' && matches(value as Row, c);
  }
  if ('equals' in c && cmp(value, c.equals) !== 0) return false;
  if ('gte' in c && cmp(value, c.gte) < 0) return false;
  if ('lte' in c && cmp(value, c.lte) > 0) return false;
  if ('lt' in c && cmp(value, c.lt) >= 0) return false;
  if ('gt' in c && cmp(value, c.gt) <= 0) return false;
  if ('in' in c && !(c.in as unknown[]).some((x) => cmp(value, x) === 0)) return false;
  if ('not' in c) {
    if (c.not === null ? value === null || value === undefined : cmp(value, c.not) === 0)
      return false;
  }
  return true;
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (!matchField(row[k], cond)) return false;
  }
  return true;
}

function applyOrderTake<T extends Row>(
  rows: T[],
  args: { orderBy?: Record<string, 'asc' | 'desc'>; take?: number },
): T[] {
  let out = [...rows];
  if (args.orderBy) {
    const [[key, dir]] = Object.entries(args.orderBy);
    out.sort((a, b) => (dir === 'asc' ? cmp(a[key], b[key]) : cmp(b[key], a[key])));
  }
  if (args.take != null) out = out.slice(0, args.take);
  return out;
}

// ─── the double ──────────────────────────────────────────────────────────────

export interface PersonaDb {
  prisma: PrismaService;
  raw: {
    users: Row[];
    macroTargets: Row[];
    loggedFood: Row[];
    assignments: Row[];
    workoutSessions: Row[];
    weightLogs: Row[];
    checkIns: Row[];
    guidelines: Row[];
    coachMessages: Row[];
    mealAssignments: Row[];
    catalog: Row[];
    romanMessages: Row[];
    communityPosts: Row[];
    wearableConnections: Row[];
    wearableSamples: Row[];
    coachingSessions: Row[];
    /** OR-113-2 content-free spend-ledger rows written by RomanService. */
    aiRequestAudits: Row[];
  };
  /** Count of every delegate call, in order. */
  calls: string[];
  /** Every where clause issued, keyed by delegate, for tenancy assertions. */
  wheres: Array<{ table: string; where: Where | undefined }>;
  /** Tables that were touched but must never be (coachingSession, communityWin, bloodwork…). */
  forbiddenTouched: string[];
}

export function makePersonaDb(): PersonaDb {
  const raw = {
    users: structuredClone(users) as Row[],
    macroTargets: structuredClone(macroTargets) as Row[],
    loggedFood: structuredClone(loggedFood) as Row[],
    assignments: structuredClone(assignments) as Row[],
    workoutSessions: structuredClone(workoutSessions) as Row[],
    weightLogs: structuredClone(weightLogs) as Row[],
    checkIns: structuredClone(checkIns) as Row[],
    guidelines: structuredClone(guidelines) as Row[],
    coachMessages: structuredClone(coachMessages) as Row[],
    mealAssignments: structuredClone(mealAssignments) as Row[],
    catalog: structuredClone(catalog) as Row[],
    romanMessages: [] as Row[],
    communityPosts: structuredClone(communityPosts) as Row[],
    wearableConnections: structuredClone(wearableConnections) as Row[],
    wearableSamples: structuredClone(wearableSamples) as Row[],
    coachingSessions: structuredClone(coachingSessions) as Row[],
    aiRequestAudits: [] as Row[],
  };
  const calls: string[] = [];
  const wheres: Array<{ table: string; where: Where | undefined }> = [];
  const forbiddenTouched: string[] = [];

  const many = (name: string, table: () => Row[]) =>
    jest.fn(
      async (
        args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; take?: number } = {},
      ) => {
        calls.push(`${name}.findMany`);
        wheres.push({ table: name, where: args.where });
        return applyOrderTake(
          table().filter((r) => matches(r, args.where)),
          args,
        );
      },
    );
  const first = (name: string, table: () => Row[]) =>
    jest.fn(async (args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'> } = {}) => {
      calls.push(`${name}.findFirst`);
      wheres.push({ table: name, where: args.where });
      return (
        applyOrderTake(
          table().filter((r) => matches(r, args.where)),
          { ...args, take: 1 },
        )[0] ?? null
      );
    });
  const forbidden = (name: string) =>
    new Proxy(
      {},
      {
        get: () => async () => {
          forbiddenTouched.push(name);
          return null;
        },
      },
    );

  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: Record<string, any> = {
    user: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        calls.push('user.findUnique');
        return raw.users.find((u) => u.id === args.where.id) ?? null;
      }),
    },
    macroTarget: {
      findFirst: first('macroTarget', () => raw.macroTargets),
      findMany: many('macroTarget', () => raw.macroTargets),
    },
    loggedFoodEntry: { findMany: many('loggedFoodEntry', () => raw.loggedFood) },
    clientWorkoutAssignment: { findMany: many('clientWorkoutAssignment', () => raw.assignments) },
    exerciseCatalogItem: { findMany: many('exerciseCatalogItem', () => raw.catalog) },
    workoutSession: { findMany: many('workoutSession', () => raw.workoutSessions) },
    weightLog: { findMany: many('weightLog', () => raw.weightLogs) },
    checkIn: { findMany: many('checkIn', () => raw.checkIns) },
    coachGuideline: {
      findFirst: first('coachGuideline', () => raw.guidelines),
      findUnique: first('coachGuideline', () => raw.guidelines),
    },
    coachMessage: {
      findMany: many('coachMessage', () => raw.coachMessages),
      findFirst: first('coachMessage', () => raw.coachMessages),
    },
    dailyMealPlanAssignment: {
      findFirst: first('dailyMealPlanAssignment', () => raw.mealAssignments),
    },
    // ctx-v2 (ruling #6): own community posts + wearables
    communityPost: { findMany: many('communityPost', () => raw.communityPosts) },
    wearableConnection: { findMany: many('wearableConnection', () => raw.wearableConnections) },
    wearableSample: { findMany: many('wearableSample', () => raw.wearableSamples) },
    // Roman transcript tables (used by RomanService in the wiring tests)
    romanMessage: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        calls.push('romanMessage.create');
        const row = { id: `msg_${++seq}`, created_at: new Date(), ...data };
        raw.romanMessages.push(row);
        return row;
      }),
      findMany: jest.fn(async () => {
        calls.push('romanMessage.findMany');
        return [...raw.romanMessages].reverse();
      }),
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
    },
    romanSession: {
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => null),
    },
    // OR-113-2 spend ledger (content-free reservation rows).
    aiRequestAudit: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        calls.push('aiRequestAudit.create');
        raw.aiRequestAudits.push({ ...data });
        return data;
      }),
      aggregate: jest.fn(async () => ({ _sum: { prompt_token_estimate: 0, response_token_estimate: 0 } })),
      update: jest.fn(async ({ where, data }: { where: { request_id: string }; data: Row }) => {
        const row = raw.aiRequestAudits.find((r) => r.request_id === where.request_id);
        if (row) Object.assign(row, data);
        return row ?? null;
      }),
    },
    coachSubscription: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    // Must never be read by the builder.
    // ctx-v3 bookings: only the selected columns ever leave this double, so a
    // builder that stopped selecting would surface the notes canary.
    coachingSession: {
      findMany: jest.fn(async (args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; take?: number; select?: Record<string, boolean> } = {}) => {
        calls.push('coachingSession.findMany');
        wheres.push({ table: 'coachingSession', where: args.where });
        const rows = applyOrderTake(raw.coachingSessions.filter((r) => matches(r, args.where)), args);
        const keys = Object.keys(args.select ?? {});
        return keys.length ? rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]]))) : rows;
      }),
    },
    communityWin: forbidden('communityWin'),
    bloodworkPanel: forbidden('bloodworkPanel'),
    clientPurchase: forbidden('clientPurchase'),
    coachSubscriptionInvoice: forbidden('coachSubscriptionInvoice'),
  };

  return {
    // @ts-expect-error partial structural mock of PrismaService — only the delegates the builder issues are stubbed.
    prisma,
    raw,
    calls,
    wheres,
    forbiddenTouched,
  };
}

/**
 * A fake C05 source. Per ruling #6 it exposes the client's OWN safety-screen
 * answers and consultation Q/A; its internal bookkeeping fields
 * (`any_yes`, `flag_categories`) are NOT part of the interface and must not
 * reach the prompt. Rows for other users must never be returned.
 */
export class FakeSafetyIntakeSource implements RomanSafetyIntakeSource {
  readonly internal: Record<
    string,
    {
      any_yes: boolean;
      flag_categories: string[];
      screen: Array<{ question: string; answer: string; flagged?: boolean }>;
      consult: Array<{ question: string; answer: string }>;
    }
  > = {
    [P2]: {
      any_yes: true,
      flag_categories: ['joint_or_bone', 'bp_or_heart_medication'],
      screen: [
        { question: 'Bone or joint problem?', answer: 'Yes, left knee replacement 2019', flagged: true },
        { question: 'Blood pressure or heart medication?', answer: 'Yes, lisinopril', flagged: true },
        { question: 'Chest pain with activity?', answer: 'No' },
      ],
      consult: [
        { question: 'Main goal', answer: 'Keep up with the grandkids, lose 20 lb' },
        { question: 'Training history', answer: 'Walking only for 10 years' },
      ],
    },
    [P1]: {
      any_yes: false,
      flag_categories: [],
      screen: [{ question: 'Chest pain with activity?', answer: 'No' }],
      consult: [{ question: 'Main goal', answer: 'Get strong, CONSULT-ANSWER-MAYA' }],
    },
    [P4]: {
      any_yes: false,
      flag_categories: [],
      screen: [{ question: 'Chest pain with activity?', answer: 'ZELDA-CANARY screen answer' }],
      consult: [{ question: 'Main goal', answer: 'ZELDA-CANARY goal' }],
    },
  };
  async summarize(userId: string): Promise<RomanConsultationSummary> {
    const row = this.internal[userId];
    if (!row) {
      return {
        safety_intake: { completed: false, clearance_recommended: false, screen_answers: [] },
        consultation: { completed: false, completed_at: null, answers: [] },
      };
    }
    return {
      safety_intake: {
        completed: true,
        clearance_recommended: row.any_yes,
        screen_answers: row.screen,
      },
      consultation: { completed: true, completed_at: '2026-09-01', answers: row.consult },
    };
  }
}

/** Internal field names of the source that must never reach the prompt. */
export const INTAKE_CANARIES = ['flag_categories', 'any_yes', 'joint_or_bone', 'bp_or_heart_medication'];
