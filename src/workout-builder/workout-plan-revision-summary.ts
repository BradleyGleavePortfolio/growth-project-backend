/**
 * AIB-4 — read-only revision history (GET /workout-plans/:planId/revisions).
 * A revision row stores a full snapshot and no summary, so the one-line summary
 * is derived by comparing each snapshot with its direct predecessor. Only
 * counts and the cause are used: no notes, no client data, no free text.
 */
export const REVISIONS_LIST_DEFAULT_LIMIT = 20;
export const REVISIONS_LIST_MAX_LIMIT = 50;

export interface RevisionListItem {
  revision_index: number;
  author_kind: string;
  cause: string;
  created_at: string;
  summary: string;
}

type SnapshotRow = Record<string, unknown> & { exercise_external_id: string };

const CAUSE_LABELS: Record<string, string> = {
  initial: 'Created',
  clone: 'Copied from a program',
  manual_edit: 'Edited',
  autosave: 'Edited',
  ai_apply: 'AI-suggested, coach-approved',
  undo: 'Restored an earlier version',
};
const COMPARED = ['sets', 'reps_or_duration_seconds', 'weight_lbs', 'rest_seconds', 'superset_group_id'];

/** Clamp the `limit` query value to 1..50, defaulting to 20. */
export function parseRevisionsLimit(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : REVISIONS_LIST_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), REVISIONS_LIST_MAX_LIMIT);
}

function readRows(json: unknown): SnapshotRow[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (r): r is SnapshotRow => typeof r === 'object' && r !== null && typeof r.exercise_external_id === 'string',
  );
}

const rowKey = (r: SnapshotRow): string => COMPARED.map((k) => String(r[k] ?? null)).join('|');

/** "Edited: 1 added, 2 changed. 6 exercises." Rows match by exercise id, pair by pair. */
export function summariseRevision(cause: string, before: SnapshotRow[] | null, after: SnapshotRow[]): string {
  const label = CAUSE_LABELS[cause] ?? 'Edited';
  const total = `${after.length} exercise${after.length === 1 ? '' : 's'}`;
  if (before === null) return `${label}. ${total}.`;
  const pool = new Map<string, SnapshotRow[]>();
  for (const r of before) pool.set(r.exercise_external_id, [...(pool.get(r.exercise_external_id) ?? []), r]);
  let added = 0;
  let changed = 0;
  for (const r of after) {
    const match = pool.get(r.exercise_external_id)?.shift();
    if (!match) added += 1;
    else if (rowKey(match) !== rowKey(r)) changed += 1;
  }
  const removed = [...pool.values()].reduce((n, l) => n + l.length, 0);
  const parts = [
    added && `${added} added`,
    changed && `${changed} changed`,
    removed && `${removed} removed`,
  ].filter(Boolean);
  return parts.length ? `${label}: ${parts.join(', ')}. ${total}.` : `${label}. ${total}.`;
}

/**
 * `rows` are newest first and may hold one extra older row beyond `limit`,
 * used only as the baseline of the oldest listed revision. A pruned gap is
 * never treated as a baseline.
 */
export function buildRevisionList(
  rows: Array<{ revision_index: number; author_kind: string; cause: string; created_at: Date; exercises_json: unknown }>,
  limit: number,
): RevisionListItem[] {
  const snapshots = rows.map((r) => readRows(r.exercises_json));
  return rows.slice(0, limit).map((r, i) => ({
    revision_index: r.revision_index,
    author_kind: r.author_kind,
    cause: r.cause,
    created_at: r.created_at.toISOString(),
    summary: summariseRevision(
      r.cause,
      rows[i + 1]?.revision_index === r.revision_index - 1 ? snapshots[i + 1] : null,
      snapshots[i],
    ),
  }));
}
