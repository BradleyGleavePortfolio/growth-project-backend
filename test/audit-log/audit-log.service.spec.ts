/**
 * H6 — AuditLogService.withAuditLog() unit specs (D-H6-5 LOCKED).
 *
 * Covers the four contractual behaviours of the same-transaction audit
 * substrate:
 *
 *   1. Success — fn runs, one audit_log row is written in the SAME tx, the
 *      fn result is returned.
 *   2. Audit-insert failure with the valve OFF — the error propagates so the
 *      enclosing $transaction rolls back (the PII mutation does not commit
 *      without its audit row; double-entry bookkeeping).
 *   3. AUDIT_LOG_FAIL_OPEN=1 — the audit-insert failure is swallowed and the
 *      fn result is returned anyway (operator break-glass).
 *   4. Idempotency / same-tx wiring — the audit row is written with the SAME
 *      transaction client handed to fn, and the PII write + audit write share
 *      one $transaction.
 *
 * The Prisma double runs the $transaction callback against a stub tx client
 * (the same pattern src/regimes/__tests__/partial-refund-decision.service.spec
 * uses), so the test exercises the real control flow without a database.
 */

import { AuditLogService } from '../../src/audit-log/audit-log.service';
import { ERASURE_TOKEN } from '../../src/audit-log/erasure-token';
import type { AuditLogContext } from '../../src/audit-log/audit-log.types';
import { asPrismaDouble } from './prisma-test-double';

// Build a Prisma double whose $transaction(cb) invokes cb against a tx client
// carrying a jest-mocked auditLogEntry.create. The same tx object is passed to
// fn and used for the audit write, so the spec can assert same-tx wiring.
function makePrisma(auditCreate: jest.Mock) {
  const tx = { auditLogEntry: { create: auditCreate } };
  const $transaction = jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));
  return { prisma: asPrismaDouble({ $transaction }), tx, $transaction };
}

const baseCtx: AuditLogContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  actorId: '22222222-2222-2222-2222-222222222222',
  actorType: 'user',
  action: 'update',
  resourceType: 'User',
  resourceId: '22222222-2222-2222-2222-222222222222',
  afterState: { email: 'leak@example.com', display_name: 'Bradley' },
};

describe('AuditLogService.withAuditLog (D-H6-5)', () => {
  const ORIGINAL_FAIL_OPEN = process.env.AUDIT_LOG_FAIL_OPEN;

  afterEach(() => {
    // Restore the env var so cases do not leak the valve into each other.
    if (ORIGINAL_FAIL_OPEN === undefined) {
      delete process.env.AUDIT_LOG_FAIL_OPEN;
    } else {
      process.env.AUDIT_LOG_FAIL_OPEN = ORIGINAL_FAIL_OPEN;
    }
    jest.restoreAllMocks();
  });

  it('runs fn and writes exactly one audit row in the same transaction, returning fn result', async () => {
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    const auditCreate = jest.fn().mockResolvedValue({ id: 'row-1' });
    const { prisma, tx, $transaction } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);

    const fn = jest.fn(async (t: unknown) => {
      // fn receives the SAME tx client the audit row is written with.
      expect(t).toBe(tx);
      return { ok: true } as const;
    });

    const result = await service.withAuditLog(baseCtx, fn);

    expect(result).toEqual({ ok: true });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('redacts raw PII (R98) from the audit row before write', async () => {
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    const auditCreate = jest.fn().mockResolvedValue({ id: 'row-1' });
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);

    await service.withAuditLog(baseCtx, async () => 'done');

    const written = auditCreate.mock.calls[0][0].data;
    // The PII email key is redacted; the non-PII field passes through.
    expect(written.after_state.email).toBe(ERASURE_TOKEN);
    expect(written.after_state.display_name).toBe('Bradley');
    // Column-shaped row mirrors the audit_log table.
    expect(written.tenant_id).toBe(baseCtx.tenantId);
    expect(written.action).toBe('update');
    expect(written.resource_type).toBe('User');
  });

  it('runs fn BEFORE the audit write (write order: mutation then audit row)', async () => {
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    const order: string[] = [];
    const auditCreate = jest.fn(async () => {
      order.push('audit');
      return { id: 'row-1' };
    });
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);

    await service.withAuditLog(baseCtx, async () => {
      order.push('mutation');
      return 1;
    });

    expect(order).toEqual(['mutation', 'audit']);
  });

  it('with valve OFF: an audit-insert failure rejects so the transaction rolls back', async () => {
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    const auditErr = new Error('unique_violation on audit_log');
    const auditCreate = jest.fn().mockRejectedValue(auditErr);
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);

    await expect(service.withAuditLog(baseCtx, async () => 'mutation-result')).rejects.toThrow(
      'unique_violation on audit_log',
    );
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('with valve OFF: the failure propagates UNCHANGED (not wrapped)', async () => {
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    const auditErr = new Error('boom');
    const auditCreate = jest.fn().mockRejectedValue(auditErr);
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);

    await expect(service.withAuditLog(baseCtx, async () => 'x')).rejects.toBe(auditErr);
  });

  it('with AUDIT_LOG_FAIL_OPEN=1: an audit-insert failure is swallowed and fn result returned', async () => {
    process.env.AUDIT_LOG_FAIL_OPEN = '1';
    const auditCreate = jest.fn().mockRejectedValue(new Error('audit down'));
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);
    // Silence the expected error log.
    const errSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    const result = await service.withAuditLog(baseCtx, async () => 'committed');

    expect(result).toBe('committed');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('the valve is read per-call (not cached) so an operator can flip it mid-process', async () => {
    const auditCreate = jest.fn().mockRejectedValue(new Error('audit down'));
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    // First with valve OFF — rejects.
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    await expect(service.withAuditLog(baseCtx, async () => 'a')).rejects.toThrow();

    // Operator flips the valve ON without a redeploy — same instance now swallows.
    process.env.AUDIT_LOG_FAIL_OPEN = '1';
    await expect(service.withAuditLog(baseCtx, async () => 'b')).resolves.toBe('b');
  });

  it('AUDIT_LOG_FAIL_OPEN values other than the exact string "1" do NOT enable the valve', async () => {
    const auditCreate = jest.fn().mockRejectedValue(new Error('audit down'));
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    for (const val of ['0', 'true', 'yes', '']) {
      process.env.AUDIT_LOG_FAIL_OPEN = val;
      await expect(service.withAuditLog(baseCtx, async () => 'x')).rejects.toThrow('audit down');
    }
  });

  it('does not write an audit row when fn itself throws (no audit for a failed mutation)', async () => {
    delete process.env.AUDIT_LOG_FAIL_OPEN;
    const auditCreate = jest.fn();
    const { prisma } = makePrisma(auditCreate);
    const service = new AuditLogService(prisma);

    await expect(
      service.withAuditLog(baseCtx, async () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');
    // fn threw before the audit write was reached.
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
