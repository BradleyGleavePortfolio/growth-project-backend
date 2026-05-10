import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FederationInboundService } from '../src/admin/federation/federation-inbound.service';
import { InboundSignalDto } from '../src/admin/federation/federation-inbound.dto';

// Pins the auth gating, user-lookup, and PTM dispatch logic for the
// inbound finance federation endpoint (POST /admin/federation/ptm-signal).
//
// Matrix of cases:
//   - 503 when FINANCE_SERVICE_TOKEN is unset
//   - 401 on missing bearer
//   - 401 on wrong bearer
//   - 403 on wrong X-Federation-Source header
//   - 400 on unsupported signal_type
//   - 400 when neither user_id nor email provided
//   - 404 when user_id not found
//   - 404 when email not found
//   - 200 { ok: true } on happy path with user_id
//   - 200 { ok: true } on happy path with email lookup
//   - PTM emit is fire-and-forget (ptm.emit / ptm.recordSignal called)
//   - recorded_at routes to recordSignal (with timestamp) not emit

describe('FederationInboundService', () => {
  const VALID_TOKEN = 'test-service-token-abc123';

  function buildService(prismaUser: any | null, ptmOverride?: any) {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (!prismaUser) return null;
          if (where.id && where.id !== prismaUser.id) return null;
          return prismaUser;
        }),
        findMany: jest.fn(async ({ where }: any) => {
          if (!prismaUser) return [];
          const emailMatches =
            prismaUser.email?.toLowerCase() ===
            (where.email?.equals ?? '').toLowerCase();
          return emailMatches && !prismaUser.deleted_at ? [prismaUser] : [];
        }),
      },
    };
    const ptm: any = ptmOverride ?? { emit: jest.fn(), recordSignal: jest.fn() };
    const service = new FederationInboundService(prisma, ptm);
    return { service, ptm, prisma };
  }

  const validUser = {
    id: 'user-uuid-001',
    email: 'alice@example.test',
    deleted_at: null,
  };

  function makeDto(overrides: Partial<InboundSignalDto> = {}): InboundSignalDto {
    return {
      user_id: validUser.id,
      signal_type: 'finance_eod',
      ...overrides,
    } as InboundSignalDto;
  }

  beforeEach(() => {
    delete process.env.FINANCE_SERVICE_TOKEN;
  });

  // --- 503: token not configured ---
  it('returns 503 FEDERATION_DISABLED when FINANCE_SERVICE_TOKEN is unset', async () => {
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal(`Bearer ${VALID_TOKEN}`, 'finance-backend', makeDto()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  // --- 401: missing or wrong bearer ---
  it('returns 401 when Authorization header is missing', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal(undefined, 'finance-backend', makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 when bearer token does not match', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal('Bearer wrong-token', 'finance-backend', makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // --- 403: source header mismatch ---
  it('returns 403 when X-Federation-Source is missing', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal(`Bearer ${VALID_TOKEN}`, undefined, makeDto()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when X-Federation-Source is not finance-backend', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal(
        `Bearer ${VALID_TOKEN}`,
        'fitness-backend',
        makeDto(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // --- 400: signal type not accepted ---
  it('returns 400 when signal_type is not a finance signal', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal(
        `Bearer ${VALID_TOKEN}`,
        'finance-backend',
        makeDto({ signal_type: 'workout_logged' as any }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- 400: missing identity ---
  it('returns 400 when neither user_id nor email is provided', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(validUser);
    await expect(
      service.handleSignal(
        `Bearer ${VALID_TOKEN}`,
        'finance-backend',
        { signal_type: 'finance_eod' } as InboundSignalDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- 404: user not found ---
  it('returns 404 when user_id does not match any row', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(null);
    await expect(
      service.handleSignal(
        `Bearer ${VALID_TOKEN}`,
        'finance-backend',
        makeDto({ user_id: 'nonexistent-uuid' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when email does not match any row', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service } = buildService(null);
    await expect(
      service.handleSignal(
        `Bearer ${VALID_TOKEN}`,
        'finance-backend',
        makeDto({ user_id: undefined, email: 'ghost@nowhere.test' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // --- Happy path: user_id ---
  it('dispatches PTM emit and returns { ok: true } on happy path (user_id)', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service, ptm } = buildService(validUser);
    const result = await service.handleSignal(
      `Bearer ${VALID_TOKEN}`,
      'finance-backend',
      makeDto({ signal_type: 'finance_milestone', value: 2 }),
    );
    expect(result).toEqual({ ok: true });
    expect(ptm.emit).toHaveBeenCalledWith(
      validUser.id,
      'finance_milestone',
      2,
      expect.objectContaining({ source: 'finance_federation' }),
    );
  });

  // --- Happy path: email lookup ---
  it('dispatches PTM emit and returns { ok: true } on happy path (email)', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service, ptm } = buildService(validUser);
    const result = await service.handleSignal(
      `Bearer ${VALID_TOKEN}`,
      'finance-backend',
      makeDto({ user_id: undefined, email: validUser.email }),
    );
    expect(result).toEqual({ ok: true });
    expect(ptm.emit).toHaveBeenCalledWith(
      validUser.id,
      'finance_eod',
      1,
      expect.objectContaining({ source: 'finance_federation' }),
    );
  });

  // --- recorded_at routes through recordSignal ---
  it('uses recordSignal (not emit) when recorded_at is supplied', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service, ptm } = buildService(validUser);
    const ts = '2025-01-15T10:00:00Z';
    await service.handleSignal(
      `Bearer ${VALID_TOKEN}`,
      'finance-backend',
      makeDto({ recorded_at: ts }),
    );
    expect(ptm.recordSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: validUser.id,
        signalType: 'finance_eod',
        recordedAt: new Date(ts),
      }),
    );
    // emit should NOT be called when recorded_at is present
    expect(ptm.emit).not.toHaveBeenCalled();
  });

  // --- finance_eod with default value ---
  it('defaults value to 1 when omitted', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service, ptm } = buildService(validUser);
    await service.handleSignal(
      `Bearer ${VALID_TOKEN}`,
      'finance-backend',
      makeDto({ value: undefined }),
    );
    expect(ptm.emit).toHaveBeenCalledWith(
      validUser.id,
      'finance_eod',
      1,
      expect.any(Object),
    );
  });

  // --- metadata passthrough ---
  it('merges caller metadata with source tag', async () => {
    process.env.FINANCE_SERVICE_TOKEN = VALID_TOKEN;
    const { service, ptm } = buildService(validUser);
    await service.handleSignal(
      `Bearer ${VALID_TOKEN}`,
      'finance-backend',
      makeDto({
        signal_type: 'finance_milestone',
        metadata: { milestone_type: 'net_worth_100k' },
      }),
    );
    expect(ptm.emit).toHaveBeenCalledWith(
      validUser.id,
      'finance_milestone',
      1,
      expect.objectContaining({
        source: 'finance_federation',
        milestone_type: 'net_worth_100k',
      }),
    );
  });
});
