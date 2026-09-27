/**
 * G2-S9-B live-proof observations layered on the S9-only derivative
 * (test/utils/g2-s9-pg-harness.ts) of the accepted S8-C harness. Adds only what S9-B needs:
 * synthetic fixture rows (User; ScoutImport settled; ScoutIngestEntity staged programs/workouts;
 * ExerciseCatalogItem rows the exact-identifier link may resolve against), the explicit fixture
 * source-mapping spec + native rule set the worker injects (platform `s9-proof`, plus a second
 * registered platform `s9-proof-b` with a workouts-only spec and no native rules), the legacy
 * `/complete` claim writer (`ScoutImportCompletion`), direct ledger/provenance fixture writers
 * for the contradiction cases (orphan ledger rows, repointed provenance), and row snapshots of
 * the native targets, provenance and ledger. No production reader or writer is emulated here:
 * the facts run as the real ReconciliationFactsService and the rows are produced by the real
 * ScoutReconstructService, both in test/utils/g2-s9-worker.cjs. Imported only by the explicitly
 * guarded test/rls-g2-s9.spec.ts.
 */
import { json, quote, sql } from './g2-s9-pg-harness';

export const PROVENANCE = 'ImportNativeProvenance';
export const LEDGER = 'ScoutReconstructionLedger';
export const COMPLETION = 'ScoutImportCompletion';
/** Fixture platform: canonical, synthetic, registered only through the injected spec. */
export const PLATFORM = 's9-proof';
/** Second registered fixture platform: spec only (`workouts`), no native rules. */
export const PLATFORM_B = 's9-proof-b';

/** Fixture S8-A spec: `blocks` is the programs step, `routines` the workouts step. */
export const SPEC = {
  specVersion: 1,
  sourcePlatform: PLATFORM,
  steps: { people: 'clients', blocks: 'programs', routines: 'workouts', log: 'client_history' },
  families: {
    clients: { displayName: { paths: [['name']], coerce: 'string' } },
    programs: {
      clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
      label: { paths: [['title']], coerce: 'string' },
    },
    workouts: {
      clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
      label: { paths: [['title']], coerce: 'string' },
    },
    client_history: {
      clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
      label: { paths: [['title']], coerce: 'string' },
    },
  },
};
/** Fixture S8-C native rules for the same platform. */
export const RULES = {
  specVersion: 1,
  sourcePlatform: PLATFORM,
  families: {
    programs: {
      description: { kind: 'text', paths: [['notes']] },
      weeks: { kind: 'integer', paths: [['weeks']] },
      daysPerWeek: { kind: 'integer', paths: [['days']] },
    },
    workouts: {
      type: {
        kind: 'enum',
        paths: [['kind']],
        map: { lift: 'strength', run: 'cardio' },
        default: 'strength',
      },
      durationEstimateMinutes: { kind: 'duration', paths: [['minutes']], unit: 'minutes' },
      programSourceId: { kind: 'identifier', paths: [['block_id']] },
      weekIndex: { kind: 'integer', paths: [['week']], base: 1 },
      dayIndex: { kind: 'integer', paths: [['day']], base: 1 },
      exercises: {
        paths: [['exercises']],
        item: {
          id: { kind: 'identifier', paths: [['id']] },
          exerciseRef: { kind: 'identifier', paths: [['exercise']] },
          sets: { kind: 'integer', paths: [['sets']] },
          reps: { kind: 'integer', paths: [['reps']] },
          weight: { kind: 'weight', paths: [['kg']], unit: 'kg' },
          restSeconds: { kind: 'duration', paths: [['rest']], unit: 'seconds' },
          groupKey: { kind: 'identifier', paths: [['superset']] },
          notes: { kind: 'text', paths: [['cue']] },
        },
      },
    },
  },
};
/** A second registered platform: `workouts` only, no `programs`, no native rules. */
export const SPEC_B = {
  specVersion: 1,
  sourcePlatform: PLATFORM_B,
  steps: { workouts: 'workouts' },
  families: {
    workouts: {
      clientSourceId: { paths: [['client_id']], coerce: 'string' },
      label: { paths: [['title']], coerce: 'string' },
    },
  },
};
/** Worker options that inject the fixture registry (spread into every `run`). */
export const REGISTRY = { spec: SPEC, rules: RULES };
/** Both registered platforms (facts mode: `spec_families` is their declared union). */
export const REGISTRY_AB = { spec: [SPEC, SPEC_B], rules: RULES };

/** Contract §3.3 child identity: `<n>:<parent>#id:<child>` or `<n>:<parent>#ord:<ordinal>`. */
export const childSourceId = (parent: string, child: { id: string } | { ordinal: number }) =>
  `${parent.length}:${parent}#${'id' in child ? `id:${child.id}` : `ord:${child.ordinal}`}`;

/** Synthetic owner row (User is the FK target of ImportIntent/WorkoutPlan/WorkoutProgram coach_id). */
export function ensureUser(coach: string) {
  sql(`INSERT INTO "User" (id,supabase_id,email,name,role)
    VALUES (${quote(coach)},${quote(`sb-${coach}`)},${quote(`${coach}@synthetic.invalid`)},${quote(`Synthetic ${coach}`)},'coach')
    ON CONFLICT (id) DO NOTHING`);
}
/** Settled legacy run row: the post-settle gate the reconstruct writer reads (N/Q1 fixture shape). */
export function settle(coach = 'coach', intent = 'intent') {
  ensureUser(coach);
  sql(`INSERT INTO "ScoutImport" (id,coach_id,intent_id,state,terminal_status)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},'settled','success')
    ON CONFLICT DO NOTHING`);
}
/**
 * The extension's stored `/complete` claim (S7L-DOC D-S7L-2) the facts service reads as `claim`:
 * `ScoutImportCompletion.terminal_status`. Any string is storable (the column carries no CHECK);
 * the service admits only `success | partial | failed` and reports everything else as `null`.
 */
export function claim(status: string, coach = 'coach', intent = 'intent') {
  sql(`INSERT INTO "${COMPLETION}" (id,coach_id,intent_id,terminal_status)
    VALUES (${quote(`${coach}-${intent}-claim`)},${quote(coach)},${quote(intent)},${quote(status)})
    ON CONFLICT (coach_id,intent_id) DO UPDATE SET terminal_status = EXCLUDED.terminal_status`);
}
/** One staged row (N/Q1 fixture shape); entity_type is the canonical family (accepted convention),
 *  or any raw token for the unmapped-entry cases (the token is what the facts group by). */
export function stage(
  source: string,
  family: string,
  payload: Record<string, unknown>,
  coach = 'coach',
  intent = 'intent',
  platform = PLATFORM,
) {
  sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${family}-${platform}-${source}`)},${quote(coach)},${quote(intent)},${quote(family)},
    ${quote(source)},${quote(platform)},${quote(JSON.stringify(payload))})
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`);
}
/**
 * A ledger row written directly (R05 contradiction fixture: a ledger identity with no staged row,
 * exactly the shape an earlier pass of a since-deleted staged row leaves behind).
 */
export function ledgerRow(
  source: string,
  family: string,
  status: 'reconstructed' | 'skipped' | 'failed',
  extra: { target_id?: string; target_kind?: string; reason?: string } = {},
  coach = 'coach',
  intent = 'intent',
  platform = PLATFORM,
) {
  const v = (s: string | undefined) => (s === undefined ? 'NULL' : quote(s));
  sql(`INSERT INTO "${LEDGER}" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,target_kind,reason)
    VALUES (${quote(`${coach}-${intent}-${family}-${platform}-${source}-ledger`)},${quote(coach)},${quote(intent)},
    ${quote(family)},${quote(source)},${quote(platform)},${quote(status)},${v(extra.target_id)},${v(extra.target_kind)},${v(extra.reason)})`);
}
/**
 * Synthetic catalog rows the exact-identifier link may resolve against (id and slug).
 * `updated_at` is `@updatedAt` in the schema: Prisma fills it client-side and the column has no
 * database default, so this raw INSERT must supply it (every other NOT NULL column of the table
 * either is listed here or carries a default in migration 20260601000000_add_exercise_catalog_video).
 */
export function catalog(items: readonly { id: string; slug: string }[]) {
  for (const item of items)
    sql(`INSERT INTO "ExerciseCatalogItem" (id,slug,name,category,primary_muscle,updated_at)
      VALUES (${quote(item.id)},${quote(item.slug)},${quote(`Synthetic ${item.slug}`)},'strength','full_body',now())
      ON CONFLICT (id) DO NOTHING`);
}

export const provenanceRows = (coach = 'coach') =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('entity_type',entity_type,'source_id',source_id,
    'source_namespace',source_namespace,'native_kind',native_kind,'native_id',native_id,'outcome',outcome,
    'reason',reason,'import_intent_id',import_intent_id) ORDER BY entity_type, source_id),'[]')
    FROM "${PROVENANCE}" WHERE coach_id=${quote(coach)}`) as Array<Record<string, string | null>>;
export const ledgerRows = (coach = 'coach', intent = 'intent') =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('entity_type',entity_type,'source_id',source_id,
    'status',status,'target_id',target_id,'target_kind',target_kind,'reason',reason) ORDER BY entity_type, source_id),'[]')
    FROM "${LEDGER}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`) as Array<
    Record<string, string | null>
  >;
export const plans = (coach = 'coach') =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'type',type,'program_id',program_id,
    'week_index',week_index,'day_index',day_index,'is_template',is_template,'version',version,
    'head_revision_id',head_revision_id,'duration_estimate_minutes',duration_estimate_minutes) ORDER BY name),'[]')
    FROM "WorkoutPlan" WHERE coach_id=${quote(coach)}`) as Array<Record<string, any>>;
export const programs = (coach = 'coach') =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'weeks',weeks,'days_per_week',days_per_week,
    'is_template',is_template,'is_regime',is_regime,'owner_user_id',owner_user_id,'visibility',visibility,'version',version) ORDER BY name),'[]')
    FROM "WorkoutProgram" WHERE coach_id=${quote(coach)}`) as Array<Record<string, any>>;
export const exercises = (planId: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'exercise_external_id',exercise_external_id,'order',"order",
    'sets',sets,'reps_or_duration_seconds',reps_or_duration_seconds,'weight_lbs',weight_lbs,'rest_seconds',rest_seconds,
    'superset_group_id',superset_group_id,'notes',notes) ORDER BY "order"),'[]')
    FROM "WorkoutPlanExercise" WHERE workout_plan_id=${quote(planId)}`) as Array<
    Record<string, any>
  >;
export const count = (table: string, where = 'true') =>
  Number(sql(`SELECT count(*) FROM "${table}" WHERE ${where}`));
export const evidenceRows = (coach = 'coach') =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('entity_type',entity_type,'source_id',source_id,'label',label,
    'client_source_id',client_source_id) ORDER BY entity_type, source_id),'[]')
    FROM "ScoutReconstructedEntity" WHERE coach_id=${quote(coach)}`) as Array<
    Record<string, string | null>
  >;
/** Every table the facts service reads, as the read-only proof watches them (counts + a content digest). */
export const WATCHED_TABLES = [
  COMPLETION,
  'ScoutIngestEntity',
  LEDGER,
  PROVENANCE,
  'Person',
  'WorkoutProgram',
  'WorkoutPlan',
  'WorkoutPlanExercise',
  'ScoutImport',
  'ScoutReconstructedEntity',
  'WorkoutPlanRevision',
] as const;
/** `{ table: [count, md5 of the sorted row text] }` — proves "no write" as content, not just cardinality. */
export const snapshot = () =>
  json(`SELECT jsonb_object_agg(t, v) FROM (VALUES
    ${WATCHED_TABLES.map(
      (table) =>
        `(${quote(table)}, (SELECT jsonb_build_array(count(*), md5(COALESCE(string_agg(x::text, E'\\n' ORDER BY x::text),''))) FROM "${table}" x))`,
    ).join(',\n    ')}) AS s(t, v)`) as Record<string, [number, string]>;

/** Whole-fixture reset: every table the proof writes, children first. Never touches the catalog schema. */
export function resetData() {
  sql(`DELETE FROM "${PROVENANCE}"; DELETE FROM "${LEDGER}"; DELETE FROM "ScoutIngestEntity";
    DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "${COMPLETION}"; DELETE FROM "ScoutImport";
    DELETE FROM "WorkoutPlanRevision"; DELETE FROM "WorkoutPlanExercise"; DELETE FROM "WorkoutPlan";
    DELETE FROM "WorkoutProgram"; DELETE FROM "ExerciseCatalogItem"; DELETE FROM "Person";
    DELETE FROM "ExtensionPairCode"; DELETE FROM "ImportIntent";`);
}
