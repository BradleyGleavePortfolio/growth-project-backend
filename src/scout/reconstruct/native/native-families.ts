import type { Prisma } from '@prisma/client';
import { RECONSTRUCT_FAMILY } from '../../scout-reconstruct.dto';
import type { MappedEntity } from '../mapping-spec';
import { resolveStagedFamily, type SourceMapper } from '../source-mapper-registry';
import { NATIVE_FAMILY } from './native-contract';
import type { NativeRuleRegistry } from './native-rule-registry';
import {
  interpretProgram,
  interpretWorkout,
  type MappedProgram,
  type MappedWorkoutTemplate,
} from './native-rules';
import { persistEvidence, persistProgram, persistWorkoutTemplate } from './native-writers';
import type { PersistOutcome } from './persist-outcome';

/**
 * The two S8-C native families as ordinary `FamilyReconstructor` map/persist
 * pairs (contract §4.1): no new pipeline, no source-specific core code. Both
 * pass the row's step token through the accepted `resolveStep` dispatch so the
 * A3 guard (unsupported platform / unresolved family) applies before any typed
 * interpretation, then the S8-A data-only mapper supplies label and client link
 * and the data-only native rules (per source, `./sources/<platform>.json`)
 * supply the typed native fields. What the row does next is decided ONLY by the
 * declared rules and the payload — never by the platform name.
 *
 * The staged row structurally matches ../families StagedRow plus the optional
 * `entity_type` the engine may forward (C2 carry-forward: today the engine
 * selects rows by `entity_type == family`, so the token equals the family and
 * the fallback is exact).
 */
export interface NativeStagedRow {
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
  readonly entity_type?: string;
}

export type NativeMapResult<M> =
  { readonly ok: true; readonly mapped: M } | { readonly ok: false; readonly reason: string };

export interface NativeFamilyReconstructor<M> {
  readonly entityType: string;
  map(row: NativeStagedRow): NativeMapResult<M>;
  persist(
    tx: Prisma.TransactionClient,
    coachId: string,
    sourceId: string,
    mapped: M,
  ): Promise<PersistOutcome>;
}

export interface NativeFamilyOptions {
  readonly sourceMappers: ReadonlyMap<string, SourceMapper>;
  readonly nativeRules: NativeRuleRegistry;
}

/**
 * A workouts row is either brought across natively or kept as the accepted
 * evidence row. When the source declares NO native workout rules the mapped
 * value is the bare accepted {@link MappedEntity} — byte-for-byte the legacy
 * family result, so accepted mapper equivalence holds unchanged. Only a source
 * that declares native rules ever sees a `mode`-tagged disposition.
 */
export type WorkoutDisposition =
  | MappedEntity
  | { readonly mode: 'native'; readonly template: MappedWorkoutTemplate }
  | {
      readonly mode: 'evidence';
      readonly entity: MappedEntity;
      readonly recordNoNativePrincipal: true;
    };

/** Discriminates a native-rules disposition from the legacy bare entity. */
function isTagged(mapped: WorkoutDisposition): mapped is Exclude<WorkoutDisposition, MappedEntity> {
  return 'mode' in mapped;
}

/**
 * Shared prelude: platform registered, step token resolves to THIS family
 * through the accepted dispatch, S8-A entity mapping succeeds.
 *
 * Token rule (accepted staging convention, C2 carry-forward): the engine selects
 * rows by `entity_type == family`, and accepted fixtures stage the CANONICAL
 * family name (e.g. a source's routines step is staged as `workouts` while the
 * spec's step key is `routines`). So a token that `resolveStep` maps to
 * ANOTHER family is refused (`unresolved_family:<token>` — e.g. a source that
 * declares `programs` as a step of its workouts family), a token that resolves to
 * this family passes, and a token equal to the family name itself passes to the
 * mapper, which fails closed with the same reason when the spec does not declare
 * the family. Nothing here is source-specific.
 */
function dispatch(
  options: NativeFamilyOptions,
  family: string,
  row: NativeStagedRow,
):
  | { readonly ok: true; readonly entity: MappedEntity; readonly mapper: SourceMapper }
  | { readonly ok: false; readonly reason: string } {
  const mapper = options.sourceMappers.get(row.source_platform);
  if (mapper === undefined)
    return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
  const token = row.entity_type ?? family;
  const step = resolveStagedFamily(options.sourceMappers, row.source_platform, token);
  if (step.ok ? step.family !== family : token !== family) {
    return { ok: false, reason: `unresolved_family:${token}` };
  }
  const result = mapper.mapEntity(family, row);
  if (!result.ok) return result;
  return { ok: true, entity: result.entity, mapper };
}

export function buildNativeFamilies(options: NativeFamilyOptions): {
  readonly programs: NativeFamilyReconstructor<MappedProgram>;
  readonly workouts: NativeFamilyReconstructor<WorkoutDisposition>;
} {
  const programs: NativeFamilyReconstructor<MappedProgram> = {
    entityType: RECONSTRUCT_FAMILY.programs,
    map(row) {
      const prelude = dispatch(options, NATIVE_FAMILY.programs, row);
      if (!prelude.ok) return prelude;
      const rules = options.nativeRules.get(row.source_platform)?.families.programs;
      const interpreted = interpretProgram(rules, {
        sourcePlatform: row.source_platform,
        label: prelude.entity.label,
        clientSourceId: prelude.entity.clientSourceId,
        payload: row.payload,
        sourceId: row.source_id,
      });
      return interpreted.ok ? { ok: true, mapped: interpreted.mapped } : interpreted;
    },
    persist(tx, coachId, sourceId, mapped) {
      return persistProgram(
        tx,
        coachId,
        { source_platform: mapped.sourcePlatform, source_id: sourceId },
        mapped,
      );
    },
  };

  const workouts: NativeFamilyReconstructor<WorkoutDisposition> = {
    entityType: RECONSTRUCT_FAMILY.workouts,
    map(row) {
      const prelude = dispatch(options, NATIVE_FAMILY.workouts, row);
      if (!prelude.ok) return prelude;
      const rules = options.nativeRules.get(row.source_platform)?.families.workouts;
      if (rules === undefined) {
        // No native rules declared for this source: exactly the accepted
        // evidence path, returning the accepted mapped value itself.
        return { ok: true, mapped: prelude.entity };
      }
      if (prelude.entity.clientSourceId !== null) {
        // §3.8: client-owned history has no native principal (no User is ever
        // created); the evidence row continues and the native outcome is an
        // explicit unresolved provenance row.
        return {
          ok: true,
          mapped: { mode: 'evidence', entity: prelude.entity, recordNoNativePrincipal: true },
        };
      }
      const interpreted = interpretWorkout(rules, {
        sourcePlatform: row.source_platform,
        label: prelude.entity.label,
        clientSourceId: prelude.entity.clientSourceId,
        payload: row.payload,
        sourceId: row.source_id,
      });
      return interpreted.ok
        ? { ok: true, mapped: { mode: 'native', template: interpreted.mapped } }
        : interpreted;
    },
    persist(tx, coachId, sourceId, mapped) {
      if (!isTagged(mapped)) {
        return persistEvidence(
          tx,
          coachId,
          { source_platform: mapped.sourcePlatform, source_id: sourceId },
          mapped,
          { recordNoNativePrincipal: false },
        );
      }
      if (mapped.mode === 'evidence') {
        return persistEvidence(
          tx,
          coachId,
          { source_platform: mapped.entity.sourcePlatform, source_id: sourceId },
          mapped.entity,
          { recordNoNativePrincipal: true },
        );
      }
      return persistWorkoutTemplate(
        tx,
        coachId,
        { source_platform: mapped.template.sourcePlatform, source_id: sourceId },
        mapped.template,
      );
    },
  };

  return { programs, workouts };
}
