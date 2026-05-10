import { ServiceUnavailableException } from '@nestjs/common';
import { PracticeTypeService } from '../src/coach/practice-type/practice-type.service';
import type { FinanceAdminClient } from '../src/admin/federation/finance-admin.client';
import type { PrismaService } from '../src/prisma.service';

// Sprint A — symmetric practice write. Verifies the federation hop
// and the failure-mode contract:
//   - finance unconfigured → finance_status='skipped'
//   - finance returns ok    → finance_status='ok'
//   - finance returns 404   → finance_status='not_found'
//   - finance degraded      → 503 ServiceUnavailableException
//   - propagate=false       → no federation call

describe('PracticeTypeService.set (Sprint A dual write)', () => {
  const fakeUser = { role: 'coach' as const, email: 'coach@example.com' };

  function makePrisma(): jest.Mocked<PrismaService> {
    return {
      user: {
        findUnique: jest.fn().mockResolvedValue(fakeUser),
        update: jest.fn().mockResolvedValue({ coach_practice_type: 'both' }),
      },
    } as unknown as jest.Mocked<PrismaService>;
  }
  function makeClient(
    overrides: Partial<jest.Mocked<FinanceAdminClient>> = {},
  ): jest.Mocked<FinanceAdminClient> {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      hasAuth: jest.fn().mockReturnValue(true),
      setCoachPracticeByEmail: jest
        .fn()
        .mockResolvedValue({ kind: 'ok', data: { email: 'x', practice_type: 'both' } }),
      ...overrides,
    } as unknown as jest.Mocked<FinanceAdminClient>;
  }

  it('returns finance_status="skipped" when finance is unconfigured', async () => {
    const prisma = makePrisma();
    const client = makeClient({
      isConfigured: jest.fn().mockReturnValue(false),
    });
    const svc = new PracticeTypeService(prisma, client);
    const out = await svc.set('user-1', 'both');
    expect(out.finance_status).toBe('skipped');
    expect(client.setCoachPracticeByEmail).not.toHaveBeenCalled();
  });

  it('returns finance_status="ok" when federation succeeds', async () => {
    const prisma = makePrisma();
    const client = makeClient();
    const svc = new PracticeTypeService(prisma, client);
    const out = await svc.set('user-1', 'both');
    expect(out.finance_status).toBe('ok');
    expect(client.setCoachPracticeByEmail).toHaveBeenCalledWith(
      'coach@example.com',
      'both',
    );
  });

  it('lower-cases the email before federation', async () => {
    const prisma = makePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: 'coach',
      email: 'CoAcH@Example.COM',
    });
    const client = makeClient();
    const svc = new PracticeTypeService(prisma, client);
    await svc.set('user-1', 'both');
    expect(client.setCoachPracticeByEmail).toHaveBeenCalledWith(
      'coach@example.com',
      'both',
    );
  });

  it('returns finance_status="not_found" when finance has no matching coach', async () => {
    const prisma = makePrisma();
    const client = makeClient({
      setCoachPracticeByEmail: jest
        .fn()
        .mockResolvedValue({ kind: 'not_found' }),
    });
    const svc = new PracticeTypeService(prisma, client);
    const out = await svc.set('user-1', 'both');
    expect(out.finance_status).toBe('not_found');
  });

  it('throws 503 when finance is configured but degraded', async () => {
    const prisma = makePrisma();
    const client = makeClient({
      setCoachPracticeByEmail: jest
        .fn()
        .mockResolvedValue({ kind: 'degraded', reason: 'timeout' }),
    });
    const svc = new PracticeTypeService(prisma, client);
    await expect(svc.set('user-1', 'both')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('skips federation when called with propagate=false', async () => {
    const prisma = makePrisma();
    const client = makeClient();
    const svc = new PracticeTypeService(prisma, client);
    const out = await svc.set('user-1', 'both', { propagate: false });
    expect(out.finance_status).toBe('skipped');
    expect(client.setCoachPracticeByEmail).not.toHaveBeenCalled();
  });
});
