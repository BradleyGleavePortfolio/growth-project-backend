/**
 * G2-S8-B live-proof observations layered on the S8-B-only derivative
 * (test/utils/g2-s8b-pg-harness.ts) of the committed N/Q1 harness. Adds only what S8-B needs:
 * the exact catalog of the new ImportNativeProvenance table and of the expanded
 * ScoutReconstructionLedger (columns, CHECKs, FK, indexes, RLS flags, policies and grants) with
 * and without OIDs, row snapshots with and without the target_kind column, the contract's child
 * source_id encoding, and synthetic fixture rows (User → ImportIntent; ScoutImport settled;
 * ScoutIngestEntity staged; direct provenance INSERTs). No production writer is emulated here:
 * the N ledger writer runs as the real ScoutReconstructService in the unchanged
 * test/utils/g2-tq0-worker.cjs. Imported only by the explicitly guarded test/rls-g2-s8b.spec.ts.
 */
import { json, quote, sql } from './g2-s8b-pg-harness';

export const PROVENANCE = 'ImportNativeProvenance';
export const LEDGER = 'ScoutReconstructionLedger';
export const PROVENANCE_COLUMNS = [
  'id',
  'coach_id',
  'import_intent_id',
  'source_namespace',
  'entity_type',
  'source_id',
  'native_kind',
  'native_id',
  'outcome',
  'reason',
  'created_at',
] as const;
export const NATIVE_KINDS = [
  'person',
  'scout_entity',
  'workout_program',
  'workout_plan',
  'workout_plan_exercise',
] as const;
/** Ledger targets: every native kind except the child-only workout_plan_exercise (contract §3.3). */
export const TARGET_KINDS = ['person', 'scout_entity', 'workout_program', 'workout_plan'] as const;
export const OUTCOMES = ['created', 'already_present', 'unresolved'] as const;
export const PROVENANCE_CHECK_NAMES = [
  'ImportNativeProvenance_native_id_shape_check',
  'ImportNativeProvenance_native_kind_check',
  'ImportNativeProvenance_outcome_check',
  'ImportNativeProvenance_unresolved_reason_check',
] as const;
export const LEDGER_CHECK_NAMES = [
  'ScoutReconstructionLedger_target_kind_check',
  'ScoutReconstructionLedger_target_kind_shape_check',
] as const;
export const FK_NAME = 'ImportNativeProvenance_import_intent_id_coach_id_fkey';
export const IDENTITY_INDEX = 'ImportNativeProvenance_identity_key';
export const NATIVE_INDEX = 'ImportNativeProvenance_coach_id_native_kind_native_id_idx';
export const INTENT_INDEX = 'ImportNativeProvenance_coach_id_import_intent_id_idx';
export const PROVENANCE_POLICIES = [
  'deny_all_anon_import_native_provenance',
  'deny_all_authenticated_import_native_provenance',
  'p_import_native_provenance_service_role_all',
] as const;
export const LEDGER_POLICIES = [
  'deny_all_anon_scout_reconstruction',
  'deny_all_authenticated_scout_reconstruction',
  'p_scout_reconstruction_service_role_all',
] as const;
/** Exact expected catalog contribution of S8-B (pg_get_*def renderings, PG 15-17). */
export const EXPECTED_PROVENANCE_COLUMNS: [string, string, boolean, string | null][] = [
  ['id', 'text', true, null],
  ['coach_id', 'text', true, null],
  ['import_intent_id', 'uuid', false, null],
  ['source_namespace', 'text', true, null],
  ['entity_type', 'text', true, null],
  ['source_id', 'text', true, null],
  ['native_kind', 'text', true, null],
  ['native_id', 'text', false, null],
  ['outcome', 'text', true, null],
  ['reason', 'text', false, null],
  ['created_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'],
];
export const EXPECTED_LEDGER_TARGET_KIND: [string, string, boolean, string | null] = [
  'target_kind',
  'text',
  false,
  null,
];
const anyOf = (values: readonly string[]) =>
  `ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(', ')}])`;
export const EXPECTED_PROVENANCE_CHECK_DEFS: Record<
  (typeof PROVENANCE_CHECK_NAMES)[number],
  string
> = {
  ImportNativeProvenance_native_id_shape_check:
    "CHECK (((native_id IS NULL) = (outcome = 'unresolved'::text)))",
  ImportNativeProvenance_native_kind_check: `CHECK ((native_kind = ${anyOf(NATIVE_KINDS)}))`,
  ImportNativeProvenance_outcome_check: `CHECK ((outcome = ${anyOf(OUTCOMES)}))`,
  ImportNativeProvenance_unresolved_reason_check:
    "CHECK (((outcome <> 'unresolved'::text) OR (reason IS NOT NULL)))",
};
export const EXPECTED_LEDGER_CHECK_DEFS: Record<(typeof LEDGER_CHECK_NAMES)[number], string> = {
  ScoutReconstructionLedger_target_kind_check: `CHECK (((target_kind IS NULL) OR (target_kind = ${anyOf(TARGET_KINDS)})))`,
  ScoutReconstructionLedger_target_kind_shape_check:
    'CHECK (((target_kind IS NULL) OR (target_id IS NOT NULL)))',
};
export const EXPECTED_FK_DEF = `FOREIGN KEY (import_intent_id, coach_id) REFERENCES "ImportIntent"(id, coach_id) ON UPDATE CASCADE ON DELETE RESTRICT`;
export const EXPECTED_PK_DEF = 'PRIMARY KEY (id)';
export const EXPECTED_INDEX_DEFS: Record<string, string> = {
  ImportNativeProvenance_pkey: `CREATE UNIQUE INDEX "ImportNativeProvenance_pkey" ON public."ImportNativeProvenance" USING btree (id)`,
  [IDENTITY_INDEX]: `CREATE UNIQUE INDEX "${IDENTITY_INDEX}" ON public."ImportNativeProvenance" USING btree (coach_id, source_namespace, entity_type, source_id)`,
  [NATIVE_INDEX]: `CREATE INDEX "${NATIVE_INDEX}" ON public."ImportNativeProvenance" USING btree (coach_id, native_kind, native_id)`,
  [INTENT_INDEX]: `CREATE INDEX "${INTENT_INDEX}" ON public."ImportNativeProvenance" USING btree (coach_id, import_intent_id)`,
};

const rel = (table: string) => `'public."${table}"'::regclass`;
export const exists = (table: string) =>
  sql(`SELECT to_regclass('public."${table}"') IS NOT NULL`) === 't';
/** Every column of a table in attnum order: name, rendered type, NOT NULL, rendered default. */
export const columns = (table: string) =>
  exists(table)
    ? json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]')
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=${rel(table)} AND a.attnum>0 AND NOT a.attisdropped`)
    : [];
/** Every constraint of a table (CHECK, FK, PK) by name with validation flag and definition. */
export const constraints = (table: string, withOids = false) =>
  exists(table)
    ? json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(conname,contype,convalidated,pg_get_constraintdef(oid)
    ${withOids ? ',oid' : ''}) ORDER BY conname),'[]')
  FROM pg_constraint WHERE conrelid=${rel(table)}`)
    : [];
/** Every index of a table by name with its definition (and OID when asked). */
export const indexes = (table: string, withOids = false) =>
  exists(table)
    ? json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,i.indisunique,i.indisvalid,pg_get_indexdef(i.indexrelid)
    ${withOids ? ',i.indexrelid' : ''}) ORDER BY c.relname),'[]')
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=${rel(table)}`)
    : [];
/** RLS posture of a table: flags plus every policy row (pg_policies has no OIDs) and every grant. */
export const rls = (table: string) =>
  exists(table)
    ? json(`SELECT jsonb_build_object(
  'enabled',(SELECT relrowsecurity FROM pg_class WHERE oid=${rel(table)}),
  'forced',(SELECT relforcerowsecurity FROM pg_class WHERE oid=${rel(table)}),
  'policies',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY policyname),'[]') FROM pg_policies p
    WHERE schemaname='public' AND tablename=${quote(table)}),
  'grants',(SELECT COALESCE(jsonb_agg(jsonb_build_array(grantee,privilege_type) ORDER BY grantee,privilege_type),'[]')
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=${quote(table)}))`)
    : null;
const tableShape = (table: string, withOids: boolean) => ({
  columns: columns(table),
  constraints: constraints(table, withOids),
  indexes: indexes(table, withOids),
  rls: rls(table),
  ...(withOids
    ? {
        relfilenode: exists(table)
          ? sql(`SELECT relfilenode FROM pg_class WHERE oid=${rel(table)}`)
          : null,
      }
    : {}),
});
/** OID-free shape of both tables (provenance empty when absent). Equal across down → up. */
export const shape = () => ({
  ledger: tableShape(LEDGER, false),
  provenance: tableShape(PROVENANCE, false),
  provenanceExists: exists(PROVENANCE),
});
/** Shape WITH OIDs: equal across a refused up/down proves nothing was recreated. */
export const shapeWithOids = () => ({
  ledger: tableShape(LEDGER, true),
  provenance: tableShape(PROVENANCE, true),
  provenanceExists: exists(PROVENANCE),
});
/** The ledger's target_kind column entry, or [] when absent. */
export const ledgerTargetKind = () =>
  (columns(LEDGER) as [string, string, boolean, string | null][]).filter(
    ([name]) => name === 'target_kind',
  );

/** Every ledger row, deterministic order (all columns present at the time). */
export const ledgerRows = () =>
  json(`SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY coach_id,intent_id,entity_type,source_platform,source_id,id),'[]')
  FROM "${LEDGER}" l`);
/** Every ledger row without target_kind: the "retained across S8-B and its down" proof. */
export const ledgerRowsWithoutTargetKind = () =>
  json(`SELECT COALESCE(jsonb_agg((to_jsonb(l) - 'target_kind') ORDER BY coach_id,intent_id,entity_type,source_platform,source_id,id),'[]')
  FROM "${LEDGER}" l`);
/** Ledger rows of one scope keyed by the five-field identity, as the N writer leaves them. */
export const identityRows = (coach = 'coach', intent = 'intent', family?: string) =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(entity_type,source_id,source_platform,status,target_id)
  ORDER BY entity_type,source_id,source_platform),'[]')
  FROM "${LEDGER}" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}
  ${family ? `AND entity_type=${quote(family)}` : ''}`);
export const ledgerCount = () => Number(sql(`SELECT count(*) FROM "${LEDGER}"`));
export const ledgerTypedCount = () =>
  Number(sql(`SELECT count(*) FROM "${LEDGER}" WHERE target_kind IS NOT NULL`));
export const personCount = () => Number(sql(`SELECT count(*) FROM "Person"`));
/** Every provenance row, deterministic order; [] when the table is absent. */
export const provenanceRows = () =>
  exists(PROVENANCE)
    ? json(`SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY coach_id,source_namespace,entity_type,source_id,id),'[]')
  FROM "${PROVENANCE}" p`)
    : [];
export const provenanceCount = () =>
  exists(PROVENANCE) ? Number(sql(`SELECT count(*) FROM "${PROVENANCE}"`)) : 0;
export const intentCount = () => Number(sql(`SELECT count(*) FROM "ImportIntent"`));

/** Contract §3.3 child identity: `<n>:<parent>#id:<child>` or `<n>:<parent>#ord:<ordinal>`,
 *  where <n> is the decimal character length of the parent source_id. */
export const childSourceId = (parent: string, child: { id: string } | { ordinal: number }) =>
  `${parent.length}:${parent}#${'id' in child ? `id:${child.id}` : `ord:${child.ordinal}`}`;

/** Synthetic owner row (User is the FK target of ImportIntent.coach_id); no customer data. */
export function ensureUser(coach: string) {
  sql(`INSERT INTO "User" (id,supabase_id,email,name,role)
    VALUES (${quote(coach)},${quote(`sb-${coach}`)},${quote(`${coach}@synthetic.invalid`)},${quote(`Synthetic ${coach}`)},'coach')
    ON CONFLICT (id) DO NOTHING`);
}
/** Synthetic paired setup intent for `coach`; returns its UUID. C1 keeps ONE current setup per
 *  coach (`ImportIntent_one_current_key`), so any earlier current intent of the coach is superseded
 *  first (fixture shaping; a superseded intent is still a valid FK target for provenance). */
export function intent(coach: string, paired = true): string {
  ensureUser(coach);
  return sql(`UPDATE "ImportIntent" SET superseded_at=now() WHERE coach_id=${quote(coach)} AND superseded_at IS NULL;
    INSERT INTO "ImportIntent" (id,coach_id,chosen_platform,paired_at)
    VALUES (gen_random_uuid(),${quote(coach)},'truecoach',${paired ? 'now()' : 'NULL'})
    RETURNING id`);
}
/** Settled legacy run row: the post-settle gate the reconstruct writer reads (N/Q1 fixture shape). */
export function settle(coach = 'coach', intent = 'intent') {
  sql(`INSERT INTO "ScoutImport" (id,coach_id,intent_id,state,terminal_status)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},'settled','success')
    ON CONFLICT DO NOTHING`);
}
/** One staged row (N/Q1 fixture shape): the harness id carries family AND platform. */
export function stage(
  source = 'a',
  family = 'clients',
  platform = 'truecoach',
  name = 'Synthetic A',
  coach = 'coach',
  intent = 'intent',
) {
  sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${family}-${platform}-${source}`)},${quote(coach)},${quote(intent)},${quote(family)},
    ${quote(source)},${quote(platform)},${quote(JSON.stringify({ name, client_id: 'client-new' }))})`);
}
/** Bulk synthetic staging through generate_series; names are synthetic, no customer data. */
export function stageMany(
  count: number,
  family = 'clients',
  platform = 'truecoach',
  coach = 'coach',
  intent = 'intent',
  prefix = 's',
) {
  sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    SELECT ${quote(`${coach}-${intent}-${prefix}`)}||lpad(n::text,5,'0'),${quote(coach)},${quote(intent)},${quote(family)},
      ${quote(prefix)}||lpad(n::text,5,'0'),${quote(platform)},
      jsonb_build_object('name','Synthetic '||n,'client_id','client-'||n)
    FROM generate_series(1,${count}) n`);
}
let provenanceSequence = 0;
/** The INSERT statement of one provenance record (the S8-C writer's shape) with overrides. */
export const provenanceInsert = (overrides: Partial<Record<string, string>> = {}) => {
  const v: Record<string, string> = {
    id: quote(`prov-${++provenanceSequence}`),
    coach_id: "'coach'",
    import_intent_id: 'NULL',
    source_namespace: "'truecoach'",
    entity_type: "'workouts'",
    source_id: "'w-1'",
    native_kind: "'workout_plan'",
    native_id: "'plan-1'",
    outcome: "'created'",
    reason: 'NULL',
    ...overrides,
  };
  const names = Object.keys(v);
  return `INSERT INTO "${PROVENANCE}" (${names.join(',')}) VALUES (${names.map((n) => v[n]).join(',')})`;
};
export function resetData() {
  sql(`${exists(PROVENANCE) ? `DELETE FROM "${PROVENANCE}";` : ''}
    DELETE FROM "${LEDGER}"; DELETE FROM "ScoutIngestEntity"; DELETE FROM "Person";
    DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutImport";
    DELETE FROM "ExtensionPairCode"; DELETE FROM "ImportIntent";`);
}
