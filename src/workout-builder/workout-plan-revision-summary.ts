/**
 * AIB-4 — read-only revision history for the workout builder
 * (GET /workout-plans/:planId/revisions, AI_MASTER_BUILDER_PLAN.md section 3).
 *
 * A WorkoutPlanRevision row stores a full exercise snapshot, not a diff, and
 * has no summary column. The one-line summary the History sheet shows is
 * derived here, deterministically, by comparing each snapshot with the one
 * before it. Only counts and the cause are used: no exercise notes, no client
 * data and no free text ever reach the summary.
 */

/** Default and maximum page size for the revisions list. */
export const REVISIONS_LIST_DEFAULT_LIMIT = 20;
export const REVISIONS_LIST_MAX_LIMIT = 50;

/** The row fields the summary reads from a stored exercises_json snapshot. */
export interface RevisionSnapshotRow {
  exercise_external_id: string;
  sets?: number | null;
  reps_or_duration_seconds?: number | null;
  weight_lbs?: number | null;
  rest_seconds?: number | null;
  superset_group_id?: string | null;
}

export interface RevisionListItem {
  revision_index: number;
  author_kind: string;
  cause: string;
  created_at: string;
  summary: string;
}

const CAUSE_LABELS: Record<string, string> = {
  initial: 'Created',
  clone: 'Copied from a program',
  manual_edit: 'Edited',
  autosave: 'Edited',
  ai_apply: 'AI-suggested, coach-approved',
  undo: 'Restored an earlier version',
};

/** Clamp the `limit` query value to 1..50, defaulting to 20. */
export function parseRevisionsLimit(raw: unknown): number {
  const n =
    typeof raw === 'string' && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : typeof raw === 'number' && Number.isInteger(raw)
        ? raw
        : REVISIONS_LIST_DEFAULT_LIMIT;
  if (n < 1) return 1;
  return Math.min(n, REVISIONS_LIST_MAX_LIMIT);
}

/** Read a stored snapshot defensively; a malformed one counts as empty rows. */
export function readSnapshotRows(json: unknown): RevisionSnapshotRow[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (r): r is RevisionSnapshotRow =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as { exercise_external_id?: unknown }).exercise_external_id ===
        'string',
  );
}

function rowKey(r: RevisionSnapshotRow): string {
  return [
    r.sets ?? null,
    r.reps_or_duration_seconds ?? null,
    r.weight_lbs ?? null,
    r.rest_seconds ?? null,
    r.superset_group_id ?? null,
  ].join('|');
}

/**
 * Count added / removed / changed exercises between two snapshots. Rows are
 * matched by exercise id in order of appearance, so a workout holding the same
 * exercise twice is compared pair by pair.
 */
export function diffSnapshotCounts(
  before: RevisionSnapshotRow[] | null,
  after: RevisionSnapshotRow[],
): { added: number; removed: number; changed: number } {
  if (before === null) return { added: 0, removed: 0, changed: 0 };
  const pool = new Map<string, RevisionSnapshotRow[]>();
  for (const r of before) {
    const list = pool.get(r.exercise_external_id) ?? [];
    list.push(r);
    pool.set(r.exercise_external_id, list);
  }
  let added = 0;
  let changed = 0;
  for (const r of after) {
    const list = pool.get(r.exercise_external_id);
    const match = list?.shift();
    if (!match) {
      added += 1;
    } else if (rowKey(match) !== rowKey(r)) {
      changed += 1;
    }
  }
  let removed = 0;
  for (const list of pool.values()) removed += list.length;
  return { added, removed, changed };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One-line summary, for example "Edited: 1 added, 2 changed. 6 exercises." */
export function summariseRevision(
  cause: string,
  before: RevisionSnapshotRow[] | null,
  after: RevisionSnapshotRow[],
): string {
  const label = CAUSE_LABELS[cause] ?? 'Edited';
  const { added, removed, changed } = diffSnapshotCounts(before, after);
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (changed) parts.push(`${changed} changed`);
  if (removed) parts.push(`${removed} removed`);
  const total = plural(after.length, 'exercise');
  return parts.length
    ? `${label}: ${parts.join(', ')}. ${total}.`
    : `${label}. ${total}.`;
}

/**
 * Build the newest-first list. `rows` must be newest first and may hold one
 * extra (older) row beyond `limit`, used only as the baseline of the oldest
 * listed revision.
 */
export function buildRevisionList(
  rows: Array<{
    revision_index: number;
    author_kind: string;
    cause: string;
    created_at: Date;
    exercises_json: unknown;
  }>,
  limit: number,
): RevisionListItem[] {
  const snapshots = rows.map((r) => readSnapshotRows(r.exercises_json));
  return rows.slice(0, limit).map((r, i) => {
    const older = rows[i + 1];
    // Only a direct predecessor is a fair baseline; a pruned gap is not.
    const baseline =
      older && older.revision_index === r.revision_index - 1
        ? snapshots[i + 1]
        : null;
    return {
      revision_index: r.revision_index,
      author_kind: r.author_kind,
      cause: r.cause,
      created_at: r.created_at.toISOString(),
      summary: summariseRevision(r.cause, baseline, snapshots[i]),
    };
  });
}
