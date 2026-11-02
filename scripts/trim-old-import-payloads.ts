/**
 * scripts/trim-old-import-payloads.ts (P3b, PRIV-04, owner decision 35)
 *
 * Rows saved before P3 (#928) still hold the full record from the other
 * platform. Rewrites each ScoutIngestEntity payload through the SAME cut new
 * rows get (`keptPayload`); never deletes a row; a re-run changes 0.
 * Operator-run only, with the owner's yes; not wired to deploy, release or CI.
 * Dry run by default (counts per platform, writes nothing). Apply needs the flag
 * AND the confirmation value, and writes one transaction per small batch.
 * Output is counts only; payload content is never printed.
 *
 *   npx ts-node scripts/trim-old-import-payloads.ts            # dry run
 *   TRIM_OLD_IMPORT_PAYLOADS_CONFIRM=trim-old-import-payloads \
 *     npx ts-node scripts/trim-old-import-payloads.ts --apply
 */
import { isDeepStrictEqual } from 'node:util';
import { PrismaClient, type Prisma } from '@prisma/client';
import { errorLabel } from '../src/checkout/error-label';
import { keptPayload, payloadKeepPlan } from '../src/scout/scout-ingest.service';

const TAG = '[trim-old-import-payloads]';
export const CONFIRM_ENV = 'TRIM_OLD_IMPORT_PAYLOADS_CONFIRM';
export const CONFIRM_VALUE = 'trim-old-import-payloads';

type Counts = { rows_scanned: number; rows_changed: number };
export type TrimResult = Counts & { mode: 'dry-run' | 'apply'; platforms: Record<string, Counts> };

/** Our own refusal; its message holds no data, so it is printed as is. */
export class TrimArgsError extends Error {}

export function parseTrimArgs(argv: readonly string[], env: NodeJS.ProcessEnv): { apply: boolean } {
  if (argv.some((a) => a !== '--apply') || argv.length > 1) {
    throw new TrimArgsError('Usage: [--apply]. Dry run is the default.');
  }
  const apply = argv.length === 1;
  if (apply && env[CONFIRM_ENV] !== CONFIRM_VALUE) {
    throw new TrimArgsError(`--apply needs ${CONFIRM_ENV}=${CONFIRM_VALUE}. Nothing was changed.`);
  }
  return { apply };
}

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const isObject = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function trimOldImportPayloads(
  prisma: PrismaClient,
  opts: { apply: boolean; batchSize?: number },
): Promise<TrimResult> {
  const plan = payloadKeepPlan();
  const take = Math.max(1, Math.min(opts.batchSize ?? 100, 1_000)); // small batches
  const total: Counts = { rows_scanned: 0, rows_changed: 0 };
  const platforms = new Map<string, Counts>();
  let cursor: string | undefined;

  const batch = async (db: Prisma.TransactionClient): Promise<string[]> => {
    const rows = await db.scoutIngestEntity.findMany({
      where: cursor === undefined ? {} : { id: { gt: cursor } },
      select: { id: true, source_platform: true, payload: true },
      orderBy: { id: 'asc' },
      take,
    });
    for (const row of rows) {
      // A platform with no mapping spec is cut to `{}`; its name is not printed.
      const label = plan.has(row.source_platform) ? row.source_platform : 'unsupported';
      const counts = platforms.get(label) ?? { rows_scanned: 0, rows_changed: 0 };
      platforms.set(label, counts);
      counts.rows_scanned++;
      total.rows_scanned++;
      const next = keptPayload(row.source_platform, isObject(row.payload) ? row.payload : {});
      // Compared as JSON values: key order and object prototypes do not count.
      if (isDeepStrictEqual(asJson(next), asJson(row.payload))) continue;
      counts.rows_changed++;
      total.rows_changed++;
      if (opts.apply) {
        await db.scoutIngestEntity.update({ where: { id: row.id }, data: { payload: next } });
      }
    }
    return rows.map((r) => r.id);
  };

  for (;;) {
    const ids = opts.apply
      ? await prisma.$transaction((tx) => batch(tx), { timeout: 60_000, maxWait: 10_000 })
      : await batch(prisma);
    if (ids.length === 0) break;
    cursor = ids[ids.length - 1];
    if (ids.length < take) break;
  }
  return {
    mode: opts.apply ? 'apply' : 'dry-run',
    ...total,
    platforms: Object.fromEntries(platforms),
  };
}

export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  prisma: PrismaClient,
  log: (line: string) => void,
): Promise<TrimResult> {
  const result = await trimOldImportPayloads(prisma, parseTrimArgs(argv, env));
  log(`${TAG} ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  parseTrimArgs(args, process.env); // refuse before opening a connection
  const prisma = new PrismaClient();
  try {
    await run(args, process.env, prisma, (line) => process.stdout.write(`${line}\n`));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const detail = err instanceof TrimArgsError ? err.message : `error=${errorLabel(err)}`;
    console.error(`${TAG} failed ${detail}`);
    process.exit(1);
  });
}
