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
