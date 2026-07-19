import { Prisma } from '@prisma/client';

/**
 * A staged non-person entity (a `workouts` or `client_history` row) mapped to the
 * PII-minimal fields needed to reconstruct a canonical `ScoutReconstructedEntity`.
 * Identity is the source platform's opaque record id — carried by the engine as
 * the tenant-scoped external_ref key, never email and never a billing key.
 * `clientSourceId` is a soft provenance link to the owning client's source id
 * (the Person external_ref), and `label` is a best-effort display title — D2
 * forbids email/billing as canonical or linking keys, so this mapper never reads
 * them.
 */
export interface MappedEntity {
  readonly sourcePlatform: string;
  readonly clientSourceId: string | null;
  readonly label: string | null;
}

/** Total-function result: either a mapped entity or a skip with a reason. */
export type MapEntityResult =
  | { readonly ok: true; readonly entity: MappedEntity }
  | { readonly ok: false; readonly reason: string };

/** The staged row shape this mapper consumes (a persisted ScoutIngestEntity). */
export interface StagedEntityRow {
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
}

/**
 * Pure, deterministic, total mapper for TrueCoach non-person families
 * (`workouts`, `client_history`). Given a staged row it returns either a
 * reconstructable canonical entity or an explicit skip reason — it never throws,
 * so the caller's accounting is exhaustive. Only opaque platform ids and a
 * best-effort display label are used; email and any billing/price field are
 * deliberately ignored (they are never read from the payload).
 */
export function mapTrueCoachEntity(row: StagedEntityRow): MapEntityResult {
  if (row.source_platform !== 'truecoach') {
    return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
  }
  if (row.source_id.trim().length === 0) {
    return { ok: false, reason: 'missing_source_id' };
  }
  return {
    ok: true,
    entity: {
      sourcePlatform: row.source_platform,
      clientSourceId: extractClientSourceId(row.payload),
      label: extractLabel(row.payload),
    },
  };
}

/** Narrow the opaque payload to an indexable object, else null. */
function asObject(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, Prisma.JsonValue>;
}

/**
 * Read the owning client's opaque source id from `client_id` / `clientId`,
 * coercing a numeric id to its string form. Never email. Returns null when
 * absent or not a scalar id.
 */
function extractClientSourceId(payload: Prisma.JsonValue): string | null {
  const obj = asObject(payload);
  if (obj === null) return null;
  const raw = obj['client_id'] ?? obj['clientId'];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** Read a non-empty display title from `title` / `name`, else null. */
function extractLabel(payload: Prisma.JsonValue): string | null {
  const obj = asObject(payload);
  if (obj === null) return null;
  const raw = obj['title'] ?? obj['name'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
