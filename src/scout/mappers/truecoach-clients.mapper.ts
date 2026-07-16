import { Prisma } from '@prisma/client';

/**
 * A staged client entity mapped to the fields needed to reconstruct an
 * invite-pending roster Person. Identity is the source platform id
 * (`sourcePersonId`), never email — D2 forbids email as a canonical or linking
 * key, so this mapper never reads it.
 */
export interface MappedClient {
  readonly sourcePersonId: string;
  readonly sourcePlatform: string;
  readonly displayName: string | null;
}

/** Total-function result: either a mapped client or a skip with a reason. */
export type MapClientResult =
  | { readonly ok: true; readonly client: MappedClient }
  | { readonly ok: false; readonly reason: string };

/** The staged row shape this mapper consumes (a persisted ScoutIngestEntity). */
export interface StagedClientRow {
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
}

/**
 * Pure, deterministic, total mapper for TrueCoach `clients` entities. Given a
 * staged row it returns either a reconstructable client or an explicit skip
 * reason — it never throws, so the caller's accounting is exhaustive. Only the
 * opaque platform id is used as the dedup key; the display name is best-effort
 * and optional; email is deliberately ignored.
 */
export function mapTrueCoachClient(row: StagedClientRow): MapClientResult {
  if (row.source_platform !== 'truecoach') {
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
      displayName: extractDisplayName(row.payload),
    },
  };
}

/** Read a non-empty `name` string from the opaque payload, else null. */
function extractDisplayName(payload: Prisma.JsonValue): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const name = (payload as Record<string, Prisma.JsonValue>)['name'];
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}
