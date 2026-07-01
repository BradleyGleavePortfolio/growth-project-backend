/**
 * DbStatsService + DbStatsController tests.
 *
 * Covers:
 *  1. redactStatement — short query is preserved verbatim, not truncated
 *  2. redactStatement — long query is truncated to 200 chars + flagged
 *  3. redactStatement — whitespace is normalised
 *  4. redactStatement — hash is stable for identical normalised text
 *  5. redactStatement — hash differs for different text
 *  5b. redactStatement — masks dollar-quoted literals ($$body$$ / $tag$body$tag$)
 *  6. topStatements — maps rows, coerces bigints, redacts query text
 *  7. topStatements — clamps the requested topN into [1,100]
 *  8. topStatements — returns available:false when extension missing (42P01)
 *  9. topStatements — returns available:false on pg_stat_statements message
 * 10. topStatements — rethrows unexpected errors
 * 11. controller — returns generatedAt + available payload
 * 12. controller — surfaces unavailable result unchanged
 */

import {
  DbStatsService,
  redactStatement,
  DB_STATS_QUERY_PREVIEW_CHARS,
} from '../../src/observability/db-stats.service';
import { DbStatsController } from '../../src/observability/db-stats.controller';
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

describe('redactStatement', () => {
  it('preserves a short query verbatim and does not flag truncation', () => {
    const r = redactStatement('SELECT 1');
    expect(r.queryPreview).toBe('SELECT 1');
    expect(r.truncated).toBe(false);
  });

  it('truncates a long query to the preview length and flags it', () => {
    const long = 'SELECT ' + 'a'.repeat(500);
    const r = redactStatement(long);
    expect(r.queryPreview.length).toBe(DB_STATS_QUERY_PREVIEW_CHARS);
    expect(r.truncated).toBe(true);
  });

  it('normalises runs of whitespace to single spaces', () => {
    const r = redactStatement('SELECT\n   a,\t b\n FROM   t');
    expect(r.queryPreview).toBe('SELECT a, b FROM t');
  });

  it('produces a stable hash for identical normalised text', () => {
    expect(redactStatement('SELECT 1').queryHash).toBe(redactStatement('SELECT   1').queryHash);
  });

  it('produces different hashes for different text', () => {
    expect(redactStatement('SELECT 1').queryHash).not.toBe(redactStatement('SELECT 2').queryHash);
  });

  it('masks quoted and numeric literals so bound values never reach the preview', () => {
    const raw = "SELECT * FROM users WHERE email = 'foo@bar.com' AND id = 12345";
    const r = redactStatement(raw);
    // The single-quoted email literal is collapsed to '?' ...
    expect(r.queryPreview).not.toContain('foo@bar.com');
    expect(r.queryPreview).toContain("email = '?'");
    // ... and the multi-digit id literal is collapsed to ?.
    expect(r.queryPreview).not.toContain('12345');
    expect(r.queryPreview).toContain('id = ?');
  });

  it('masks double-quoted literals while leaving single-digit aliases intact', () => {
    const r = redactStatement('SELECT t1.a FROM users AS t1 WHERE name = "secret"');
    expect(r.queryPreview).not.toContain('secret');
    expect(r.queryPreview).toContain('"?"');
    // A lone single digit (alias suffix t1) is preserved.
    expect(r.queryPreview).toContain('t1');
  });

  it('masks anonymous dollar-quoted literals ($$body$$)', () => {
    const r = redactStatement('SELECT * FROM users WHERE bio = $$secret@example.com$$');
    // The dollar-quoted body must not reach the preview ...
    expect(r.queryPreview).not.toContain('secret@example.com');
    // ... and the whole literal collapses to the $?$ placeholder.
    expect(r.queryPreview).toContain('bio = $?$');
  });

  it('masks tag-delimited dollar-quoted literals ($tag$body$tag$)', () => {
    const r = redactStatement('SELECT * FROM logs WHERE msg = $tag$my-secret$tag$');
    expect(r.queryPreview).not.toContain('my-secret');
    expect(r.queryPreview).toContain('msg = $?$');
    // The tag itself is part of the delimiter and must not leak either.
    expect(r.queryPreview).not.toContain('$tag$');
  });
});

describe('DbStatsService.topStatements', () => {
  it('maps rows, coerces bigints, and redacts query text', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        query: 'SELECT * FROM "User" WHERE email = $1',
        calls: 10n,
        total_exec_time: 1234.5,
        mean_exec_time: 123.45,
        rows: 10n,
      },
    ]);
    const svc = new DbStatsService(makePrisma(queryRaw));
    const result = await svc.topStatements();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.statements).toHaveLength(1);
    const stat = result.statements[0];
    expect(stat.calls).toBe(10);
    expect(stat.rows).toBe(10);
    expect(stat.totalExecTimeMs).toBeCloseTo(1234.5);
    // The double-quoted identifier is masked by the literal redactor; the
    // statement shape (SELECT ... FROM ... WHERE email = $1) is preserved.
    expect(stat.queryPreview).toContain('SELECT * FROM "?" WHERE email = $1');
    expect(stat.queryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clamps the requested topN into [1,100]', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const svc = new DbStatsService(makePrisma(queryRaw));
    await svc.topStatements(9999);
    // Tagged-template call: $queryRaw`...${limit}` → (strings, ...values).
    // The clamped LIMIT (100) is passed as the first interpolated value.
    const interpolatedValues = queryRaw.mock.calls[0].slice(1);
    expect(interpolatedValues).toContain(100);
  });

  it('returns available:false when the extension table is missing (42P01)', async () => {
    const queryRaw = jest.fn().mockRejectedValue(
      Object.assign(new Error('relation "pg_stat_statements" does not exist'), {
        code: '42P01',
      }),
    );
    const svc = new DbStatsService(makePrisma(queryRaw));
    const result = await svc.topStatements();
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/pg_stat_statements/);
  });

  it('returns available:false when the error mentions pg_stat_statements', async () => {
    const queryRaw = jest
      .fn()
      .mockRejectedValue(new Error('extension pg_stat_statements not loaded'));
    const svc = new DbStatsService(makePrisma(queryRaw));
    const result = await svc.topStatements();
    expect(result.available).toBe(false);
  });

  it('rethrows unexpected errors', async () => {
    const queryRaw = jest.fn().mockRejectedValue(new Error('connection refused'));
    const svc = new DbStatsService(makePrisma(queryRaw));
    await expect(svc.topStatements()).rejects.toThrow('connection refused');
  });
});

describe('DbStatsController', () => {
  it('returns generatedAt plus the available payload', async () => {
    const svc = new DbStatsService(makePrisma(jest.fn()));
    jest.spyOn(svc, 'topStatements').mockResolvedValue({ available: true, statements: [] });
    const controller = new DbStatsController(svc);
    const body = await controller.dbStatsTop();
    expect(body.available).toBe(true);
    expect(typeof body.generatedAt).toBe('string');
  });

  it('surfaces an unavailable result unchanged', async () => {
    const svc = new DbStatsService(makePrisma(jest.fn()));
    jest.spyOn(svc, 'topStatements').mockResolvedValue({ available: false, reason: 'not enabled' });
    const controller = new DbStatsController(svc);
    const body = await controller.dbStatsTop();
    expect(body.available).toBe(false);
  });
});
