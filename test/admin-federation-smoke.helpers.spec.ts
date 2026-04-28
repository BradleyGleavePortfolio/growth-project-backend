import {
  FINANCE_OK_STATUSES,
  redactId,
} from '../scripts/admin-federation-smoke.helpers';

// These helpers back the OWNER-only admin/federation smoke script. Their
// contract is small but load-bearing: the FINANCE_OK_STATUSES set must
// stay in lock-step with FinanceFederationStatus in
// src/admin/console/finance-federation.service.ts (otherwise the smoke
// fails on a perfectly healthy "degraded" or "not_configured" response),
// and redactId must never accidentally leak full ids into operator logs.

describe('admin-federation smoke helpers', () => {
  describe('FINANCE_OK_STATUSES', () => {
    it('matches the FinanceFederationStatus union exactly', () => {
      // Mirrors the literal union in finance-federation.service.ts. Any
      // change to that union without a corresponding change here is a
      // smoke-script bug — surface it in this test, not in production.
      expect([...FINANCE_OK_STATUSES].sort()).toEqual(
        ['auth_unconfigured', 'degraded', 'not_configured', 'not_found', 'ok'],
      );
    });

    it('rejects values that are not in the union', () => {
      expect(FINANCE_OK_STATUSES.has('healthy')).toBe(false);
      expect(FINANCE_OK_STATUSES.has('')).toBe(false);
      expect(FINANCE_OK_STATUSES.has('UNKNOWN')).toBe(false);
    });
  });

  describe('redactId', () => {
    it('returns "<unset>" for empty input', () => {
      expect(redactId('')).toBe('<unset>');
    });

    it('redacts long ids to prefix…suffix', () => {
      const id = '7c1f4e2a-aaaa-bbbb-cccc-9d0e1f2a3b4c';
      const out = redactId(id);
      expect(out).not.toContain('aaaa');
      expect(out).not.toContain('bbbb');
      expect(out.startsWith('7c1f')).toBe(true);
      expect(out.endsWith('3b4c')).toBe(true);
      expect(out).toContain('…');
    });

    it('redacts short ids without crashing', () => {
      const out = redactId('abc');
      expect(out).toContain('a');
      expect(out).toContain('c');
      expect(out).toContain('…');
    });

    it('returns the full id when verbose=true', () => {
      const id = '7c1f4e2a-aaaa-bbbb-cccc-9d0e1f2a3b4c';
      expect(redactId(id, true)).toBe(id);
    });
  });
});
