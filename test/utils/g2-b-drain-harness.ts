/**
 * G2-B live-proof helpers layered on the B-only derivative (test/utils/g2-b-drain-pg-harness.ts)
 * of the accepted S5 harness (test/utils/g2-pg17-harness.ts, unchanged).
 * Adds only what the B/drain stage needs: the B migration files, the accepted predecessor
 * migration files (fixture history only, never re-proven), fence/catalog observation,
 * NULL-provenance fixture shaping (UPDATE only: the fence blocks NULL INSERTs by design) and an
 * in-process runtime-role Prisma client whose query log is captured for shape assertions.
 * Imported only by the explicitly guarded test/rls-g2-b-drain.spec.ts.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { json, quote, root, sql, target } from './g2-b-drain-pg-harness';
import { G2_B_RUNTIME_ROLE, withFixturePassword } from './g2-b-drain-db';

export const B_MIGRATION = '20270119000000_scout_ledger_obsolete_writer_fence';
export const bDir = resolve(root, 'prisma/migrations', B_MIGRATION);
export const bUpFile = resolve(bDir, 'migration.sql');
export const bDownFile = resolve(bDir, 'down.sql');
export const bUp = readFileSync(bUpFile, 'utf8');
export const bDown = readFileSync(bDownFile, 'utf8');
/** Accepted S1 and C1 migrations: this candidate root tracks them, the O root does not. The
 *  fixture applies their shipped SQL by file and records them (the same path stage 1 uses for E)
 *  purely so that `prisma migrate deploy` later has exactly B pending; nothing about them is proven. */
export const S1_MIGRATION = '20261224000000_rls_close_public_exposure';
export const C1_MIGRATION = '20270117000000_durable_import_setup';
export const acceptedUpFile = (name: string) =>
  resolve(root, 'prisma/migrations', name, 'migration.sql');
/** Migrations recorded as finished at or after a server timestamp (`SELECT now()`), sorted. */
export const appliedSince = (since: string): string[] =>
  json(`SELECT COALESCE(jsonb_agg(migration_name ORDER BY migration_name),'[]')
  FROM "_prisma_migrations" WHERE finished_at >= ${quote(since)}::timestamptz`);

/** Trigger + function catalog shape; '[]'/null when absent. Includes proconfig and ACL.
 *  The trigger definition is rendered under an EMPTY search_path so the text is the canonical,
 *  fully qualified form (FENCE_TRIGGER_DEFINITION) whatever the session default is; tgtype is
 *  included so BEFORE INSERT FOR EACH ROW (7) is asserted structurally as well. */
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
/** Every ledger column except provenance, deterministic order: the backfill's "untouched" proof. */
export const ledgerWithoutPlatform = () =>
  json(`SELECT COALESCE(jsonb_agg((to_jsonb(l) - 'source_platform')
  ORDER BY coach_id,intent_id,entity_type,source_id,id),'[]') FROM "ScoutReconstructionLedger" l`);
export const stagingSnapshot = () =>
  json(`SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY coach_id,intent_id,source_id,id),'[]')
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
 * In-process runtime-role (service_role) client: the same generated T client the product ships,
 * connected exactly like the worker processes, with an application_name so lock waits are
 * observable through the accepted `blocked()` helper. Query text only is logged, never parameters.
 */
export function runtimeClient(name: string) {
  const url = new URL(
    withFixturePassword(target.prismaUrl, process.env.G2_B_PASSWORD, G2_B_RUNTIME_ROLE),
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
