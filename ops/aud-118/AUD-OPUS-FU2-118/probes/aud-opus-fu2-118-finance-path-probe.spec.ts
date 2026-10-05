/**
 * AUD-OPUS-FU2-118 probe (Claude Opus 5.5 lens, agent 118) on #700 @ 66569a61.
 * Not for merge. #700 moved practice-type.service.ts:107 off the coach email,
 * but the same federation call logs its URL path, which carries the address
 * (encodeURIComponent(email)), on every degraded outcome
 * (finance-admin.client.ts:166-167; paths at :65, :73, :93).
 * Expected at the PR head: FAIL (the encoded address reaches a log line).
 */
import { Logger } from '@nestjs/common';
import { FinanceAdminClient } from '../../src/admin/federation/finance-admin.client';

const ADDRESS = 'pat.client+tgp@example.com';
const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

class Http400Client extends FinanceAdminClient {
  protected fetchImpl: typeof fetch = async () =>
    ({ ok: false, status: 400, json: async () => ({}), text: async () => '' }) as unknown as Response;
}

const saved = { base: process.env.FINANCE_API_BASE_URL, token: process.env.FINANCE_SERVICE_TOKEN };
afterEach(() => {
  jest.restoreAllMocks();
  process.env.FINANCE_API_BASE_URL = saved.base;
  process.env.FINANCE_SERVICE_TOKEN = saved.token;
});

describe('AUD-OPUS-FU2-118 probe: finance federation degraded log line and the coach address', () => {
  it('no log line holds the address, encoded or not', async () => {
    process.env.FINANCE_API_BASE_URL = 'https://finance.example.test';
    process.env.FINANCE_SERVICE_TOKEN = 'svc-token';
    const spies = LEVELS.map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const outcome = await new Http400Client().setCoachPracticeByEmail(ADDRESS, 'both');
    expect(outcome.kind).toBe('degraded');
    const lines = spies.flatMap((spy) => spy.mock.calls.map((args: unknown[]) => args.map(String).join(' ')));
    expect(lines.join('\n')).toContain('Finance federation degraded');
    for (const line of lines) {
      expect(line).not.toContain('pat.client');
      expect(line).not.toMatch(/%40|@/);
    }
  });
});
