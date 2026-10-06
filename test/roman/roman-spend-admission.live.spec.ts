/**
 * B-651-5 / B-651-4 live proof on real Postgres: the Roman daily spend
 * admission compares and reserves atomically under a per-UTC-day advisory
 * lock, so concurrent turns never both pass the cap (no overspend) and never
 * both fail when one of them fits (no double rejection).
 *
 * Runs RomanService.reserveDailySpend against a Prisma-faithful schema built
 * by the shared bootstrap helper. Gated on MWB3_TEST_DATABASE_URL (the
 * mwb-3-live-tests CI job); skipped with a logged reason elsewhere.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import { RomanCaller, RomanService } from '../../src/roman/roman.service';
import {
  ROMAN_ERROR_CAPACITY_REACHED,
  ROMAN_LEDGER_CAPABILITY,
  ROMAN_MAX_OUTPUT_TOKENS,
} from '../../src/roman/roman.constants';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('[roman-spend-admission.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.');
}

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=12`;
}

const CALLERS: RomanCaller[] = Array.from({ length: 8 }, (_, i) => ({
  id: `b651-live-${i}`,
  role: 'student',
  tier: 'free',
}));

/** Input bound whose reservation (bound + max output) costs exactly `usd`. */
function boundFor(usd: number): number {
  const outputUsd = RomanService.costUsd(0, ROMAN_MAX_OUTPUT_TOKENS);
  return Math.round(((usd - outputUsd) * 1_000_000) / 3);
}

liveDescribe('B-651-5 live: Roman spend admission is atomic per UTC day (Postgres)', () => {
  let prisma: PrismaService;
  let svc: RomanService;
  const savedCap = process.env.ROMAN_DAILY_COST_CAP_USD;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    svc = new RomanService(prisma, grantAllEgress());
    for (const c of CALLERS) {
      await prisma.user.create({
        data: {
          id: c.id,
          supabase_id: `sb-${c.id}`,
          email: `${c.id}@example.test`,
          name: 'Client',
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (savedCap === undefined) delete process.env.ROMAN_DAILY_COST_CAP_USD;
    else process.env.ROMAN_DAILY_COST_CAP_USD = savedCap;
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.aiRequestAudit.deleteMany({ where: { capability: ROMAN_LEDGER_CAPABILITY } });
  });

  async function race(n: number, bound: number) {
    return Promise.allSettled(CALLERS.slice(0, n).map((c) => svc.reserveDailySpend(c, bound)));
  }

  function capacityCode(r: PromiseSettledResult<string>): string | null {
    if (r.status !== 'rejected') return null;
    const reason: unknown = r.reason;
    if (!(reason instanceof ServiceUnavailableException)) return 'other';
    const body = reason.getResponse() as { code?: string };
    return body.code ?? 'other';
  }

  it('two concurrent turns where exactly one fits: exactly one is admitted, one row is reserved', async () => {
    // Each reservation costs 0.06; the cap 0.1 fits one, not two.
    process.env.ROMAN_DAILY_COST_CAP_USD = '0.1';
    const bound = boundFor(0.06);
    const results = await race(2, bound);
    const admitted = results.filter((r) => r.status === 'fulfilled');
    expect(admitted).toHaveLength(1);
    expect(results.map(capacityCode).filter((c) => c !== null)).toEqual([
      ROMAN_ERROR_CAPACITY_REACHED,
    ]);
    const rows = await prisma.aiRequestAudit.findMany({
      where: { capability: ROMAN_LEDGER_CAPABILITY },
    });
    expect(rows).toHaveLength(1);
    // Content-free: ids, counts and a state marker only.
    expect(rows[0].metadata).toEqual({ state: 'reserved' });
    expect(rows[0].prompt_token_estimate).toBe(bound);
  });

  it('eight concurrent turns: admitted reservations never sum above the cap, and every fitting turn is admitted', async () => {
    process.env.ROMAN_DAILY_COST_CAP_USD = '0.2';
    const bound = boundFor(0.06); // 3 fit (0.18), the 4th would be 0.24
    const results = await race(8, bound);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const agg = await prisma.aiRequestAudit.aggregate({
      where: { capability: ROMAN_LEDGER_CAPABILITY },
      _sum: { prompt_token_estimate: true, response_token_estimate: true },
    });
    const used = RomanService.costUsd(
      agg._sum.prompt_token_estimate ?? 0,
      agg._sum.response_token_estimate ?? 0,
    );
    expect(used).toBeLessThanOrEqual(0.2);
  });
});
