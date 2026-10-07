// AIB-NAMES-127 — name and muscle for workout rows outside the seed LIBRARY (ExerciseDB ids picked from exercise search).
// A row stores only its id, so the builder reads the same cached catalog entry the app already loads to show each row's
// name (ExerciseLibraryService.getExerciseById). No AI provider call. Bounded: at most ROW_CATALOG_MAX distinct ids, one
// deadline for all of them, and every field capped. An id that does not resolve stays unknown and the validator flags it.
import type { Exercise } from '../../../exercise-library/exercise.entity';
import type { LibraryExercise } from './workout-diff.validator';

export const ROW_CATALOG_MAX = 40;
export const ROW_CATALOG_DEADLINE_MS = 2_500;
const NAME_MAX = 80;
const FIELD_MAX = 40;

export type ExerciseLookup = (id: string) => Promise<Pick<Exercise, 'name' | 'bodyPart' | 'target'>>;

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

async function lookupOne(lookup: ExerciseLookup, id: string): Promise<LibraryExercise | null> {
  try {
    const e = await lookup(id);
    // ExerciseDB names are lower case; the first letter is raised so a drop reason or card title reads as a sentence.
    const raw = text(e?.name, NAME_MAX);
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    return name ? { id, name, category: text(e.bodyPart, FIELD_MAX), muscle: text(e.target, FIELD_MAX), thumbnail_url: null } : null;
  } catch {
    // Not found or the catalog is unreachable: the row stays unknown, and the injury screen flags it to the coach.
    return null;
  }
}

/** Catalog entries for the ids that `known` (the seed LIBRARY) does not cover. Never throws; a miss is simply absent. */
export async function resolveRowCatalog(
  lookup: ExerciseLookup, ids: Iterable<string>, known: ReadonlyMap<string, LibraryExercise>, deadlineMs = ROW_CATALOG_DEADLINE_MS,
): Promise<Map<string, LibraryExercise>> {
  const wanted = [...new Set(ids)].filter((id) => id.length > 0 && !known.has(id)).slice(0, ROW_CATALOG_MAX);
  const found = new Map<string, LibraryExercise>();
  if (wanted.length === 0) return found;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); });
  const all = Promise.all(wanted.map(async (id) => {
    const entry = await lookupOne(lookup, id);
    if (entry) found.set(id, entry);
  }));
  await Promise.race([all, deadline]);
  clearTimeout(timer);
  return new Map(found);
}
