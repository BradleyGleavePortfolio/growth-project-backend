/**
 * G2-S8-C live-proof observations layered on the S8-C-only derivative
 * (test/utils/g2-s8c-pg-harness.ts) of the accepted S8-B harness. Adds only what S8-C needs:
 * synthetic fixture rows (User → ImportIntent; ScoutImport settled; ScoutIngestEntity staged
 * programs/workouts; ExerciseCatalogItem rows the exact-identifier link may resolve against),
 * the explicit fixture source-mapping spec + native rule set the worker injects, and row
 * snapshots of the native targets, provenance and ledger. No production writer is emulated
 * here: the writer runs as the real ScoutReconstructService in test/utils/g2-s8c-worker.cjs.
 * Imported only by the explicitly guarded test/rls-g2-s8c.spec.ts.
 */
import { json, quote, sql } from './g2-s8c-pg-harness';

export const PROVENANCE = 'ImportNativeProvenance';
export const LEDGER = 'ScoutReconstructionLedger';
/** Fixture platform: canonical, synthetic, registered only through the injected spec. */
export const PLATFORM = 's8c-proof';

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
/** Worker options that inject the fixture registry (spread into every `run`). */
export const REGISTRY = { spec: SPEC, rules: RULES };

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
/** One staged row (N/Q1 fixture shape); entity_type is the canonical family (accepted convention). */
export function stage(
  source: string,
  family: 'programs' | 'workouts' | 'client_history',
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
export const revisions = (planId: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('revision_index',revision_index,'author_kind',author_kind,'cause',cause,
    'author_id',author_id) ORDER BY revision_index),'[]') FROM "WorkoutPlanRevision" WHERE workout_plan_id=${quote(planId)}`) as Array<
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

/** Whole-fixture reset: every table the proof writes, children first. Never touches the catalog schema. */
export function resetData() {
  sql(`DELETE FROM "${PROVENANCE}"; DELETE FROM "${LEDGER}"; DELETE FROM "ScoutIngestEntity";
    DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutImport";
    DELETE FROM "WorkoutPlanRevision"; DELETE FROM "WorkoutPlanExercise"; DELETE FROM "WorkoutPlan";
    DELETE FROM "WorkoutProgram"; DELETE FROM "ExerciseCatalogItem"; DELETE FROM "Person";
    DELETE FROM "ExtensionPairCode"; DELETE FROM "ImportIntent";`);
}
