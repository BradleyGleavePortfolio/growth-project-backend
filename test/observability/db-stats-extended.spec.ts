/**
 * Extended db-stats tests — exercises ordering preservation, empty results,
 * numeric coercion edge cases, redaction hashing stability, and the clamp
 * floor. Complements db-stats.spec.ts.
 */

import {
  DbStatsService,
  redactStatement,
  DB_STATS_TOP_N,
  DB_STATS_QUERY_PREVIEW_CHARS,
} from '../../src/observability/db-stats.service';
import { PrismaService } from '../../src/prisma.service';

/**
 * The service only ever touches `prisma.$queryRaw`. We build a real
 * PrismaService instance and override that single method with a jest spy so
 * the double is a genuine PrismaService (no structural cast needed).
 */
function makePrisma(impl: jest.Mock): PrismaService {
  const prisma = new PrismaService();
  jest.spyOn(prisma, '$queryRaw').mockImplementation(impl);
  return prisma;
}

describe('db-stats constants', () => {
  it('defaults to top 20 statements', () => {
    expect(DB_STATS_TOP_N).toBe(20);
  });
  it('previews the first 200 characters', () => {
    expect(DB_STATS_QUERY_PREVIEW_CHARS).toBe(200);
  });
});

describe('redactStatement edge cases', () => {
  it('handles an empty string', () => {
    const r = redactStatement('');
    expect(r.queryPreview).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.queryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a query exactly at the limit as not truncated', () => {
    const exact = 'a'.repeat(DB_STATS_QUERY_PREVIEW_CHARS);
    const r = redactStatement(exact);
    expect(r.truncated).toBe(false);
    expect(r.queryPreview.length).toBe(DB_STATS_QUERY_PREVIEW_CHARS);
  });

  it('treats a query one char over the limit as truncated', () => {
    const over = 'a'.repeat(DB_STATS_QUERY_PREVIEW_CHARS + 1);
    const r = redactStatement(over);
    expect(r.truncated).toBe(true);
  });

  it('strips leading/trailing whitespace before hashing', () => {
    expect(redactStatement('  SELECT 1  ').queryHash).toBe(redactStatement('SELECT 1').queryHash);
  });
});

describe('DbStatsService.topStatements — data handling', () => {
  it('returns an empty statement list when pg_stat_statements has no rows', async () => {
    const svc = new DbStatsService(makePrisma(jest.fn().mockResolvedValue([])));
    const result = await svc.topStatements();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.statements).toEqual([]);
  });

  it('preserves the order returned by the query (total_exec_time DESC)', async () => {
    const rows = [
      { query: 'SELECT slow', calls: 1n, total_exec_time: 999, mean_exec_time: 999, rows: 1n },
      { query: 'SELECT mid', calls: 2n, total_exec_time: 500, mean_exec_time: 250, rows: 2n },
      { query: 'SELECT fast', calls: 3n, total_exec_time: 10, mean_exec_time: 3.3, rows: 3n },
    ];
    const svc = new DbStatsService(makePrisma(jest.fn().mockResolvedValue(rows)));
    const result = await svc.topStatements();
    if (!result.available) throw new Error('expected available');
    expect(result.statements.map((s) => s.totalExecTimeMs)).toEqual([999, 500, 10]);
  });

  it('coerces plain-number columns as well as bigints', async () => {
    const rows = [
      { query: 'SELECT 1', calls: 7, total_exec_time: 1.5, mean_exec_time: 1.5, rows: 7 },
    ];
    const svc = new DbStatsService(makePrisma(jest.fn().mockResolvedValue(rows)));
    const result = await svc.topStatements();
    if (!result.available) throw new Error('expected available');
    expect(result.statements[0].calls).toBe(7);
    expect(result.statements[0].rows).toBe(7);
  });

  it('clamps a zero/negative topN up to the floor of 1', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const svc = new DbStatsService(makePrisma(queryRaw));
    await svc.topStatements(0);
    const values = queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(1);
  });

  it('floors a fractional topN', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const svc = new DbStatsService(makePrisma(queryRaw));
    await svc.topStatements(5.9);
    const values = queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(5);
  });

  it('redacts query text in the mapped output (preview + hash)', async () => {
    // A long list of distinct identifiers keeps the redacted text over the
    // preview cap (literal-masking collapses quoted runs, so use identifiers,
    // not repeated string literals, to exercise truncation).
    const columns = Array.from({ length: 100 }, (_, i) => `col_${i}`).join(', ');
    const longQuery = `SELECT ${columns} FROM "User" WHERE email = 'x@y.z'`;
    const rows = [{ query: longQuery, calls: 1n, total_exec_time: 1, mean_exec_time: 1, rows: 0n }];
    const svc = new DbStatsService(makePrisma(jest.fn().mockResolvedValue(rows)));
    const result = await svc.topStatements();
    if (!result.available) throw new Error('expected available');
    expect(result.statements[0].truncated).toBe(true);
    expect(result.statements[0].queryPreview.length).toBe(DB_STATS_QUERY_PREVIEW_CHARS);
    expect(result.statements[0].queryHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
