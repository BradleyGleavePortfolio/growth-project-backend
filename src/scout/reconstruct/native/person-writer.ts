import { PersonState } from '@prisma/client';
import type { MappedClient } from '../mapping-spec';
import { NATIVE_KIND, PROVENANCE_OUTCOME, UNRESOLVED_CODE, unresolved } from './native-contract';
import {
  findOtherClaim,
  findProvenance,
  promoteToCreated,
  recordAlreadyPresent,
  recordCreated,
  type ProvenanceKey,
  type ProvenanceRow,
  type Tx,
} from './native-provenance';
import { LEDGER_TARGET_KIND, type PersistOutcome } from './persist-outcome';

/**
 * S8-D1 typed `person` handoff (contract `docs/decisions/2026-09-26-s8d-person-link.md`
 * §5.1 steps 1–3; owner decision D-S8-2 (a)). `clients` reconstructs into an
 * invite-pending, non-login, tenant-owned roster `Person` through the S8-C
 * writer shape — look the provenance up, verify the target, otherwise create —
 * and returns the typed outcome the engine ledgers with `target_kind = person`.
 *
 * Create-only (D-S8-4): a later pass never overwrites an accepted row, so a
 * coach-edited `display_name` survives every replay. No `User` is minted and no
 * email or name is ever an identity key; identity is the provenance row
 * (coach, staged namespace, `clients`, raw staged source_id) and — for rows
 * that predate D1 — the Person external ref (coach, platform, source_person_id).
 *
 * One native Person per accepted source identity (A1): the external ref is
 * keyed by the mapper's trimmed `sourcePersonId`, the provenance by the RAW
 * staged id, so two raw ids that trim alike would both find one Person. Step 2
 * therefore adopts a Person only while no other raw id of the family has a
 * resolved claim on it, and takes a `FOR UPDATE` row lock on the Person first
 * so a concurrent adopter or creator of the same Person is serialised inside
 * the engine transaction (the sanctioned lock pattern, regimes.service.ts).
 *
 * This module imports Prisma types and the provenance helpers only: no invite,
 * notification, email or linking path can be reached from an import.
 */

export interface RowIdentity {
  readonly source_platform: string;
  readonly source_id: string;
}

interface PersonTarget {
  readonly id: string;
  readonly coach_id: string;
  readonly state: PersonState;
}

const PERSON_SELECT = { id: true, coach_id: true, state: true } as const;

const ok = (targetId: string): PersistOutcome => ({
  ok: true,
  targetId,
  targetKind: LEDGER_TARGET_KIND.person,
  unresolvedChildren: 0,
});
const fail = (reason: string): PersistOutcome => ({ ok: false, reason });

/**
 * Verify a Person this coach may still hand records to (§5.1 step 1). A missing
 * or `Deleted` Person is `native_target_removed` — the coach's deletion is
 * honoured, never resurrected or re-created; another coach's Person is
 * `identity_conflict`. Nothing is written on any branch.
 */
function verifyPerson(coachId: string, person: PersonTarget | null): PersistOutcome {
  if (person === null) return fail(unresolved(UNRESOLVED_CODE.native_target_removed));
  // Ownership before state (C1): another coach's Person is a conflict whatever its state.
  if (person.coach_id !== coachId) return fail(unresolved(UNRESOLVED_CODE.identity_conflict));
  if (person.state === PersonState.Deleted)
    return fail(unresolved(UNRESOLVED_CODE.native_target_removed));
  return ok(person.id);
}

/**
 * Step 2 lock: re-read the located Person `FOR UPDATE` on the engine transaction.
 * The second of two concurrent adopters (or an adopter racing the creator) blocks
 * here until the first commits and then sees its claim. Parameterised, never
 * interpolated. An empty result means the row vanished since it was located.
 */
async function lockPerson(tx: Tx, personId: string): Promise<PersonTarget | null> {
  const locked = await tx.$queryRaw<PersonTarget[]>`
    SELECT "id", "coach_id", "state" FROM "Person" WHERE "id" = ${personId} FOR UPDATE
  `;
  return locked[0] ?? null;
}

/** Step 1: a resolved provenance row is the identity; its target must be a live Person of this coach. */
async function verifyProvenanceTarget(
  tx: Tx,
  coachId: string,
  existing: ProvenanceRow,
): Promise<PersistOutcome> {
  if (existing.native_kind !== NATIVE_KIND.person || existing.native_id === null)
    return fail(unresolved(UNRESOLVED_CODE.identity_conflict));
  const person = await tx.person.findUnique({
    where: { id: existing.native_id },
    select: PERSON_SELECT,
  });
  return verifyPerson(coachId, person);
}

/**
 * `clients` → `Person` (§5.1 steps 1–3). Runs on the engine's per-row
 * transaction: Person first, then provenance, then (in the engine) the ledger,
 * so a failure anywhere rolls all three back. Provenance is keyed by the raw
 * staged `source_id` under the canonical family (S9's join key); the Person
 * external ref carries the mapper's `sourcePersonId`.
 */
export async function persistPerson(
  tx: Tx,
  coachId: string,
  row: RowIdentity,
  entityType: string,
  client: MappedClient,
): Promise<PersistOutcome> {
  const provenance: ProvenanceKey = {
    coachId,
    sourceNamespace: row.source_platform,
    entityType,
    sourceId: row.source_id,
  };
  // Step 1 — provenance is the identity; verify, never touch the accepted row.
  const existing = await findProvenance(tx, provenance);
  if (existing !== null && existing.outcome !== PROVENANCE_OUTCOME.unresolved) {
    return verifyProvenanceTarget(tx, coachId, existing);
  }
  // Step 2 — a Person written before D1 (no provenance) is adopted ONCE at its
  // external ref: locked, verified like step 1, refused if another raw id of this
  // family already resolved to it (A1), else provenance `already_present`, name untouched.
  const located = await tx.person.findUnique({
    where: {
      coach_id_source_platform_source_person_id: {
        coach_id: coachId,
        source_platform: client.sourcePlatform,
        source_person_id: client.sourcePersonId,
      },
    },
    select: { id: true },
  });
  if (located !== null) {
    const verified = verifyPerson(coachId, await lockPerson(tx, located.id));
    if (!verified.ok) return verified;
    const claim = await findOtherClaim(tx, provenance, NATIVE_KIND.person, located.id);
    if (claim !== null) return fail(unresolved(UNRESOLVED_CODE.identity_conflict));
    await recordAlreadyPresent(tx, provenance, existing, NATIVE_KIND.person, located.id);
    return verified;
  }
  // Step 3 — create: state defaults to InvitePending; no User, no email, no name key.
  const person = await tx.person.create({
    data: {
      coach_id: coachId,
      source_platform: client.sourcePlatform,
      source_person_id: client.sourcePersonId,
      display_name: client.displayName,
    },
    select: { id: true },
  });
  if (existing === null) await recordCreated(tx, provenance, NATIVE_KIND.person, person.id, []);
  else await promoteToCreated(tx, existing.id, NATIVE_KIND.person, person.id, []);
  return ok(person.id);
}
