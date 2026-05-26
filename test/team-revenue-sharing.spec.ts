// Audit #1 P1-3 / P1-6 — revenue-sharing DTO + service coverage.
//
// Covers:
//   * DTO rejects string "false" (would be truthy and incorrectly enable
//     sharing under the old hand-rolled body type).
//   * DTO rejects omitted / null / number inputs.
//   * DTO accepts a strict boolean.
//   * Service throws NotFoundException for cross-head-coach modification
//     (sub_coach belongs to a different head coach). The route guard maps
//     NotFoundException → 404 (we 404 rather than 403 to avoid leaking the
//     existence of sub-coaches under other head coaches).

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateRevenueSharingDto } from '../src/team/dto/update-revenue-sharing.dto';
import { TeamService } from '../src/team/team.service';

describe('UpdateRevenueSharingDto', () => {
  function validateBody(raw: unknown) {
    const dto = plainToInstance(UpdateRevenueSharingDto, raw);
    return validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  it('rejects string "false" (would be truthy under raw object body)', () => {
    const errs = validateBody({ enabled: 'false' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].constraints).toHaveProperty('isBoolean');
  });

  it('rejects string "true"', () => {
    const errs = validateBody({ enabled: 'true' });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects omitted enabled', () => {
    const errs = validateBody({});
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects null enabled', () => {
    const errs = validateBody({ enabled: null });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects numeric 0 / 1', () => {
    expect(validateBody({ enabled: 0 }).length).toBeGreaterThan(0);
    expect(validateBody({ enabled: 1 }).length).toBeGreaterThan(0);
  });

  it('accepts strict boolean false', () => {
    expect(validateBody({ enabled: false }).length).toBe(0);
  });

  it('accepts strict boolean true', () => {
    expect(validateBody({ enabled: true }).length).toBe(0);
  });
});

describe('TeamService.setRevenueSharing — cross-head-coach modification', () => {
  // Helper: build a minimal mock Prisma with transaction + audit support.
  function buildPrisma(overrides: Record<string, unknown> = {}) {
    const base: any = {
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => null),
      },
      feePolicy: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async () => ({})),
      },
      teamAuditEvent: {
        create: jest.fn(async () => ({ id: 'evt-1' })),
      },
      auditLog: {
        create: jest.fn(async () => ({ id: 'al-1' })),
      },
      $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
        cb(base as unknown),
      ),
      ...overrides,
    };
    return base;
  }

  // Minimal AuditService stub — write() is fire-and-forget so failures are
  // swallowed; stub just resolves to keep tests deterministic.
  function buildAudit() {
    return { write: jest.fn(async () => undefined) };
  }

  it('throws NotFoundException when the sub-coach is not on the caller\'s team', async () => {
    const prisma = buildPrisma();
    const audit = buildAudit();
    // Constructor signature: (prisma, feePolicy, audit)
    // feePolicy is not called before the sub-coach relationship guard fires.
    const svc = new TeamService(prisma as never, null as never, audit as never);
    await expect(
      svc.setRevenueSharing('head-A', 'sub-of-head-B', false),
    ).rejects.toThrow(NotFoundException);
    // The feePolicy.upsert inside the transaction must not have been invoked.
    expect(prisma.feePolicy.upsert).not.toHaveBeenCalled();
    expect(prisma.teamAuditEvent.create).not.toHaveBeenCalled();
  });

  it('disables the split (head_coach_split_bps=0) when enabled=false on a valid sub-coach', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'tsca-1' })),
      },
    });
    const audit = buildAudit();
    const svc = new TeamService(prisma as never, null as never, audit as never);
    const out = await svc.setRevenueSharing('head-A', 'sub-A1', false, 'head-A', 'coach');
    expect(out.revenue_sharing_enabled).toBe(false);
    // The inline feePolicy.upsert inside $transaction should have been called
    // with head_coach_split_bps: 0.
    expect(prisma.feePolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ head_coach_split_bps: 0 }),
      }),
    );
    // teamAuditEvent.create must have been called inside the transaction.
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.teamAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.event_kind).toBe('revenue_sharing_changed');
    expect(auditCall.data.head_coach_id).toBe('head-A');
    expect(auditCall.data.actor_user_id).toBe('head-A');
    expect(auditCall.data.metadata).toMatchObject({
      sub_coach_id: 'sub-A1',
      new_split_bps: 0,
      enabled: false,
      actor_role: 'coach',
    });
    // SOC2 AuditService.write should have been called.
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'team.revenue_sharing.updated',
        actorId: 'head-A',
        targetUserId: 'sub-A1',
      }),
    );
  });

  it('re-enables the split (head_coach_split_bps=null → default 500 bps) when enabled=true', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'tsca-1' })),
      },
      feePolicy: {
        findUnique: jest.fn(async () => ({ head_coach_split_bps: 0 })),
        upsert: jest.fn(async () => ({})),
      },
    });
    const audit = buildAudit();
    const svc = new TeamService(prisma as never, null as never, audit as never);
    const out = await svc.setRevenueSharing('head-A', 'sub-A1', true, 'head-A', 'coach');
    expect(out.revenue_sharing_enabled).toBe(true);
    expect(prisma.feePolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ head_coach_split_bps: null }),
      }),
    );
    // Metadata captures the previous bps (0 from the mock feePolicy row).
    const auditCall = prisma.teamAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.metadata).toMatchObject({
      previous_split_bps: 0,
      new_split_bps: null,
      enabled: true,
    });
  });

  it('writes the teamAuditEvent inside the transaction (atomic with the feePolicy upsert)', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'tsca-1' })),
      },
    });
    const audit = buildAudit();
    const svc = new TeamService(prisma as never, null as never, audit as never);
    await svc.setRevenueSharing('head-A', 'sub-A1', false);
    // Both writes happened inside the $transaction callback.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.feePolicy.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('SOC2 audit write failure does not surface to the caller', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'tsca-1' })),
      },
    });
    // Simulate AuditService.write throwing — must not propagate.
    const audit = { write: jest.fn().mockRejectedValue(new Error('db down')) };
    const svc = new TeamService(prisma as never, null as never, audit as never);
    // Should resolve successfully even though AuditService throws.
    await expect(
      svc.setRevenueSharing('head-A', 'sub-A1', false),
    ).resolves.toEqual({ revenue_sharing_enabled: false });
  });
});
