import { Prisma } from '@prisma/client';
import { isCanonicalPlatform } from './scout-platform';

/**
 * G2-B — bounded, resumable, unambiguous backfill of ScoutReconstructionLedger
 * .source_platform (nullable since E) from the exact staging row, plus the drain
 * verdict that R depends on. Operator-invoked only (see the .cli.ts entry); not
 * an HTTP endpoint, not SECURITY DEFINER, no trigger-side inference.
 *
 * Contract (recovered from the accepted rollout design, RECOVERY_SEQUENCING /
 * CYCLE3 B stage):
 *  - Resolve ONLY an exact coach_id + intent_id + entity_type + source_id match
 *    with exactly one staging row whose platform token is canonical. The narrow
 *    staging key guarantees at most one match, never that one exists.
 *  - Update NULL provenance only. Never touch a populated value, never derive a
 *    default, never write "unknown" that was not literally staged, never delete
 *    or re-status a row. A populated value that disagrees with staging is
 *    counted (`mismatch`) and left alone.
 *  - Bounded: each chunk is one transaction with lock_timeout/statement_timeout,
 *    a SHARE lock on staging (freezes source mutation for that chunk only) and
 *    `ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED` on the NULL candidates.
 *  - Resumable: a pass walks the id order once; a run repeats passes until a pass
 *    updates nothing, so a row skipped while locked is revisited rather than
 *    permanently missed. Interrupting between chunks loses nothing; rerunning is
 *    idempotent.
 *  - Honest: zero updated rows with NULL rows remaining is STOP, not completion.
 *    `drained` is reported only when no NULL remains AND the obsolete-writer
 *    fence (migration 20270119000000) is installed; without the fence an O
 *    restart can re-create NULL rows, so completion is `complete_unfenced`.
 */
export const BACKFILL_DEFAULT_BATCH = 500;
export const BACKFILL_MAX_BATCH = 2000;
export const BACKFILL_DEFAULT_PASSES = 3;
export const BACKFILL_MAX_PASSES = 10;
export const BACKFILL_DEFAULT_LOCK_RETRIES = 2;
export const BACKFILL_CHUNK_TIMEOUT_MS = 45_000;
/**
 * Canonical rendering of the fence trigger under an EMPTY search_path. `pg_get_triggerdef` omits
 * the function's schema whenever the session search_path makes it visible, so this literal is
 * documentation and a test oracle (rendered with `search_path = ''`), never the runtime detector.
 */
export const FENCE_TRIGGER_DEFINITION =
  'CREATE TRIGGER "ScoutReconstructionLedger_platform_fence" BEFORE INSERT ON public."ScoutReconstructionLedger" FOR EACH ROW EXECUTE FUNCTION public.scout_ledger_platform_fence()';
/** pg_trigger.tgtype bits ROW (1) | BEFORE (2) | INSERT (4): the only shape the fence may have. */
export const FENCE_TRIGGER_TYPE = 7;

/** Minimal raw-SQL surface; PrismaClient and its interactive transaction client satisfy it. */
export interface BackfillTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export interface BackfillClient extends BackfillTx {
  $transaction<T>(
    fn: (tx: BackfillTx) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export type BackfillOptions = { batch?: number; maxPasses?: number; lockRetries?: number };
export type Candidate = { id: string; matches: number; platform: string | null };
export type Classified = {
  resolvable: string[];
  orphan: number;
  invalid: number;
  ambiguous: number;
};
export type PassReport = {
  chunks: number;
  examined: number;
  updated: number;
  orphan: number;
  invalid: number;
  ambiguous: number;
  lockFailures: number;
  stalledByLocks: boolean;
};
export type Outcome = 'drained' | 'complete_unfenced' | 'unresolved' | 'stalled';
export type BackfillReport = {
  batch: number;
  ledgerTotal: number;
  nullBefore: number;
  nullAfter: number;
  mismatch: number;
  fenced: boolean;
  passes: PassReport[];
  unresolved: { orphan: number; invalid: number; ambiguous: number };
  outcome: Outcome;
};

/** Chunk integrity: the locked resolvable set and the updated set must be identical. */
export class BackfillIntegrityError extends Error {
  constructor(expected: number, updated: number) {
    super(`G2-B backfill chunk integrity failure: expected ${expected} updates, got ${updated}`);
    this.name = 'BackfillIntegrityError';
  }
}

export function classify(candidates: Candidate[]): Classified {
  const result: Classified = { resolvable: [], orphan: 0, invalid: 0, ambiguous: 0 };
  for (const c of candidates) {
    if (c.matches === 0) result.orphan += 1;
    else if (c.matches > 1) result.ambiguous += 1;
    else if (!isCanonicalPlatform(c.platform)) result.invalid += 1;
    else result.resolvable.push(c.id);
  }
  return result;
}

export function decideOutcome(
  nullAfter: number,
  fenced: boolean,
  unresolved: { orphan: number; invalid: number; ambiguous: number },
): Outcome {
  if (nullAfter === 0) return fenced ? 'drained' : 'complete_unfenced';
  const explained = unresolved.orphan + unresolved.invalid + unresolved.ambiguous;
  return nullAfter === explained ? 'unresolved' : 'stalled';
}

/** lock_not_available (55P03) or query_canceled (57014) surfaced through Prisma's raw error. */
export function isLockOrStatementTimeout(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /55P03|57014|lock timeout|statement timeout/i.test(message);
}

function bounded(value: number | undefined, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`G2-B backfill option out of range (${min}..${max})`);
  }
  return value;
}

async function runChunk(
  prisma: BackfillClient,
  after: string,
  batch: number,
): Promise<{ candidates: Candidate[]; classified: Classified; updated: number }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '30s'`;
      // Freeze staging mutation for this chunk so the exact join cannot change under us.
      await tx.$executeRaw`LOCK TABLE public."ScoutIngestEntity" IN SHARE MODE`;
      const candidates = await tx.$queryRaw<Candidate[]>`
        SELECT l.id, s.matches, s.platform
        FROM (
          SELECT id, coach_id, intent_id, entity_type, source_id
          FROM public."ScoutReconstructionLedger"
          WHERE source_platform IS NULL AND id > ${after}
          ORDER BY id
          LIMIT ${batch}::int
          FOR UPDATE SKIP LOCKED
        ) l
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS matches, min(s.source_platform) AS platform
          FROM public."ScoutIngestEntity" s
          WHERE s.coach_id = l.coach_id AND s.intent_id = l.intent_id
            AND s.entity_type = l.entity_type AND s.source_id = l.source_id
        ) s
        ORDER BY l.id`;
      const classified = classify(candidates);
      let updated = 0;
      if (classified.resolvable.length > 0) {
        // Re-join to staging under the same SHARE lock: the written value is exactly
        // the staged value, never a client-side copy. NULL-only, id-bounded.
        updated = await tx.$executeRaw`
          UPDATE public."ScoutReconstructionLedger" l
          SET source_platform = s.source_platform
          FROM public."ScoutIngestEntity" s
          WHERE l.id IN (${Prisma.join(classified.resolvable)})
            AND l.source_platform IS NULL
            AND s.coach_id = l.coach_id AND s.intent_id = l.intent_id
            AND s.entity_type = l.entity_type AND s.source_id = l.source_id`;
        if (updated !== classified.resolvable.length) {
          throw new BackfillIntegrityError(classified.resolvable.length, updated);
        }
      }
      return { candidates, classified, updated };
    },
    { maxWait: 10_000, timeout: BACKFILL_CHUNK_TIMEOUT_MS },
  );
}

async function runPass(
  prisma: BackfillClient,
  batch: number,
  lockRetries: number,
): Promise<PassReport> {
  const pass: PassReport = {
    chunks: 0,
    examined: 0,
    updated: 0,
    orphan: 0,
    invalid: 0,
    ambiguous: 0,
    lockFailures: 0,
    stalledByLocks: false,
  };
  let after = '';
  for (;;) {
    let chunk: Awaited<ReturnType<typeof runChunk>> | undefined;
    for (let attempt = 0; attempt <= lockRetries && chunk === undefined; attempt++) {
      try {
        chunk = await runChunk(prisma, after, batch);
      } catch (err) {
        if (!isLockOrStatementTimeout(err)) throw err;
        pass.lockFailures += 1;
      }
    }
    if (chunk === undefined) {
      pass.stalledByLocks = true;
      return pass;
    }
    pass.chunks += 1;
    pass.examined += chunk.candidates.length;
    pass.updated += chunk.updated;
    pass.orphan += chunk.classified.orphan;
    pass.invalid += chunk.classified.invalid;
    pass.ambiguous += chunk.classified.ambiguous;
    if (chunk.candidates.length < batch) return pass;
    after = chunk.candidates[chunk.candidates.length - 1].id;
  }
}

type Counts = { total: number; nulls: number };

export async function readDrainState(
  prisma: BackfillTx,
): Promise<{ ledgerTotal: number; nulls: number; mismatch: number; fenced: boolean }> {
  const [counts] = await prisma.$queryRaw<Counts[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE source_platform IS NULL)::int AS nulls
    FROM public."ScoutReconstructionLedger"`;
  const [{ mismatch }] = await prisma.$queryRaw<{ mismatch: number }[]>`
    SELECT count(*)::int AS mismatch
    FROM public."ScoutReconstructionLedger" l
    JOIN public."ScoutIngestEntity" s
      ON s.coach_id = l.coach_id AND s.intent_id = l.intent_id
     AND s.entity_type = l.entity_type AND s.source_id = l.source_id
    WHERE l.source_platform IS NOT NULL AND l.source_platform <> s.source_platform`;
  // Structural, search_path-independent identity: exact table, trigger name, function
  // (public.scout_ledger_platform_fence(), zero arguments), BEFORE INSERT FOR EACH ROW, no WHEN
  // clause, no column list, no arguments, not a constraint trigger, not disabled. A genuinely
  // absent fence yields 0 (plain joins; nothing throws before B exists).
  const [{ fences }] = await prisma.$queryRaw<{ fences: number }[]>`
    SELECT count(*)::int AS fences
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
    WHERE cn.nspname = 'public' AND c.relname = 'ScoutReconstructionLedger'
      AND t.tgname = 'ScoutReconstructionLedger_platform_fence'
      AND pn.nspname = 'public' AND p.proname = 'scout_ledger_platform_fence' AND p.pronargs = 0
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgtype = ${FENCE_TRIGGER_TYPE}::int2 AND t.tgqual IS NULL
      AND t.tgattr::int2[] = '{}'::int2[] AND t.tgnargs = 0 AND t.tgconstraint = 0`;
  return { ledgerTotal: counts.total, nulls: counts.nulls, mismatch, fenced: fences === 1 };
}

export async function backfillLedgerPlatform(
  prisma: BackfillClient,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const batch = bounded(options.batch, BACKFILL_DEFAULT_BATCH, BACKFILL_MAX_BATCH);
  const maxPasses = bounded(options.maxPasses, BACKFILL_DEFAULT_PASSES, BACKFILL_MAX_PASSES);
  const lockRetries = bounded(options.lockRetries, BACKFILL_DEFAULT_LOCK_RETRIES, 10, 0);

  const before = await readDrainState(prisma);
  const passes: PassReport[] = [];
  let unresolved = { orphan: 0, invalid: 0, ambiguous: 0 };
  for (let n = 0; n < maxPasses; n++) {
    const pass = await runPass(prisma, batch, lockRetries);
    passes.push(pass);
    unresolved = { orphan: pass.orphan, invalid: pass.invalid, ambiguous: pass.ambiguous };
    // No progress means STOP: every remaining NULL row is either unresolvable
    // (reported) or locked (stalled). Another identical pass would prove nothing.
    if (pass.stalledByLocks || pass.examined === 0 || pass.updated === 0) break;
  }
  const after = await readDrainState(prisma);
  return {
    batch,
    ledgerTotal: after.ledgerTotal,
    nullBefore: before.nulls,
    nullAfter: after.nulls,
    mismatch: after.mismatch,
    fenced: after.fenced,
    passes,
    unresolved,
    outcome: decideOutcome(after.nulls, after.fenced, unresolved),
  };
}

/** Process exit code for the operator entry: only a fenced, NULL-free ledger is 0. */
export function exitCodeFor(outcome: Outcome): number {
  switch (outcome) {
    case 'drained':
      return 0;
    case 'complete_unfenced':
      return 4;
    case 'unresolved':
      return 2;
    case 'stalled':
      return 3;
  }
}
