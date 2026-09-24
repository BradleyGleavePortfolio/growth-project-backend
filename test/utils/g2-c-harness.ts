/**
 * G2-C live-proof helpers layered on the C-only derivative (test/utils/g2-c-pg-harness.ts) of
 * the accepted N/Q1 harness (test/utils/g2-nq1-pg-harness.ts, unchanged).
 * Carries the B, R and N/Q1 helpers unchanged (S1, C1, E, B, R are fixture history here: the
 * old root IS the accepted N/Q1 head, so its `prisma migrate deploy` installs exactly that
 * history, 169 recorded) and adds only what C needs: the C migration files, the narrow-key
 * observations the contraction removes, the C.down refusal text, staging/ledger identity
 * observations without the harness ids, and an in-process REAL ingest service (the shared
 * worker has no ingest action; the accepted worker file is not modified).
 * Imported only by the explicitly guarded test/rls-g2-c-contract.spec.ts.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PrismaService } from '../../src/prisma.service';
import { ScoutEntityDto, ScoutIngestDto } from '../../src/scout/scout-ingest.dto';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';
import { json, quote, root, sql, target } from './g2-c-pg-harness';
import { G2_C_RUNTIME_ROLE, withFixturePassword } from './g2-c-db';

export const B_MIGRATION = '20270119000000_scout_ledger_obsolete_writer_fence';
export const bDir = resolve(root, 'prisma/migrations', B_MIGRATION);
export const bUpFile = resolve(bDir, 'migration.sql');
export const bDownFile = resolve(bDir, 'down.sql');
export const bUp = readFileSync(bUpFile, 'utf8');
export const bDown = readFileSync(bDownFile, 'utf8');
export const R_MIGRATION = '20270120000000_scout_identity_ready';
export const rDir = resolve(root, 'prisma/migrations', R_MIGRATION);
export const rUpFile = resolve(rDir, 'migration.sql');
export const rDownFile = resolve(rDir, 'down.sql');
export const rUp = readFileSync(rUpFile, 'utf8');
export const rDown = readFileSync(rDownFile, 'utf8');
/** C: the identity contract (this packet's files). No verify.sql ships with C. */
export const C_MIGRATION = '20270121000000_scout_identity_contract';
export const cDir = resolve(root, 'prisma/migrations', C_MIGRATION);
export const cUpFile = resolve(cDir, 'migration.sql');
export const cDownFile = resolve(cDir, 'down.sql');
export const cUp = readFileSync(cUpFile, 'utf8');
export const cDown = readFileSync(cDownFile, 'utf8');
export const WIDE_COLUMNS = 'coach_id, intent_id, entity_type, source_platform, source_id';
export const CANONICAL_CHECK = `CHECK (((source_platform COLLATE "C") ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'::text))`;
/** The accepted narrow keys C drops: exact stored names (the ledger name is PostgreSQL's
 *  63-character truncation of the 70-character accepted text) and exact definitions. */
export const NARROW_STAGING_NAME = 'ScoutIngestEntity_coach_id_intent_id_source_id_key';
export const NARROW_LEDGER_NAME = 'ScoutReconstructionLedger_coach_id_intent_id_entity_type_source';
export const NARROW_STAGING_DEF = `CREATE UNIQUE INDEX "${NARROW_STAGING_NAME}" ON public."ScoutIngestEntity" USING btree (coach_id, intent_id, source_id)`;
export const NARROW_LEDGER_DEF = `CREATE UNIQUE INDEX "${NARROW_LEDGER_NAME}" ON public."ScoutReconstructionLedger" USING btree (coach_id, intent_id, entity_type, source_id)`;
/** C.down's fixed, identifier-free refusal (SQLSTATE 23505). The exact text is the contract. */
export const C_DOWN_REFUSAL =
  'G2-C.down refused: cross-family/cross-platform identities exist; restoring narrow keys would lose data. Forward repair only: keep C, fix forward with N-compatible writers; no deletion.';
/** R's catalog contribution: exact wide index definitions, exact CHECK definitions (as
 *  pg_get_constraintdef renders them), the ledger column's NOT NULL. Empty arrays / false when
 *  R is absent. Index and constraint OIDs are included so "unchanged" is provable across a rerun. */
export const wide = () =>
  json(`SELECT jsonb_build_object(
  'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,i.indexrelid,i.indisunique,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname),'[]')
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE c.relname IN ('ScoutIngestEntity_identity_key','ScoutReconstructionLedger_identity_key')
      AND c.relnamespace='public'::regnamespace),
  'checks',(SELECT COALESCE(jsonb_agg(jsonb_build_array(conname,oid,conrelid::regclass::text,convalidated,pg_get_constraintdef(oid)) ORDER BY conname),'[]')
    FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace
      AND conname IN ('ScoutIngestEntity_source_platform_canonical','ScoutReconstructionLedger_source_platform_canonical')),
  'ledgerNotNull',(SELECT attnotnull FROM pg_attribute WHERE attrelid='public."ScoutReconstructionLedger"'::regclass
    AND attname='source_platform' AND NOT attisdropped))`);
/** Both narrow unique indexes with their OIDs: absent (`[]`) once C is applied; C.down must
 *  recreate them byte-exact (OIDs aside). */
export const narrow = () =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,i.indexrelid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname),'[]')
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relname IN ('ScoutIngestEntity_coach_id_intent_id_source_id_key',
    'ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key'::name)
    AND c.relnamespace='public'::regnamespace
    AND i.indrelid IN ('public."ScoutIngestEntity"'::regclass,'public."ScoutReconstructionLedger"'::regclass)`);
/** Any relation in `public` holding a narrow name (an index, or a decoy table/view): oid, kind. */
export const narrowNamed = () =>
  json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(relname,oid,relkind) ORDER BY relname),'[]')
  FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN
  ('ScoutIngestEntity_coach_id_intent_id_source_id_key','ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key'::name)`);
/** Accepted S1 and C1 migrations: both the candidate root and the N/Q1 root track them; the old
 *  root's `prisma migrate deploy` in the bootstrap records the whole history (169), so the
 *  candidate's deploy has EXACTLY C pending. Nothing about them is proven. */
export const S1_MIGRATION = '20261224000000_rls_close_public_exposure';
export const C1_MIGRATION = '20270117000000_durable_import_setup';
export const E_MIGRATION_DIR = '20270118000000_scout_ledger_platform_expand';
export const acceptedUpFile = (name: string) =>
  resolve(root, 'prisma/migrations', name, 'migration.sql');
/** Every ledger row of a scope keyed by the five-field identity, ordered as Q1 pages it. */
export const identityRows = (coach = 'coach', intent = 'intent', family?: string) =>
  json(
    `SELECT COALESCE(jsonb_agg(jsonb_build_array(entity_type,source_id,source_platform,status,target_id)
  ORDER BY entity_type,source_id,source_platform),'[]')
  FROM "ScoutReconstructionLedger" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}
  ${family ? `AND entity_type=${quote(family)}` : ''}`,
  );
/** Staged rows of a scope by identity (no harness/uuid id): (entity_type, source_id,
 *  source_platform, captured_at, payload). ScoutIngestEntity has NO status column: "still
 *  staged" means present here and absent from the ledger. */
export const stagedRows = (coach = 'coach', intent = 'intent', family?: string) =>
  json(
    `SELECT COALESCE(jsonb_agg(jsonb_build_array(entity_type,source_id,source_platform,captured_at,payload)
  ORDER BY entity_type,source_id,source_platform),'[]')
  FROM "ScoutIngestEntity" WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}
  ${family ? `AND entity_type=${quote(family)}` : ''}`,
  );
/** Groups that would collide on the NARROW keys (the identities only the wide key can hold):
 *  duplicate (c,i,s) groups in staging and duplicate (c,i,e,s) groups in the ledger, database-wide
 *  or for one intent. These are exactly the groups C.down's pre-check refuses on. */
export const narrowDuplicates = (intent?: string) => {
  const scope = intent ? `WHERE intent_id=${quote(intent)}` : '';
  return json(`SELECT jsonb_build_object(
  'staging',(SELECT count(*) FROM (SELECT 1 FROM "ScoutIngestEntity" ${scope} GROUP BY coach_id,intent_id,source_id HAVING count(*)>1) d),
  'ledger',(SELECT count(*) FROM (SELECT 1 FROM "ScoutReconstructionLedger" ${scope} GROUP BY coach_id,intent_id,entity_type,source_id HAVING count(*)>1) d))`);
};
/** One ledger row by its five-field identity, or null. */
export const ledgerRow = (
  source: string,
  platform = 'truecoach',
  family = 'clients',
  coach = 'coach',
  intent = 'intent',
) =>
  json(
    `SELECT COALESCE((SELECT to_jsonb(l) FROM "ScoutReconstructionLedger" l WHERE coach_id=${quote(coach)}
  AND intent_id=${quote(intent)} AND entity_type=${quote(family)} AND source_platform=${quote(platform)}
  AND source_id=${quote(source)}),'null')`,
  );
/** Migrations recorded as finished at or after a server timestamp (`SELECT now()`), sorted. */
export const appliedSince = (since: string): string[] =>
  json(`SELECT COALESCE(jsonb_agg(migration_name ORDER BY migration_name),'[]')
  FROM "_prisma_migrations" WHERE finished_at >= ${quote(since)}::timestamptz`);

/** Trigger + function catalog shape; '[]'/null when absent. Includes proconfig and ACL.
 *  The trigger definition is rendered under an EMPTY search_path so the text is the canonical,
 *  fully qualified form whatever the session default is; tgtype is included so BEFORE INSERT
 *  FOR EACH ROW (7) is asserted structurally as well. */
export const fence = () =>
  json(`SET search_path = '';
  SELECT jsonb_build_object(
  'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_array(tgname,tgenabled,tgtype,pg_get_triggerdef(oid)) ORDER BY tgname),'[]')
    FROM pg_trigger WHERE tgrelid='public."ScoutReconstructionLedger"'::regclass AND NOT tgisinternal),
  'function',(SELECT to_jsonb(f) FROM (SELECT proname,prosecdef,proconfig,proacl::text,provolatile,
    pg_get_functiondef(oid) def FROM pg_proc WHERE oid=to_regprocedure('public.scout_ledger_platform_fence()')) f))`);
export const nullCount = () =>
  Number(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NULL`));
export const ledgerCount = () => Number(sql(`SELECT count(*) FROM "ScoutReconstructionLedger"`));
export const stagingCount = () => Number(sql(`SELECT count(*) FROM "ScoutIngestEntity"`));
/** Every ledger column except provenance, deterministic order: the backfill's "untouched" proof. */
export const ledgerWithoutPlatform = () =>
  json(`SELECT COALESCE(jsonb_agg((to_jsonb(l) - 'source_platform')
  ORDER BY coach_id,intent_id,entity_type,source_id,id),'[]') FROM "ScoutReconstructionLedger" l`);
export const stagingSnapshot = () =>
  json(`SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY coach_id,intent_id,entity_type,source_platform,source_id,id),'[]')
  FROM "ScoutIngestEntity" s`);
/** Rows whose provenance differs from the exact staging match (never written by the backfill). */
export const disagreeing = () =>
  Number(
    sql(`SELECT count(*) FROM "ScoutReconstructionLedger" l JOIN "ScoutIngestEntity" s
  ON s.coach_id=l.coach_id AND s.intent_id=l.intent_id AND s.entity_type=l.entity_type AND s.source_id=l.source_id
  WHERE l.source_platform IS DISTINCT FROM s.source_platform`),
  );
/** Fixture shaping only: re-open provenance on existing rows (an UPDATE; the fence is INSERT-only). */
export const nullify = (where: string) =>
  Number(
    sql(`WITH c AS (UPDATE "ScoutReconstructionLedger" SET source_platform=NULL WHERE ${where} RETURNING id)
  SELECT count(*) FROM c`),
  );
export const ledgerIds = (where: string) =>
  json(
    `SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM "ScoutReconstructionLedger" WHERE ${where}`,
  );
export const platformOf = (id: string) =>
  sql(
    `SELECT COALESCE(source_platform,'<NULL>') FROM "ScoutReconstructionLedger" WHERE id=${quote(id)}`,
  );

/**
 * In-process runtime-role (service_role) client: the same generated C client the candidate ships,
 * connected exactly like the worker processes, with an application_name so lock waits are
 * observable through the accepted `blocked()` helper. Query text only is logged, never parameters.
 */
export function runtimeClient(name: string) {
  const url = new URL(
    withFixturePassword(target.prismaUrl, process.env.G2_C_PASSWORD, G2_C_RUNTIME_ROLE),
  );
  url.searchParams.set('application_name', name);
  const queries: string[] = [];
  const client = new PrismaClient({
    datasources: { db: { url: url.toString() } },
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', (e) => {
    queries.push(e.query);
  });
  return { client, queries, name };
}

/** One staged entity for the real ingest service: the envelope fields the extension sends. */
export type IngestEntity = {
  sourceId: string;
  sourcePlatform: string;
  capturedAt?: string;
  payload?: Prisma.InputJsonObject;
};
/**
 * The REAL ScoutIngestService (src/scout/scout-ingest.service.ts) on the candidate's C client
 * as service_role: `createMany({ skipDuplicates: true })` → INSERT ... ON CONFLICT DO NOTHING,
 * arbitrated by whatever unique indexes the database carries (narrow + wide before C, wide only
 * after). Analytics events are captured in memory (nothing is forwarded); the shared worker is
 * NOT modified (it has no ingest action). Returns `{ received, deduped }` exactly as the service
 * does; callers `$disconnect()` the client when done.
 */
export function ingestClient(name: string) {
  const { client, queries } = runtimeClient(name);
  const events: unknown[][] = [];
  // The accepted unit-spec construction (scout-ingest.service.spec.ts makePrisma/makeAnalytics):
  // prototype handles carrying the REAL client delegate and an in-memory capture. No banned casts.
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutIngestEntity: client.scoutIngestEntity,
  });
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture: (...args: unknown[]) => {
      events.push(args);
    },
  });
  const service = new ScoutIngestService(prisma, analytics);
  const ingest = (
    family: string,
    entities: IngestEntity[],
    intent = 'intent',
    coach = 'coach',
  ): Promise<{ received: number; deduped: number }> => {
    const dto = new ScoutIngestDto();
    dto.intent_id = intent;
    dto.entity_type = family;
    dto.entities = entities.map((e) => {
      const entity = new ScoutEntityDto();
      entity.sourceId = e.sourceId;
      entity.sourcePlatform = e.sourcePlatform;
      entity.capturedAt = e.capturedAt ?? '2026-09-24T00:00:00.000Z';
      entity.payload = e.payload ?? { name: `Synthetic ${e.sourceId}`, client_id: 'client-new' };
      return entity;
    });
    return service.ingest(coach, dto);
  };
  return { client, queries, events, ingest, name, disconnect: () => client.$disconnect() };
}
