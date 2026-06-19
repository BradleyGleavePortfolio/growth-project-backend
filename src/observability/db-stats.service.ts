import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';

/** Maximum number of statements returned by /admin/db-stats. */
export const DB_STATS_TOP_N = 20;

/** Number of leading query characters retained in the redacted view. */
export const DB_STATS_QUERY_PREVIEW_CHARS = 200;

/** Raw row shape returned by the pg_stat_statements query. */
export interface RawStatementRow {
  query: string;
  calls: number | bigint;
  total_exec_time: number;
  mean_exec_time: number;
  rows: number | bigint;
}

/** Sanitised statement entry returned to the caller (no raw literals). */
export interface DbStatementStat {
  queryPreview: string;
  queryHash: string;
  truncated: boolean;
  calls: number;
  totalExecTimeMs: number;
  meanExecTimeMs: number;
  rows: number;
}

/**
 * Redact a raw SQL statement to a bounded preview plus a sha256 of the full
 * text. The preview keeps the statement shape visible for triage; the hash
 * lets the statement be recognised across scrapes without shipping inlined
 * literals (emails, ids) that count as PII.
 */
export function redactStatement(query: string): {
  queryPreview: string;
  queryHash: string;
  truncated: boolean;
} {
  const normalised = (query ?? '').replace(/\s+/g, ' ').trim();
  const truncated = normalised.length > DB_STATS_QUERY_PREVIEW_CHARS;
  const queryPreview = truncated
    ? normalised.slice(0, DB_STATS_QUERY_PREVIEW_CHARS)
    : normalised;
  const queryHash = createHash('sha256').update(normalised).digest('hex');
  return { queryPreview, queryHash, truncated };
}

/** Coerce a Postgres bigint/number column into a JS number safely. */
function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * DbStatsService — reads the top-N slowest statements from pg_stat_statements
 * (enabled by the H3 migration) for the bearer-gated /admin/db-stats endpoint.
 * The extension is operator-attach; when absent the helper degrades gracefully
 * (SQLSTATE 42P01 / 42704 → `available: false` instead of a 500).
 */
@Injectable()
export class DbStatsService {
  private readonly logger = new Logger(DbStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param topN number of statements to return, ordered by total_exec_time DESC.
   * @returns `available:false` with a reason when pg_stat_statements is not
   *          installed, otherwise the redacted top-N statements.
   */
  async topStatements(
    topN: number = DB_STATS_TOP_N,
  ): Promise<
    | { available: true; statements: DbStatementStat[] }
    | { available: false; reason: string }
  > {
    const limit = Math.max(1, Math.min(100, Math.floor(topN)));
    try {
      const rows = await this.prisma.$queryRaw<RawStatementRow[]>`
        SELECT query,
               calls,
               total_exec_time,
               mean_exec_time,
               rows
          FROM pg_stat_statements
         ORDER BY total_exec_time DESC
         LIMIT ${limit}
      `;

      const statements = rows.map((row): DbStatementStat => {
        const { queryPreview, queryHash, truncated } = redactStatement(row.query);
        return {
          queryPreview,
          queryHash,
          truncated,
          calls: toNumber(row.calls),
          totalExecTimeMs: Number(row.total_exec_time),
          meanExecTimeMs: Number(row.mean_exec_time),
          rows: toNumber(row.rows),
        };
      });

      return { available: true, statements };
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      // 42P01 undefined_table, 42704 undefined_object → extension not installed.
      if (code === '42P01' || code === '42704' || /pg_stat_statements/i.test(message)) {
        this.logger.warn(
          'pg_stat_statements is not available; returning unavailable. Enable the extension (operator-attach).',
        );
        return {
          available: false,
          reason:
            'pg_stat_statements extension is not enabled. Run the H3 migration and restart Postgres (operator-attach).',
        };
      }
      throw err;
    }
  }
}
