/**
 * PATCH — exercise.entity.ts
 *
 * Add video_url field to Exercise interface and ExerciseWithVideo type.
 * Replace the original file content with this.
 */

/**
 * Exercise entity — typed representation of an ExerciseDB API exercise.
 * This is a DTO/value-object, not a Prisma model: exercises live in the
 * ExerciseDB catalog (external), not in our Postgres database. We cache
 * responses locally but treat ExerciseDB as the source of truth.
 */

export interface Exercise {
  /** ExerciseDB exercise identifier (e.g. "0001"). */
  id: string;
  /** Display name, title-cased. */
  name: string;
  /** Primary muscle group targeted. */
  bodyPart: string;
  /** Equipment required (e.g. "barbell", "dumbbell", "body weight"). */
  equipment: string;
  /** Primary muscle worked (e.g. "pectorals", "quads"). */
  target: string;
  /** Secondary muscles engaged. */
  secondaryMuscles: string[];
  /** Step-by-step instructions. */
  instructions: string[];
  /** Animated GIF URL served by ExerciseDB CDN. */
  gifUrl: string;
  /**
   * Video URL sourced from YMove (HLS, expires 48h) or MuscleWiki (stable MP4).
   * null when no video provider has a match for this exercise — callers should
   * display gifUrl as the fallback in that case.
   *
   * Provider precedence: YMove (HLS) → MuscleWiki (MP4) → null
   */
  video_url: string | null;
  /**
   * Which video provider supplied `video_url`.
   * null when video_url is null.
   */
  video_provider: 'ymove' | 'musclewiki' | null;
}

/** Paginated search result returned to callers. */
export interface ExerciseSearchResult {
  items: Exercise[];
  /** Opaque cursor for the next page; null when exhausted. */
  nextCursor: string | null;
  total: number;
}

/** Parameters accepted by ExerciseLibraryService.searchExercises(). */
export interface ExerciseSearchParams {
  /** Free-text search applied to exercise name. */
  q?: string;
  /** Filter by body-part / muscle group (ExerciseDB "bodyPart" field). */
  muscleGroup?: string;
  /** Filter by equipment string. */
  equipment?: string;
  /** Maximum items to return per page (default 20, max 100). */
  limit?: number;
  /** Pagination cursor returned by a prior call. */
  cursor?: string;
}
