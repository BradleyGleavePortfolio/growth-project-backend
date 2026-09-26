/**
 * G2-S11 live-proof observations (the ONE S11 harness, docs/decisions/2026-09-26-s11-journey.md
 * D-S11-6), layered on test/utils/g2-s11-pg-harness.ts. Derived by literal substitution from the
 * landed S9-C harness test/utils/g2-s9c-harness.ts (as landed at 92b96715), which stays byte-identical: the
 * S7-L run-lifecycle fixture helpers (User → ImportIntent, server run rows, staged rows, deadline
 * clock, run/completion snapshots, the exact §3.1 gate text) and the S8-C native fixture helpers
 * (fixture source spec + native rule set the worker injects, catalog rows, target/provenance/ledger
 * snapshots), with staged tokens that are NOT the canonical family names.
 *
 * S11-A1 deltas (and nothing else): the lane descriptor substitution; the fixture setup label is a
 * synthetic string, not a real platform slug (D-S11-7(7)); and, at the end of this file, the
 * matching wrappers for the S11 worker actions (two hosts P1/P2, pairing, progress, native review)
 * plus the progress-mirror and pairing-code readers the J-cases observe. No production writer is
 * emulated here: every behavioural step runs as the real service in test/utils/g2-s11-worker.cjs.
 */
import { json, quote, run, sql, worker } from './g2-s11-pg-harness';

export const RUN = 'ScoutImport';
export const INTENT = 'ImportIntent';
export const COMPLETION = 'ScoutImportCompletion';
export const STAGED = 'ScoutIngestEntity';
export const PROVENANCE = 'ImportNativeProvenance';
export const LEDGER = 'ScoutReconstructionLedger';
/** Fixture platform: canonical, synthetic, registered only through the injected spec. */
export const PLATFORM = 's11-proof';
/** Setup label (`ImportIntent.chosen_platform`): synthetic and deliberately NOT the staged
 *  platform, so no decision can depend on it (D-S11-7(1)); never a real source slug (D-S11-7(7)). */
export const SETUP_LABEL = 's11-label';
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
    VALUES (gen_random_uuid(),${quote(coach)},${quote(SETUP_LABEL)},${paired ? 'now()' : 'NULL'})
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

/* ---------------------------------------------------------------------------------------------
 * S11-A1 wrappers (D-S11-6). A "host" is a worker process: every call below forks a NEW OS
 * process with its own ScoutService (own progress cache), so successive steps routed to P1 and P2
 * never share process memory; a step that must keep process state alive (a pending snapshot) uses
 * `progressHeld`, which pauses at the worker's `cached` barrier. `host` is a label only (it is
 * echoed in the PG17_PROCESS log line), never an input to any service.
 * ------------------------------------------------------------------------------------------- */
export type Host = 'P1' | 'P2';
export type Role = 'phone' | 'ext';
type Options = Record<string, unknown>;
/** One real service step on `host` for the client `role` (a label; roles are not principals). */
export const on = (host: Host, role: Role, options: Options) =>
  run({ ...REGISTRY, ...options, host, role });
export const pairInit = (host: Host, coach: string, body: Options = {}) => {
  ensureUser(coach);
  return on(host, 'phone', { action: 'pair-init', coach, body });
};
export const pairRedeem = (host: Host, code: string) =>
  on(host, 'ext', { action: 'pair-redeem', coach: 'unauthenticated', body: { code } });
export const pairCurrent = (host: Host, coach: string, nonce?: string) =>
  on(host, 'phone', { action: 'pair-current', coach, body: nonce === undefined ? {} : { nonce } });
export const pairSession = (host: Host, coach: string, intentId: string) =>
  on(host, 'phone', { action: 'pair-session', coach, intent: intentId });
export const startRun = (host: Host, coach: string, intentId: string) =>
  on(host, 'phone', { action: 'start', coach, intent: intentId });
export const cancelRun = (host: Host, coach: string, intentId: string) =>
  on(host, 'phone', { action: 'cancel', coach, intent: intentId });
export const ingestBatch = (
  host: Host,
  coach: string,
  intentId: string,
  entities: { sourceId: string; payload: Record<string, unknown> }[],
  entityType: string = TOKEN.clients,
) =>
  on(host, 'ext', {
    action: 'ingest',
    coach,
    intent: intentId,
    body: { entity_type: entityType, entities },
  });
export const completeRun = (
  host: Host,
  coach: string,
  intentId: string,
  terminal_status = 'success',
) => on(host, 'ext', { action: 'complete', coach, intent: intentId, body: { terminal_status } });
export const statusOf = (host: Host, coach: string, intentId: string) =>
  on(host, 'phone', { action: 'status', coach, intent: intentId });
export const progressOf = (host: Host, coach: string, intentId: string, body: Options = {}) =>
  on(host, 'ext', { action: 'progress', coach, intent: intentId, body });
/** A progress post whose worker stays alive at `cached` with the snapshot pending in ITS cache;
 *  `resume()` then flushes (when `body.flush`) and exits, `stop()` kills the host. */
export const progressHeld = (host: Host, coach: string, intentId: string, body: Options = {}) =>
  worker({
    ...REGISTRY,
    action: 'progress',
    coach,
    intent: intentId,
    body,
    pause: 'cached',
    host,
    role: 'ext',
  });
export const rosterOf = (host: Host, coach: string, intentId: string) =>
  on(host, 'phone', { action: 'roster', coach, intent: intentId });
export const entitiesOf = (host: Host, coach: string, intentId: string, family = 'workouts') =>
  on(host, 'phone', { action: 'entities', coach, intent: intentId, body: { family } });

/** Every persisted progress-mirror row (the mirror; never a truth field). */
export const snapshotRows = () =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('coach_id',coach_id,'intent_id',intent_id,
    'device_id',device_id,'snapshot',snapshot,'last_error',last_error)
    ORDER BY coach_id,intent_id,device_id),'[]') FROM "ScoutProgressSnapshot"`) as Array<
    Record<string, any>
  >;
/** Every staged row of one (coach, intent), full contents (S11-A1 fix 2: not just the count). */
export const stagedRows = (coach: string, intentId: string) =>
  json(`SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY entity_type, source_platform, source_id),'[]')
    FROM "${STAGED}" s WHERE coach_id=${quote(coach)} AND intent_id=${quote(intentId)}`) as Array<
    Record<string, any>
  >;
/** Persisted client-directed side-effect tables (S11-A1 fix 3): row counts, never contents. */
export const OUTBOUND_TABLES = [
  'Notification',
  'NotificationDeliveryLog',
  'Message',
  'MessageDraft',
  'CoachMessage',
  'EmailSendLog',
  'CoachNudge',
  'NudgeLog',
  'DripResolverMarker',
];
export const outboundTableCounts = () =>
  Object.fromEntries(OUTBOUND_TABLES.map((t) => [t, count(t)])) as Record<string, number>;
/** The setup row of one intent (pairing state as persisted). */
export const intentRow = (intentId: string) =>
  json(
    `SELECT COALESCE((SELECT to_jsonb(i) FROM "${INTENT}" i WHERE id=${quote(intentId)}::uuid),'null')`,
  );
export const pairCodeRows = (coach: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('coach_id',coach_id,'import_intent_id',import_intent_id,
    'used',used_at IS NOT NULL,'failed_attempts',failed_attempts) ORDER BY created_at),'[]')
    FROM "ExtensionPairCode" WHERE coach_id=${quote(coach)}`) as Array<Record<string, any>>;
