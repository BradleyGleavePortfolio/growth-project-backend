import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { interpretEntity } from '../reconstruct/mapping-spec';
import {
  CHILD_ENTITY_TYPE,
  NATIVE_KIND,
  PROVENANCE_OUTCOME,
} from '../reconstruct/native/native-contract';
import { buildNativeFamilies } from '../reconstruct/native/native-families';
import {
  buildNativeRuleRegistry,
  type NativeRuleRegistry,
} from '../reconstruct/native/native-rule-registry';
import { LEDGER_TARGET_KIND } from '../reconstruct/native/persist-outcome';
import {
  buildSourceMapperRegistry,
  resolveStagedFamily,
  type SourceMapper,
} from '../reconstruct/source-mapper-registry';
import {
  RECONSTRUCT_FAMILY,
  RECONSTRUCT_MAX_ROWS,
  RECONSTRUCT_PAGE_SIZE,
} from '../scout-reconstruct.dto';
import { SCOUT_TERMINAL_STATUSES, type ScoutTerminalStatus } from '../scout.dto';
import {
  NATIVE_TARGET_KINDS,
  type ClaimStatus,
  type FamilyFacts,
  type FamilyQualifier,
  type IdentityFacts,
  type LedgerRowFacts,
  type LedgerTargetKind,
  type NativeTargetCheck,
  type NativeTargetKind,
  type ProvenanceFacts,
  type ProvenanceOutcome,
  type ReconciliationFacts,
  type RelationshipFacts,
} from './types';

/**
 * S9-B — the reconciliation facts service (S9-DOC D-S9-1 "a facts service collects its input").
 *
 * Collects the `ReconciliationFacts` that the pure S9-A `reconcile(facts)` consumes, for ONE
 * server run `(coach_id, intent_id)`, from the landed S7-L/S8-A/S8-B/S8-C tables only. This module
 *
 *  - never writes: no ledger, provenance, native, run-row or terminal write; reads only;
 *  - is tenant-scoped: every staged / ledger / provenance / evidence read carries `coach_id`;
 *    the native-target reads by id follow the S8-C `verifyTarget` precedent (`native-writers.ts`
 *    L66-89: the native id is the sole join, the owner is compared afterwards) so that a row
 *    owned by another coach is reported as `foreign_owner` and never as present — nothing about
 *    that row other than the comparison result leaves this module;
 *  - preserves native evidence truth: `coverage` is `null` in v1 (D-S9-3), `created` vs
 *    `already_present` is NOT split (D-S9-4; provenance `import_intent_id` is NULL at S8-C), an
 *    unknown is never a `0`, and no persistence of the report exists (D-S9-5);
 *  - is source-agnostic: grouping is the accepted `resolveStagedFamily`, the parent role and the
 *    client link are read through the accepted S8-A / S8-C interpreters, never through a
 *    platform-specific branch;
 *  - is aggregate: O(pages + families + native kinds) queries, never a query per staged row.
 *
 * Grouping (D-S9-2). Every staged row is grouped by `resolveStagedFamily(registry,
 * source_platform, entity_type)`. A row whose token resolves through the spec's `steps` joins the
 * canonical family's ONE mapped entry. A row whose token IS a canonical family name that the
 * platform's spec declares joins that family as well — this is the accepted staging convention
 * the S8-C dispatch honours (`native-families.ts` `dispatch`: the engine selects rows by
 * `entity_type == family`, so the token equals the family). Any other row forms the unmapped
 * entry keyed by its raw token with `resolution_reason` `unresolved_family:<token>` or
 * `unsupported_platform:<p>`. Entries are unique on `(mapped, family)` (S9-A B-1 invariant).
 *
 * Joins (D-S9-2). Staged ↔ ledger on the wide identity `(coach_id, intent_id, entity_type,
 * source_platform, source_id)`. Staged ↔ provenance on the D-S8-3 key `(coach_id,
 * source_namespace = source_platform, entity_type = canonical family, source_id)`. Children are
 * provenance rows `entity_type = 'workouts.exercise'` whose `source_id` carries the parent's
 * `<len>:<parent>#` prefix (`childSourceIdPrefix`).
 *
 * Relationship edges (B-2 closure, S9_A_REVIEW_A). For every staged identity whose canonical
 * family declares a relationship, EXACTLY ONE edge is emitted per declared relationship, whether
 * or not the parent resolves:
 *  - E-R1 `program_parent`: a `workouts` row whose accepted interpreter derivation carries a
 *    `programSourceId` (`interpretWorkout` via `buildNativeFamilies().workouts.map`). Target is
 *    the `programs` identity `(same platform, programSourceId)`; when no such staged identity or
 *    provenance exists the edge still exists with that unresolvable `to_identity`, and
 *    `consistent` is `false` (the native `program_id` / `(week_index, day_index)` comparison did
 *    not succeed) — it fails closure in S9-A `edgeVerified`.
 *  - E-R2 `child_order`: one edge per created/already-present child provenance row under a
 *    `workouts` parent, target = the parent plan identity; `consistent` is `true` only when the
 *    `WorkoutPlanExercise` row exists unarchived, its `workout_plan_id` is the parent's verified
 *    native id and, for the `#ord:<n>` identity form, its `order` equals `n`.
 *  - E-R3 `client_link`: one edge per identity whose S8-A interpretation carries a
 *    `clientSourceId`, target = the `clients` identity `(same platform, clientSourceId)`;
 *    `consistent` is `null` (soft link, no native attribute to compare; S8-DOC §3.8).
 * `consistent` is never `true` by assumption: it is `true` only after a successful comparison.
 */

/** The transaction (or client) the caller already holds; S9 runs inside S8-G's settle tx (D-S9-1). */
export type FactsDb = Prisma.TransactionClient;

/** Facts-service options, injectable for tests: registries default to the repository-resident ones. */
export interface ReconciliationFactsOptions {
  readonly sourceMappers?: ReadonlyMap<string, SourceMapper>;
  readonly nativeRules?: NativeRuleRegistry;
}

/** DI token for {@link ReconciliationFactsOptions}; absent → repository-resident registries. */
export const RECONCILIATION_FACTS_OPTIONS = Symbol('RECONCILIATION_FACTS_OPTIONS');

/** Opaque identity key `(source_platform, source_id)`; US (0x1F) cannot occur in a canonical platform token. */
export function identityKey(sourcePlatform: string, sourceId: string): string {
  return `${sourcePlatform}\u001f${sourceId}`;
}

/** D-S8-2 interim: the client-owned family list (S8-DOC L72-74). */
const CLIENT_OWNED_FAMILIES: ReadonlySet<string> = new Set([RECONSTRUCT_FAMILY.client_history]);
/** `clients` carries `roster_bridge_pending` until S8-D (S8-DOC L372-374). */
const FAMILY_QUALIFIERS: Readonly<Record<string, readonly FamilyQualifier[]>> = {
  [RECONSTRUCT_FAMILY.clients]: ['roster_bridge_pending'],
};
/** Upper bound of ids per `IN (...)` native lookup; keeps every query bounded without a per-row read. */
const LOOKUP_CHUNK = 1000;
/** `#ord:<n>` child identity form (S8-DOC L174-181; C-5 notation). */
const ORD_SUFFIX = /#ord:(0|[1-9][0-9]*)$/;

interface StagedRow {
  readonly entity_type: string;
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
}
interface LedgerRow {
  readonly entity_type: string;
  readonly source_id: string;
  readonly source_platform: string;
  readonly status: string;
  readonly target_id: string | null;
  readonly target_kind: string | null;
  readonly reason: string | null;
}
interface ProvenanceRow {
  readonly source_namespace: string;
  readonly entity_type: string;
  readonly source_id: string;
  readonly native_kind: string;
  readonly native_id: string | null;
  readonly outcome: string;
  readonly reason: string | null;
}
interface NativeRow {
  readonly id: string;
  readonly coach_id: string;
  readonly archived_at: Date | null;
}
interface PlanRow extends NativeRow {
  readonly program_id: string | null;
  readonly week_index: number | null;
  readonly day_index: number | null;
}
interface ExerciseRow {
  readonly id: string;
  readonly workout_plan_id: string;
  readonly order: number;
  readonly archived_at: Date | null;
}

/** One grouped staged identity before its ledger/provenance/native facts are attached. */
interface Grouped {
  readonly row: StagedRow;
  readonly identity: string;
  readonly mapped: boolean;
  /** Canonical family when mapped, raw token otherwise. */
  readonly family: string;
  readonly resolutionReason: string | null;
  readonly mapper: SourceMapper | null;
}

/** Mutable accumulator for one `(mapped, family)` entry. */
interface EntryAcc {
  readonly family: string;
  readonly mapped: boolean;
  resolutionReasons: Set<string>;
  readonly members: Grouped[];
  ledgerWithoutStaged: number;
}

const ledgerKey = (entityType: string, platform: string, sourceId: string) =>
  `${entityType}\u001f${platform}\u001f${sourceId}`;
const provenanceKey = (namespace: string, entityType: string, sourceId: string) =>
  `${namespace}\u001f${entityType}\u001f${sourceId}`;

function isNativeTargetKind(value: string | null): value is NativeTargetKind {
  return value !== null && (NATIVE_TARGET_KINDS as readonly string[]).includes(value);
}
function isLedgerTargetKind(value: string | null): value is LedgerTargetKind {
  return value !== null && (Object.values(LEDGER_TARGET_KIND) as readonly string[]).includes(value);
}
function isProvenanceOutcome(value: string): value is ProvenanceOutcome {
  return (Object.values(PROVENANCE_OUTCOME) as readonly string[]).includes(value);
}
function isLegacyTerminal(value: string | null | undefined): value is ScoutTerminalStatus {
  return value != null && (SCOUT_TERMINAL_STATUSES as readonly string[]).includes(value);
}

/** Parse `<len>:<parent>#...` back to the parent source id, or null when the shape is foreign. */
export function parentSourceIdOf(childSourceId: string): string | null {
  const colon = childSourceId.indexOf(':');
  if (colon <= 0) return null;
  const lengthText = childSourceId.slice(0, colon);
  if (!/^(0|[1-9][0-9]*)$/.test(lengthText)) return null;
  const length = Number(lengthText);
  const parent = childSourceId.slice(colon + 1, colon + 1 + length);
  if (parent.length !== length) return null;
  if (childSourceId.charAt(colon + 1 + length) !== '#') return null;
  return parent;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The accepted S8-C workouts reconstructor; only its read-only `map` is used here. */
type WorkoutInterpreter = ReturnType<typeof buildNativeFamilies>['workouts'];

@Injectable()
export class ReconciliationFactsService {
  private readonly sourceMappers: ReadonlyMap<string, SourceMapper>;
  private readonly workoutInterpreter: WorkoutInterpreter;

  constructor(
    @Optional() @Inject(RECONCILIATION_FACTS_OPTIONS) options: ReconciliationFactsOptions = {},
  ) {
    this.sourceMappers = options.sourceMappers ?? buildSourceMapperRegistry();
    const nativeRules: NativeRuleRegistry = options.nativeRules ?? buildNativeRuleRegistry();
    // The accepted S8-C dispatch + S8-A/S8-C interpreters; only `map` is ever called (read-only).
    this.workoutInterpreter = buildNativeFamilies({
      sourceMappers: this.sourceMappers,
      nativeRules,
    }).workouts;
  }

  /** Collect the facts for one run. Reads only; safe inside the caller's transaction. */
  async collect(db: FactsDb, coachId: string, intentId: string): Promise<ReconciliationFacts> {
    const [claim, staged, ledger] = await Promise.all([
      this.readClaim(db, coachId, intentId),
      this.readStaged(db, coachId, intentId),
      this.readLedger(db, coachId, intentId),
    ]);

    // ── 1. Group staged rows into (mapped, family) entries ───────────────────────────────────
    const entries = new Map<string, EntryAcc>();
    const entryKey = (mapped: boolean, family: string) => `${mapped ? 'm' : 'u'}\u001f${family}`;
    const entryFor = (mapped: boolean, family: string): EntryAcc => {
      const key = entryKey(mapped, family);
      let acc = entries.get(key);
      if (acc === undefined) {
        acc = { family, mapped, resolutionReasons: new Set(), members: [], ledgerWithoutStaged: 0 };
        entries.set(key, acc);
      }
      return acc;
    };
    const platforms = new Set<string>();
    const tokenCounts = new Map<string, number>();
    for (const row of staged) {
      platforms.add(row.source_platform);
      tokenCounts.set(row.entity_type, (tokenCounts.get(row.entity_type) ?? 0) + 1);
      const grouped = this.group(row);
      const acc = entryFor(grouped.mapped, grouped.family);
      if (grouped.resolutionReason !== null) acc.resolutionReasons.add(grouped.resolutionReason);
      acc.members.push(grouped);
    }

    // ── 2. Join the ledger on the wide identity; count/attribute orphans ─────────────────────
    const ledgerByKey = new Map<string, LedgerRow>();
    for (const row of ledger)
      ledgerByKey.set(ledgerKey(row.entity_type, row.source_platform, row.source_id), row);
    const stagedKeys = new Set(
      staged.map((r) => ledgerKey(r.entity_type, r.source_platform, r.source_id)),
    );
    let ledgerWithoutStaged = 0;
    for (const row of ledger) {
      if (stagedKeys.has(ledgerKey(row.entity_type, row.source_platform, row.source_id))) continue;
      ledgerWithoutStaged += 1;
      // Attributed to a family entry where the ledger row's own (platform, token) resolves.
      const resolved = this.resolveFamily(row.source_platform, row.entity_type);
      if (resolved !== null) entryFor(true, resolved).ledgerWithoutStaged += 1;
    }

    // ── 3. Provenance for the mapped families (+ children), coach-scoped, in memory join ─────
    const mappedFamilies = Array.from(entries.values())
      .filter((e) => e.mapped)
      .map((e) => e.family);
    const provenance =
      mappedFamilies.length === 0
        ? []
        : await this.readProvenance(db, coachId, Array.from(platforms), mappedFamilies);
    const provenanceByKey = new Map<string, ProvenanceRow>();
    const childrenByParent = new Map<string, ProvenanceRow[]>();
    for (const row of provenance) {
      if (row.entity_type === CHILD_ENTITY_TYPE.workouts_exercise) {
        const parent = parentSourceIdOf(row.source_id);
        if (parent === null) continue;
        const key = provenanceKey(row.source_namespace, RECONSTRUCT_FAMILY.workouts, parent);
        const list = childrenByParent.get(key);
        if (list === undefined) childrenByParent.set(key, [row]);
        else list.push(row);
        continue;
      }
      provenanceByKey.set(provenanceKey(row.source_namespace, row.entity_type, row.source_id), row);
    }

    // ── 4. Native target lookups by id, one bounded IN-query set per kind ────────────────────
    const wanted: Record<NativeTargetKind, Set<string>> = {
      person: new Set(),
      workout_program: new Set(),
      workout_plan: new Set(),
    };
    const childIds = new Set<string>();
    const memberProvenance = new Map<Grouped, ProvenanceRow | null>();
    for (const acc of entries.values()) {
      if (!acc.mapped) continue;
      for (const member of acc.members) {
        const prov =
          provenanceByKey.get(
            provenanceKey(member.row.source_platform, acc.family, member.row.source_id),
          ) ?? null;
        memberProvenance.set(member, prov);
        const led = ledgerByKey.get(
          ledgerKey(member.row.entity_type, member.row.source_platform, member.row.source_id),
        );
        if (
          prov !== null &&
          prov.native_id !== null &&
          isNativeTargetKind(prov.native_kind) &&
          led !== undefined &&
          led.target_kind === prov.native_kind &&
          led.target_id === prov.native_id
        ) {
          wanted[prov.native_kind].add(prov.native_id);
        }
        if (acc.family === RECONSTRUCT_FAMILY.workouts) {
          for (const child of childrenByParent.get(
            provenanceKey(member.row.source_platform, acc.family, member.row.source_id),
          ) ?? []) {
            if (
              child.outcome !== PROVENANCE_OUTCOME.unresolved &&
              child.native_kind === NATIVE_KIND.workout_plan_exercise &&
              child.native_id !== null
            )
              childIds.add(child.native_id);
          }
        }
      }
    }
    const [persons, programs, plans, exercises] = await Promise.all([
      this.readPersons(db, Array.from(wanted.person)),
      this.readPrograms(db, Array.from(wanted.workout_program)),
      this.readPlans(db, Array.from(wanted.workout_plan)),
      this.readExercises(db, Array.from(childIds)),
    ]);
    const native: Record<NativeTargetKind, ReadonlyMap<string, NativeRow>> = {
      person: persons,
      workout_program: programs,
      workout_plan: plans,
    };

    // ── 5. Per-identity facts and relationship edges ─────────────────────────────────────────
    const families: FamilyFacts[] = [];
    const relationships: RelationshipFacts[] = [];
    // Verified native id of a `programs` identity (for the E-R1 comparison), keyed by identity.
    const programNativeId = new Map<string, string>();
    for (const acc of entries.values()) {
      if (!acc.mapped || acc.family !== RECONSTRUCT_FAMILY.programs) continue;
      for (const member of acc.members) {
        const prov = memberProvenance.get(member) ?? null;
        if (
          prov !== null &&
          prov.native_id !== null &&
          prov.outcome !== PROVENANCE_OUTCOME.unresolved &&
          prov.native_kind === NATIVE_KIND.workout_program &&
          this.checkNative(coachId, 'workout_program', prov.native_id, native) === 'present_owned'
        )
          programNativeId.set(member.identity, prov.native_id);
      }
    }

    const sortedEntries = Array.from(entries.values()).sort(
      (a, b) => byString(a.family, b.family) || Number(b.mapped) - Number(a.mapped),
    );
    for (const acc of sortedEntries) {
      const identities: IdentityFacts[] = [];
      for (const member of acc.members) {
        const led =
          ledgerByKey.get(
            ledgerKey(member.row.entity_type, member.row.source_platform, member.row.source_id),
          ) ?? null;
        const prov = acc.mapped ? (memberProvenance.get(member) ?? null) : null;
        const children = acc.mapped
          ? (childrenByParent.get(
              provenanceKey(member.row.source_platform, acc.family, member.row.source_id),
            ) ?? [])
          : [];
        const clientSourceId = acc.mapped ? this.clientSourceId(member, acc.family) : null;
        identities.push({
          token: member.row.entity_type,
          identity: member.identity,
          ledger: this.ledgerFacts(coachId, led, prov, children, native),
          client_linked: clientSourceId !== null,
        });
        if (!acc.mapped) continue;
        // E-R3: one edge per declared client link (soft link, never compared → null).
        if (clientSourceId !== null) {
          relationships.push({
            edge: 'client_link',
            from_family: acc.family,
            from_identity: member.identity,
            to_family: RECONSTRUCT_FAMILY.clients,
            to_identity: identityKey(member.row.source_platform, clientSourceId),
            consistent: null,
          });
        }
        if (acc.family === RECONSTRUCT_FAMILY.workouts) {
          this.workoutEdges(
            coachId,
            member,
            led,
            prov,
            children,
            plans,
            exercises,
            programNativeId,
            relationships,
          );
        }
      }
      const reasons = Array.from(acc.resolutionReasons).sort(byString);
      families.push({
        family: acc.family,
        mapped: acc.mapped,
        // One token may fail for two reasons across platforms; `unresolved_family` (unresolved)
        // is reported ahead of `unsupported_platform` (rejected): the conservative direction.
        resolution_reason: acc.mapped
          ? null
          : (reasons.find((r) => r.startsWith('unresolved_family:')) ?? reasons[0] ?? null),
        client_owned: acc.mapped && CLIENT_OWNED_FAMILIES.has(acc.family),
        // Per-`entity_type` pass ceiling: the engine counts rows with `entity_type == family`.
        ceiling_exceeded: acc.mapped && (tokenCounts.get(acc.family) ?? 0) > RECONSTRUCT_MAX_ROWS,
        identities,
        ledger_without_staged: acc.ledgerWithoutStaged,
        qualifiers: acc.mapped ? (FAMILY_QUALIFIERS[acc.family] ?? []) : [],
      });
    }

    // ── 6. Declared families of every staged platform (D-S9-2 required families) ─────────────
    let specFamilies: string[] | null = null;
    if (staged.length > 0) {
      const union = new Set<string>();
      let known = true;
      for (const platform of platforms) {
        const mapper = this.sourceMappers.get(platform);
        if (mapper === undefined) {
          known = false;
          break;
        }
        for (const family of Object.keys(mapper.spec.families)) union.add(family);
      }
      specFamilies = known ? Array.from(union).sort(byString) : null;
    }

    return {
      claim,
      families,
      relationships,
      spec_families: specFamilies,
      ledger_without_staged: ledgerWithoutStaged,
      coverage: null, // D-S9-3: no coverage contract exists in v1; unknown, never 0.
    };
  }

  // ── Grouping / interpretation ──────────────────────────────────────────────────────────────

  /** Canonical family for `(platform, token)` under the accepted dispatch, or null. */
  private resolveFamily(platform: string, token: string): string | null {
    const step = resolveStagedFamily(this.sourceMappers, platform, token);
    if (step.ok) return step.family;
    const mapper = this.sourceMappers.get(platform);
    // Accepted convention: the token IS the canonical family the spec declares.
    if (mapper !== undefined && Object.prototype.hasOwnProperty.call(mapper.spec.families, token))
      return token;
    return null;
  }

  private group(row: StagedRow): Grouped {
    const identity = identityKey(row.source_platform, row.source_id);
    const mapper = this.sourceMappers.get(row.source_platform) ?? null;
    const family = this.resolveFamily(row.source_platform, row.entity_type);
    if (family !== null) {
      return { row, identity, mapped: true, family, resolutionReason: null, mapper };
    }
    const step = resolveStagedFamily(this.sourceMappers, row.source_platform, row.entity_type);
    return {
      row,
      identity,
      mapped: false,
      family: row.entity_type,
      resolutionReason: step.ok ? null : step.reason,
      mapper,
    };
  }

  /** The S8-A interpreter's client link for a mapped identity (S8-DOC L320-323), or null. */
  private clientSourceId(member: Grouped, family: string): string | null {
    if (member.mapper === null || family === RECONSTRUCT_FAMILY.clients) return null;
    const result = interpretEntity(member.mapper.spec, family, member.row);
    return result.ok ? result.entity.clientSourceId : null;
  }

  // ── Ledger / provenance / native facts ─────────────────────────────────────────────────────

  private ledgerFacts(
    coachId: string,
    led: LedgerRow | null,
    prov: ProvenanceRow | null,
    children: readonly ProvenanceRow[],
    native: Record<NativeTargetKind, ReadonlyMap<string, NativeRow>>,
  ): LedgerRowFacts | null {
    if (led === null) return null;
    switch (led.status) {
      case 'failed':
        return { status: 'failed' };
      case 'skipped':
        return { status: 'skipped', reason: led.reason };
      case 'reconstructed':
        return {
          status: 'reconstructed',
          target_kind: isLedgerTargetKind(led.target_kind) ? led.target_kind : null,
          provenance:
            prov === null ? null : this.provenanceFacts(coachId, led, prov, children, native),
        };
      default: {
        // Out-of-type status: surfaced as-is so S9-A's catch-all (k) sees it, never re-labelled.
        // `LedgerRowFacts` is a closed union; the single typed assertion widens `status` only.
        const passthrough: { status: string } = { status: led.status };
        return passthrough as LedgerRowFacts;
      }
    }
  }

  private provenanceFacts(
    coachId: string,
    led: LedgerRow,
    prov: ProvenanceRow,
    children: readonly ProvenanceRow[],
    native: Record<NativeTargetKind, ReadonlyMap<string, NativeRow>>,
  ): ProvenanceFacts {
    const unresolvedChildren: Record<string, number> = {};
    for (const child of children) {
      if (child.outcome !== PROVENANCE_OUTCOME.unresolved) continue;
      if (child.native_kind !== NATIVE_KIND.workout_plan_exercise) continue;
      const code = child.reason ?? 'unresolved:reason_unrecognised';
      unresolvedChildren[code] = (unresolvedChildren[code] ?? 0) + 1;
    }
    let check: NativeTargetCheck;
    if (!isNativeTargetKind(prov.native_kind) || prov.native_kind !== led.target_kind) {
      check = 'kind_mismatch';
    } else if (prov.native_id === null || prov.native_id !== led.target_id) {
      check = 'provenance_mismatch';
    } else {
      check = this.checkNative(coachId, prov.native_kind, prov.native_id, native);
    }
    return {
      outcome: isProvenanceOutcome(prov.outcome) ? prov.outcome : 'unresolved',
      native: check,
      reason: prov.reason,
      unresolved_children: unresolvedChildren,
    };
  }

  /** S8-C `verifyTarget` rule: missing/archived → removed; other coach → foreign_owner. */
  private checkNative(
    coachId: string,
    kind: NativeTargetKind,
    nativeId: string,
    native: Record<NativeTargetKind, ReadonlyMap<string, NativeRow>>,
  ): NativeTargetCheck {
    const row = native[kind].get(nativeId);
    if (row === undefined || row.archived_at !== null) return 'removed';
    if (row.coach_id !== coachId) return 'foreign_owner';
    return 'present_owned';
  }

  // ── Relationship edges for a `workouts` identity (E-R1, E-R2) ─────────────────────────────

  private workoutEdges(
    coachId: string,
    member: Grouped,
    led: LedgerRow | null,
    prov: ProvenanceRow | null,
    children: readonly ProvenanceRow[],
    plans: ReadonlyMap<string, PlanRow>,
    exercises: ReadonlyMap<string, ExerciseRow>,
    programNativeId: ReadonlyMap<string, string>,
    out: RelationshipFacts[],
  ): void {
    // The verified native plan of this identity, if the ledger + provenance agree and it is ours.
    const planId =
      prov !== null &&
      prov.native_id !== null &&
      prov.outcome !== PROVENANCE_OUTCOME.unresolved &&
      prov.native_kind === NATIVE_KIND.workout_plan &&
      led !== null &&
      led.target_kind === LEDGER_TARGET_KIND.workout_plan &&
      led.target_id === prov.native_id
        ? prov.native_id
        : null;
    const plan = planId === null ? undefined : plans.get(planId);
    const ownPlan =
      plan !== undefined && plan.coach_id === coachId && plan.archived_at === null ? plan : null;

    // E-R1: declared iff the accepted interpreter derives a parent program for this row.
    const derived = this.deriveTemplate(member);
    if (derived !== null && derived.programSourceId !== null) {
      const parentIdentity = identityKey(member.row.source_platform, derived.programSourceId);
      const parentNative = programNativeId.get(parentIdentity) ?? null;
      const consistent =
        ownPlan !== null &&
        parentNative !== null &&
        ownPlan.program_id === parentNative &&
        ownPlan.week_index === derived.weekIndex &&
        ownPlan.day_index === derived.dayIndex;
      out.push({
        edge: 'program_parent',
        from_family: RECONSTRUCT_FAMILY.workouts,
        from_identity: member.identity,
        to_family: RECONSTRUCT_FAMILY.programs,
        to_identity: parentIdentity,
        consistent,
      });
    }

    // E-R2: one edge per created child; target is the parent plan identity itself.
    for (const child of children) {
      if (child.outcome === PROVENANCE_OUTCOME.unresolved) continue;
      if (child.native_kind !== NATIVE_KIND.workout_plan_exercise || child.native_id === null)
        continue;
      const exercise = exercises.get(child.native_id);
      const ord = ORD_SUFFIX.exec(child.source_id);
      const consistent =
        ownPlan !== null &&
        exercise !== undefined &&
        exercise.archived_at === null &&
        exercise.workout_plan_id === ownPlan.id &&
        (ord === null || exercise.order === Number(ord[1]));
      out.push({
        edge: 'child_order',
        from_family: RECONSTRUCT_FAMILY.workouts,
        from_identity: member.identity,
        to_family: RECONSTRUCT_FAMILY.workouts,
        to_identity: member.identity,
        consistent,
      });
    }
  }

  /** Accepted S8-C interpretation of a staged workouts row; null unless it is a native template. */
  private deriveTemplate(
    member: Grouped,
  ): { programSourceId: string | null; weekIndex: number | null; dayIndex: number | null } | null {
    let mapped: ReturnType<WorkoutInterpreter['map']>;
    try {
      mapped = this.workoutInterpreter.map({
        source_id: member.row.source_id,
        source_platform: member.row.source_platform,
        payload: member.row.payload,
        entity_type: member.row.entity_type,
      });
    } catch {
      return null; // A throwing interpreter declares nothing; the ledger already says `failed`.
    }
    if (!mapped.ok) return null;
    const value = mapped.mapped;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('mode' in value) ||
      value.mode !== 'native'
    )
      return null;
    return {
      programSourceId: value.template.programSourceId,
      weekIndex: value.template.weekIndex,
      dayIndex: value.template.dayIndex,
    };
  }

  // ── Reads (all tenant-scoped; native lookups follow the S8-C verifyTarget precedent) ──────

  private async readClaim(db: FactsDb, coachId: string, intentId: string): Promise<ClaimStatus> {
    const completion = await db.scoutImportCompletion.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: { terminal_status: true },
    });
    const claim = completion?.terminal_status ?? null;
    return isLegacyTerminal(claim) ? claim : null;
  }

  private async readStaged(db: FactsDb, coachId: string, intentId: string): Promise<StagedRow[]> {
    const out: StagedRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await db.scoutIngestEntity.findMany({
        where: { coach_id: coachId, intent_id: intentId },
        orderBy: { id: 'asc' },
        take: RECONSTRUCT_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          entity_type: true,
          source_id: true,
          source_platform: true,
          payload: true,
        },
      });
      for (const row of page) out.push(row);
      if (page.length < RECONSTRUCT_PAGE_SIZE) return out;
      cursor = page[page.length - 1].id;
    }
  }

  private async readLedger(db: FactsDb, coachId: string, intentId: string): Promise<LedgerRow[]> {
    const out: LedgerRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await db.scoutReconstructionLedger.findMany({
        where: { coach_id: coachId, intent_id: intentId },
        orderBy: { id: 'asc' },
        take: RECONSTRUCT_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          entity_type: true,
          source_id: true,
          source_platform: true,
          status: true,
          target_id: true,
          target_kind: true,
          reason: true,
        },
      });
      for (const row of page) out.push(row);
      if (page.length < RECONSTRUCT_PAGE_SIZE) return out;
      cursor = page[page.length - 1].id;
    }
  }

  /** Provenance is intent-less at S8-C (`import_intent_id` NULL): coach + namespaces + families. */
  private async readProvenance(
    db: FactsDb,
    coachId: string,
    platforms: readonly string[],
    families: readonly string[],
  ): Promise<ProvenanceRow[]> {
    return db.importNativeProvenance.findMany({
      where: {
        coach_id: coachId,
        source_namespace: { in: [...platforms] },
        entity_type: { in: [...families, CHILD_ENTITY_TYPE.workouts_exercise] },
      },
      select: {
        source_namespace: true,
        entity_type: true,
        source_id: true,
        native_kind: true,
        native_id: true,
        outcome: true,
        reason: true,
      },
    });
  }

  private async readPersons(db: FactsDb, ids: readonly string[]): Promise<Map<string, NativeRow>> {
    const out = new Map<string, NativeRow>();
    for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
      const rows = await db.person.findMany({
        where: { id: { in: chunk } },
        select: { id: true, coach_id: true },
      });
      // Person has no `archived_at` (D-S9-2 bucket i: "where the model has one").
      for (const row of rows)
        out.set(row.id, { id: row.id, coach_id: row.coach_id, archived_at: null });
    }
    return out;
  }

  private async readPrograms(db: FactsDb, ids: readonly string[]): Promise<Map<string, NativeRow>> {
    const out = new Map<string, NativeRow>();
    for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
      const rows = await db.workoutProgram.findMany({
        where: { id: { in: chunk } },
        select: { id: true, coach_id: true, archived_at: true },
      });
      for (const row of rows) out.set(row.id, row);
    }
    return out;
  }

  private async readPlans(db: FactsDb, ids: readonly string[]): Promise<Map<string, PlanRow>> {
    const out = new Map<string, PlanRow>();
    for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
      const rows = await db.workoutPlan.findMany({
        where: { id: { in: chunk } },
        select: {
          id: true,
          coach_id: true,
          archived_at: true,
          program_id: true,
          week_index: true,
          day_index: true,
        },
      });
      for (const row of rows) out.set(row.id, row);
    }
    return out;
  }

  private async readExercises(
    db: FactsDb,
    ids: readonly string[],
  ): Promise<Map<string, ExerciseRow>> {
    const out = new Map<string, ExerciseRow>();
    for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
      const rows = await db.workoutPlanExercise.findMany({
        where: { id: { in: chunk } },
        select: { id: true, workout_plan_id: true, order: true, archived_at: true },
      });
      for (const row of rows) out.set(row.id, row);
    }
    return out;
  }
}
