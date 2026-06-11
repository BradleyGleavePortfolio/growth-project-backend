import { z } from 'zod';

/**
 * v2-1 plan-context tags.
 *
 * A plan-context tag is a typed reference a coach (or client) can attach to a
 * community message so the message renders against a concrete item in the
 * coach's plan (e.g. "this DM is about Week 3 Day 2 deadlift"). The tag is a
 * discriminated union keyed on `type`; each arm carries the ids needed to
 * resolve a render snapshot:
 *
 *  - workout: a `workout_plan_id`, with optional `week_index` / `day_index`
 *    (program coordinates) and an optional `exercise_id`.
 *  - meal:    a `meal_plan_id`, with an optional `meal_id` (a free-form
 *    reference into the plan's JSON `items` / `days`; not an FK).
 *  - package: a `package_id` for billing-context discussion.
 *  - check_in: a `check_in_id` for accountability.
 *
 * The full union is persisted verbatim in `community_messages.plan_context_payload`
 * (JsonB). The legacy scalar columns (`plan_context_type` / `plan_context_id`)
 * are NOT reused — they back the post-comment discriminator and stay untouched.
 *
 * Every boundary uses these Zod schemas (R68: typed, no `any`). Index ranges
 * are bounded so a malformed coordinate fails validation rather than reaching
 * the database.
 */

/** Plan-context tag discriminant values, also the resolve route's `type`. */
export const PLAN_CONTEXT_TYPES = [
  'workout',
  'meal',
  'package',
  'check_in',
] as const;

export const PlanContextTypeSchema = z.enum(PLAN_CONTEXT_TYPES);
export type PlanContextType = z.infer<typeof PlanContextTypeSchema>;

// A program can run many weeks/days; cap the coordinate space generously so a
// nonsensical index (negative, fractional, or absurd) is rejected at the edge.
const MAX_WEEK_INDEX = 519; // ~10 years of weekly programming
const MAX_DAY_INDEX = 6; // 0-based day-of-week within a program week

const weekIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_WEEK_INDEX)
  .optional();

const dayIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_DAY_INDEX)
  .optional();

// WorkoutPlan / CoachPackage ids are stringified UUIDs; CheckIn ids are UUIDs.
// `meal_id` is a free-form reference into the meal plan's JSON, capped in
// length so it cannot be used to smuggle an oversized payload.
const MAX_MEAL_ID_LEN = 128;

export const WorkoutPlanContextTagSchema = z
  .object({
    type: z.literal('workout'),
    workout_plan_id: z.string().uuid(),
    week_index: weekIndex,
    day_index: dayIndex,
    exercise_id: z.string().uuid().optional(),
  })
  .strict();

export const MealPlanContextTagSchema = z
  .object({
    type: z.literal('meal'),
    meal_plan_id: z.string().uuid(),
    meal_id: z.string().min(1).max(MAX_MEAL_ID_LEN).optional(),
  })
  .strict();

export const PackagePlanContextTagSchema = z
  .object({
    type: z.literal('package'),
    package_id: z.string().uuid(),
  })
  .strict();

export const CheckInPlanContextTagSchema = z
  .object({
    type: z.literal('check_in'),
    check_in_id: z.string().uuid(),
  })
  .strict();

/** The discriminated-union plan-context tag carried on a message. */
export const PlanContextTagSchema = z.discriminatedUnion('type', [
  WorkoutPlanContextTagSchema,
  MealPlanContextTagSchema,
  PackagePlanContextTagSchema,
  CheckInPlanContextTagSchema,
]);

export type PlanContextTag = z.infer<typeof PlanContextTagSchema>;
export type WorkoutPlanContextTag = z.infer<typeof WorkoutPlanContextTagSchema>;
export type MealPlanContextTag = z.infer<typeof MealPlanContextTagSchema>;
export type PackagePlanContextTag = z.infer<typeof PackagePlanContextTagSchema>;
export type CheckInPlanContextTag = z.infer<typeof CheckInPlanContextTagSchema>;

// ── Resolve route input (GET /community/plan-context/resolve) ──────────────

/**
 * Query for the read-only resolve endpoint. `type` selects the arm, `id` is the
 * primary reference for that arm (workout_plan_id / meal_plan_id / package_id /
 * check_in_id). Optional coordinates refine a workout snapshot. Parsed with
 * `coerce` because query-string values arrive as strings.
 */
export const ResolvePlanContextQuerySchema = z
  .object({
    type: PlanContextTypeSchema,
    id: z.string().uuid(),
    week_index: z.coerce.number().int().min(0).max(MAX_WEEK_INDEX).optional(),
    day_index: z.coerce.number().int().min(0).max(MAX_DAY_INDEX).optional(),
    exercise_id: z.string().uuid().optional(),
    meal_id: z.string().min(1).max(MAX_MEAL_ID_LEN).optional(),
  })
  .strict();

export type ResolvePlanContextQuery = z.infer<
  typeof ResolvePlanContextQuerySchema
>;

// ── Resolve snapshot (response) ────────────────────────────────────────────

const WorkoutSnapshotSchema = z
  .object({
    type: z.literal('workout'),
    workout_plan_id: z.string().uuid(),
    name: z.string(),
    plan_type: z.enum(['strength', 'cardio', 'mobility']),
    week_index: z.number().int().nullable(),
    day_index: z.number().int().nullable(),
    exercise: z
      .object({
        id: z.string().uuid(),
        exercise_external_id: z.string(),
        order: z.number().int(),
        sets: z.number().int(),
        reps_or_duration_seconds: z.number().int(),
      })
      .nullable(),
  })
  .strict();

const MealSnapshotSchema = z
  .object({
    type: z.literal('meal'),
    meal_plan_id: z.string().uuid(),
    title: z.string(),
    meal_id: z.string().nullable(),
  })
  .strict();

const PackageSnapshotSchema = z
  .object({
    type: z.literal('package'),
    package_id: z.string().uuid(),
    name: z.string(),
    amount_cents: z.number().int(),
    currency: z.string(),
    billing_type: z.string(),
  })
  .strict();

const CheckInSnapshotSchema = z
  .object({
    type: z.literal('check_in'),
    check_in_id: z.string().uuid(),
    date: z.string(),
    check_in_type: z.string(),
    reviewed_by_coach: z.boolean(),
  })
  .strict();

export const PlanContextSnapshotSchema = z.discriminatedUnion('type', [
  WorkoutSnapshotSchema,
  MealSnapshotSchema,
  PackageSnapshotSchema,
  CheckInSnapshotSchema,
]);

export type PlanContextSnapshot = z.infer<typeof PlanContextSnapshotSchema>;

export const ResolvePlanContextResponseSchema = z
  .object({
    snapshot: PlanContextSnapshotSchema,
  })
  .strict();

export type ResolvePlanContextResponse = z.infer<
  typeof ResolvePlanContextResponseSchema
>;
