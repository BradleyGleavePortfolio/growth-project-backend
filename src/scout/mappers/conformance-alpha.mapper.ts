import { Prisma } from '@prisma/client';
import { type MapClientResult, type StagedClientRow } from './truecoach-clients.mapper';
import { type MapEntityResult, type StagedEntityRow } from './truecoach-entity.mapper';

/**
 * Adapter #2 — `conformance_alpha`. A synthetic, NON-PRODUCTION source that
 * proves the frozen `SourceMapper` seam is source-neutral: a second source is one
 * mapper pair + one registry line, with no engine/DTO/contract/schema change. No
 * public connector or coach-selectable flow creates `conformance_alpha` sessions
 * today, so it is not reached in normal operation; its registration exercises the
 * same production-neutral dispatch path for deterministic conformance/E2E and is
 * not itself an authorization boundary (tenant/RLS scoping and the existing
 * default-off scout flags remain the boundaries). It differs STRUCTURALLY from
 * TrueCoach so tests cannot pass by coincidence — person name is nested at
 * `profile.name` and non-person fields
 * live under `attributes.*` with a `member_id` soft link (TrueCoach uses flat
 * `name`/`client_id`); the opaque `source_id` still carries the record id. Both
 * mappers are pure and total: a malformed or foreign row yields an explicit skip
 * reason (byte-identical to TrueCoach) rather than a throw.
 */
const SOURCE_PLATFORM = 'conformance_alpha';

/** Map a `members` record to the canonical roster client (person family). */
export function mapConformanceAlphaClient(row: StagedClientRow): MapClientResult {
  if (row.source_platform !== SOURCE_PLATFORM) {
    return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
  }
  const sourcePersonId = row.source_id.trim();
  if (sourcePersonId.length === 0) {
    return { ok: false, reason: 'missing_source_id' };
  }
  return {
    ok: true,
    client: {
      sourcePersonId,
      sourcePlatform: row.source_platform,
      displayName: nestedString(row.payload, 'profile', 'name'),
    },
  };
}

/** Map a `routines` / `activity-log` record to the canonical generic entity. */
export function mapConformanceAlphaEntity(row: StagedEntityRow): MapEntityResult {
  if (row.source_platform !== SOURCE_PLATFORM) {
    return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
  }
  if (row.source_id.trim().length === 0) {
    return { ok: false, reason: 'missing_source_id' };
  }
  return {
    ok: true,
    entity: {
      sourcePlatform: row.source_platform,
      clientSourceId: nestedString(row.payload, 'attributes', 'member_id'),
      label: nestedString(row.payload, 'attributes', 'title'),
    },
  };
}

/** Narrow an opaque JSON value to an indexable object, else null. */
function asObject(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, Prisma.JsonValue>;
}

/**
 * Read a non-empty scalar from `payload[outer][inner]`, coercing a finite number
 * to its string form. Any missing level, wrong type, or empty string → null, so
 * an omitted optional field degrades to a soft null instead of throwing.
 */
function nestedString(payload: Prisma.JsonValue, outer: string, inner: string): string | null {
  const nested = asObject(asObject(payload)?.[outer]);
  if (nested === null) return null;
  const raw = nested[inner];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}
