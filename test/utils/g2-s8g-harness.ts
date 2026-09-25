/**
 * G2-S8-G live-proof observations layered on the S8-G-only derivative
 * (test/utils/g2-s8g-pg-harness.ts) of the accepted S8-C harness. Union of the S7-L run-lifecycle
 * fixture helpers (test/utils/g2-s7l-harness.ts at 1c5fbb04: User → ImportIntent, server run rows,
 * staged rows, deadline clock, run/completion snapshots, the exact §3.1 gate text) and the S8-C
 * native fixture helpers (test/utils/g2-s8c-harness.ts: fixture source spec + native rule set the
 * worker injects, catalog rows, target/provenance/ledger snapshots). Adds only what S8-G needs:
 * staged tokens that are NOT the canonical family names (`people`/`blocks`/`routines`/`log`), so
 * the proof observes the planner's token → family resolution and the ledger's token grouping.
 * No production writer is emulated here: the settle path runs as the real ScoutService →
 * ScoutLifecycleService → ScoutReconstructService in test/utils/g2-s8g-worker.cjs. Imported only
 * by the explicitly guarded test/rls-g2-s8g.spec.ts.
 */
import { json, quote, sql } from './g2-s8g-pg-harness';

export const RUN = 'ScoutImport';
export const INTENT = 'ImportIntent';
export const COMPLETION = 'ScoutImportCompletion';
export const STAGED = 'ScoutIngestEntity';
export const PROVENANCE = 'ImportNativeProvenance';
export const LEDGER = 'ScoutReconstructionLedger';
/** Fixture platform: canonical, synthetic, registered only through the injected spec. */
export const PLATFORM = 's8g-proof';
/** Staged step tokens of the fixture platform (deliberately not the canonical family names). */
export const TOKEN = {
  clients: 'people',
  programs: 'blocks',
  workouts: 'routines',
  client_history: 'log',
} as const;
/** Contract §3.8 order the pass must follow, as fixture tokens. */
export const TOKEN_ORDER = [TOKEN.clients, TOKEN.programs, TOKEN.workouts, TOKEN.client_history];

/** Fixture S8-A spec: `people` → clients, `blocks` → programs, `routines` → workouts, `log` → client_history. */
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
/** Fixture S8-C native rules for the same platform (the accepted S8-C fixture shape). */
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

export const MODES = ['legacy', 'server'] as const;
export const PHASES = ['discovering', 'transferring', 'reconciling'] as const;
export const FENCE_REASONS = ['cancelled', 'timed_out', 'revoked'] as const;

/** Synthetic owner row (User is the FK target of ImportIntent/WorkoutPlan/WorkoutProgram coach_id). */
export function ensureUser(coach: string) {
  sql(`INSERT INTO "User" (id,supabase_id,email,name,role)
    VALUES (${quote(coach)},${quote(`sb-${coach}`)},${quote(`${coach}@synthetic.invalid`)},${quote(`Synthetic ${coach}`)},'coach')
    ON CONFLICT (id) DO NOTHING`);
}
/** Synthetic setup intent for `coach`; returns its UUID. C1 keeps ONE current setup per coach
 *  (`ImportIntent_one_current_key`), so any earlier current intent of the coach is superseded
 *  first (fixture shaping). `paired=false` → S7-L Start must refuse `intent_not_paired`. */
export function intent(coach: string, paired = true): string {
  ensureUser(coach);
  return sql(`UPDATE "${INTENT}" SET superseded_at=now() WHERE coach_id=${quote(coach)} AND superseded_at IS NULL;
    INSERT INTO "${INTENT}" (id,coach_id,chosen_platform,paired_at)
    VALUES (gen_random_uuid(),${quote(coach)},'truecoach',${paired ? 'now()' : 'NULL'})
    RETURNING id`);
}
/** Settled LEGACY run row (the pre-S7-L writer's shape): the post-settle gate of the coach-JWT route. */
export function legacyRun(coach: string, intent: string, terminal: string | null = 'success') {
  ensureUser(coach);
  sql(`INSERT INTO "${RUN}" (id,coach_id,intent_id,state,terminal_status,completed_at)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},
      ${terminal === null ? "'in_progress'" : quote(terminal)},${terminal === null ? 'NULL' : quote(terminal)},
      ${terminal === null ? 'NULL' : 'now()'})
    ON CONFLICT DO NOTHING`);
}
/** One SERVER run row written directly (SQL-level fixtures only). Behavioural runs come from the
 *  real Start through the worker. */
export function serverRunInsert(
  coach: string,
  intentId: string,
  overrides: Partial<Record<string, string>> = {},
) {
  const v: Record<string, string> = {
    id: quote(`${coach}-${intentId}`),
    coach_id: quote(coach),
    intent_id: quote(intentId),
    state: "'in_progress'",
    terminal_status: 'NULL',
    mode: "'server'",
    import_intent_id: `${quote(intentId)}::uuid`,
    phase: "'discovering'",
    accepted_start_at: "(now() AT TIME ZONE 'UTC')",
    deadline_at: "(now() AT TIME ZONE 'UTC') + interval '5 minutes'",
    ...overrides,
  };
  const names = Object.keys(v);
  return `INSERT INTO "${RUN}" (${names.join(',')}) VALUES (${names.map((n) => v[n]).join(',')})`;
}
/** One staged row (the accepted ingest shape) written directly; `token` is the staged step token
 *  (fixture platform tokens, or an unmapped one such as `notes`). */
export function stage(
  coach: string,
  intent: string,
  token: string,
  source: string,
  payload: Record<string, unknown> = { name: `Synthetic ${source}` },
  platform: string = PLATFORM,
) {
  sql(`INSERT INTO "${STAGED}" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${token}-${platform}-${source}`)},${quote(coach)},${quote(intent)},${quote(token)},
    ${quote(source)},${quote(platform)},${quote(JSON.stringify(payload))})
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`);
}
/**
 * Synthetic catalog rows the exact-identifier link may resolve against (id and slug).
 * `updated_at` is `@updatedAt` in the schema: Prisma fills it client-side and the column has no
 * database default, so this raw INSERT must supply it.
 */
export function catalog(items: readonly { id: string; slug: string }[]) {
  for (const item of items)
    sql(`INSERT INTO "ExerciseCatalogItem" (id,slug,name,category,primary_muscle,updated_at)
      VALUES (${quote(item.id)},${quote(item.slug)},${quote(`Synthetic ${item.slug}`)},'strength','full_body',now())
      ON CONFLICT (id) DO NOTHING`);
}
/** Move a server run's deadline into the past (fixture clock; the service never updates it). */
export function expire(coach: string, intent: string) {
  sql(`UPDATE "${RUN}" SET deadline_at=accepted_start_at + interval '1 millisecond'
    WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`);
}

/** One run row (all columns) or null. */
export const runRow = (coach: string, intent: string) =>
  json(
    `SELECT COALESCE((SELECT to_jsonb(r) FROM "${RUN}" r WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}),'null')`,
  );
export const runCount = () => Number(sql(`SELECT count(*) FROM "${RUN}"`));
export const completionRows = () =>
  json(
    `SELECT COALESCE(jsonb_agg(jsonb_build_array(coach_id,intent_id,terminal_status) ORDER BY coach_id,intent_id),'[]') FROM "${COMPLETION}"`,
  );
export const stagedCount = (coach: string, intent: string) =>
  Number(
    sql(
      `SELECT count(*) FROM "${STAGED}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`,
    ),
  );
export const stagedGroups = (coach: string, intent: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('source_platform',source_platform,'entity_type',entity_type,'n',n)
    ORDER BY source_platform,entity_type),'[]')
    FROM (SELECT source_platform,entity_type,count(*) AS n FROM "${STAGED}"
      WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)} GROUP BY 1,2) g`) as Array<
    Record<string, any>
  >;
export const provenanceRows = (coach: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('entity_type',entity_type,'source_id',source_id,
    'source_namespace',source_namespace,'native_kind',native_kind,'native_id',native_id,'outcome',outcome,
    'reason',reason,'import_intent_id',import_intent_id) ORDER BY entity_type, source_id),'[]')
    FROM "${PROVENANCE}" WHERE coach_id=${quote(coach)}`) as Array<Record<string, string | null>>;
export const ledgerRows = (coach: string, intent: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('entity_type',entity_type,'source_platform',source_platform,
    'source_id',source_id,'status',status,'target_id',target_id,'target_kind',target_kind,'reason',reason)
    ORDER BY entity_type, source_platform, source_id),'[]')
    FROM "${LEDGER}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}`) as Array<
    Record<string, string | null>
  >;
/** Ledger tally per staged token: the arbiter's `ledger_by_family` grouping key. */
export const ledgerByToken = (coach: string, intent: string) =>
  json(`SELECT COALESCE(jsonb_object_agg(entity_type, tally),'{}') FROM (
    SELECT entity_type, jsonb_build_object(
      'reconstructed', count(*) FILTER (WHERE status='reconstructed'),
      'skipped', count(*) FILTER (WHERE status='skipped'),
      'failed', count(*) FILTER (WHERE status='failed')) AS tally
    FROM "${LEDGER}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)} GROUP BY entity_type) t`) as Record<
    string,
    { reconstructed: number; skipped: number; failed: number }
  >;
export const plans = (coach: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'type',type,'program_id',program_id,
    'week_index',week_index,'day_index',day_index,'is_template',is_template,'version',version,
    'head_revision_id',head_revision_id,'duration_estimate_minutes',duration_estimate_minutes) ORDER BY name),'[]')
    FROM "WorkoutPlan" WHERE coach_id=${quote(coach)}`) as Array<Record<string, any>>;
export const programs = (coach: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'weeks',weeks,'days_per_week',days_per_week,
    'is_template',is_template,'is_regime',is_regime,'owner_user_id',owner_user_id,'visibility',visibility,'version',version) ORDER BY name),'[]')
    FROM "WorkoutProgram" WHERE coach_id=${quote(coach)}`) as Array<Record<string, any>>;
export const persons = (coach: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'display_name',display_name) ORDER BY id),'[]')
    FROM "Person" WHERE coach_id=${quote(coach)}`) as Array<Record<string, any>>;
export const evidenceRows = (coach: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('entity_type',entity_type,'source_id',source_id,'label',label,
    'client_source_id',client_source_id) ORDER BY entity_type, source_id),'[]')
    FROM "ScoutReconstructedEntity" WHERE coach_id=${quote(coach)}`) as Array<
    Record<string, string | null>
  >;
export const count = (table: string, where = 'true') =>
  Number(sql(`SELECT count(*) FROM "${table}" WHERE ${where}`));
/** Every row of every native/evidence target and the ledger for one coach: the "nothing further
 *  written" snapshot (P03/P05) and the legacy byte-identity snapshot (P08). */
export const targetSnapshot = (coach: string, intent: string) => ({
  persons: persons(coach),
  programs: programs(coach),
  plans: plans(coach),
  evidence: evidenceRows(coach),
  provenance: provenanceRows(coach),
  ledger: ledgerRows(coach, intent),
});

/** Whole-fixture reset: every table the proof writes, children first. Never touches the catalog schema. */
export function resetData() {
  sql(`DELETE FROM "${PROVENANCE}"; DELETE FROM "${LEDGER}"; DELETE FROM "${STAGED}";
    DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutProgressSnapshot";
    DELETE FROM "${COMPLETION}"; DELETE FROM "${RUN}";
    DELETE FROM "WorkoutPlanRevision"; DELETE FROM "WorkoutPlanExercise"; DELETE FROM "WorkoutPlan";
    DELETE FROM "WorkoutProgram"; DELETE FROM "ExerciseCatalogItem"; DELETE FROM "Person";
    DELETE FROM "ExtensionPairCode"; DELETE FROM "${INTENT}";`);
}
/** The exact §3.1 gate statement as SQL text for the two-session serialization check. */
export const gateSql = (coach: string, intent: string) =>
  `UPDATE "${RUN}" SET last_observed_at=(now() AT TIME ZONE 'UTC'),
     phase=CASE WHEN phase='discovering' THEN 'transferring' ELSE phase END
   WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)} AND mode='server'
     AND terminal_status IS NULL AND fenced_at IS NULL AND deadline_at>(now() AT TIME ZONE 'UTC')
   RETURNING execution_epoch`;
