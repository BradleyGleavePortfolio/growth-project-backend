import { Prisma } from '@prisma/client';
import {
  NATIVE_KIND,
  PROVENANCE_OUTCOME,
  childSourceIdPrefix,
  joinTags,
  type NativeKind,
} from './native-contract';

/**
 * `ImportNativeProvenance` primitives (S8-B model, contract §3.2/§3.3, D-S8-3).
 * Identity is (coach_id, source_namespace, entity_type, source_id); the
 * namespace is the staged `source_platform`. Every helper runs on the caller's
 * transaction so a native row and its provenance commit or roll back together.
 * `import_intent_id` stays NULL here: the ledger's intent id is a string and the
 * column is a UUID; attribution is a later G3 slice, never guessed.
 */
export type Tx = Prisma.TransactionClient;

export interface ProvenanceKey {
  readonly coachId: string;
  readonly sourceNamespace: string;
  readonly entityType: string;
  readonly sourceId: string;
}

export interface ProvenanceRow {
  readonly id: string;
  readonly native_kind: string;
  readonly native_id: string | null;
  readonly outcome: string;
  readonly reason: string | null;
}

function identity(key: ProvenanceKey) {
  return {
    coach_id: key.coachId,
    source_namespace: key.sourceNamespace,
    entity_type: key.entityType,
    source_id: key.sourceId,
  };
}

export async function findProvenance(tx: Tx, key: ProvenanceKey): Promise<ProvenanceRow | null> {
  return tx.importNativeProvenance.findUnique({
    where: { coach_id_source_namespace_entity_type_source_id: identity(key) },
    select: { id: true, native_kind: true, native_id: true, outcome: true, reason: true },
  });
}

/** Record a CREATED native row (tags → nullable reason). Insert-only: identity races surface as P2002. */
export async function recordCreated(
  tx: Tx,
  key: ProvenanceKey,
  nativeKind: NativeKind,
  nativeId: string,
  tags: readonly string[],
): Promise<void> {
  await tx.importNativeProvenance.create({
    data: {
      ...identity(key),
      native_kind: nativeKind,
      native_id: nativeId,
      outcome: PROVENANCE_OUTCOME.created,
      reason: joinTags(tags),
    },
  });
}

/** Promote an existing UNRESOLVED identity to CREATED (the row later became materializable). */
export async function promoteToCreated(
  tx: Tx,
  provenanceId: string,
  nativeKind: NativeKind,
  nativeId: string,
  tags: readonly string[],
): Promise<void> {
  await tx.importNativeProvenance.update({
    where: { id: provenanceId },
    data: {
      native_kind: nativeKind,
      native_id: nativeId,
      outcome: PROVENANCE_OUTCOME.created,
      reason: joinTags(tags),
    },
  });
}

/**
 * Record (or refresh the reason of) an UNRESOLVED identity. The caller has
 * already established in this transaction that no CREATED row exists for the
 * identity, so the update branch can only touch an unresolved row.
 */
export async function recordUnresolved(
  tx: Tx,
  key: ProvenanceKey,
  nativeKind: NativeKind,
  reason: string,
): Promise<void> {
  await tx.importNativeProvenance.upsert({
    where: { coach_id_source_namespace_entity_type_source_id: identity(key) },
    create: {
      ...identity(key),
      native_kind: nativeKind,
      native_id: null,
      outcome: PROVENANCE_OUTCOME.unresolved,
      reason,
    },
    update: { native_kind: nativeKind, reason },
  });
}

/** Count a parent's nested children recorded unresolved (re-reported on every replay, §3.2). */
export async function countUnresolvedChildren(tx: Tx, parent: ProvenanceKey): Promise<number> {
  return tx.importNativeProvenance.count({
    where: {
      coach_id: parent.coachId,
      source_namespace: parent.sourceNamespace,
      entity_type: parent.entityType,
      source_id: { startsWith: childSourceIdPrefix(parent.sourceId) },
      native_kind: NATIVE_KIND.workout_plan_exercise,
      outcome: PROVENANCE_OUTCOME.unresolved,
    },
  });
}
