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
  it('throws NotFoundException when the sub-coach is not on the caller\'s team', async () => {
    const prisma: any = {
      teamSubCoachAssignment: {
        // No matching assignment under this head_coach → service should
        // refuse without falling through to FeePolicyService.
        findFirst: jest.fn(async () => null),
      },
    };
    const feePolicy: any = { upsertOverride: jest.fn() };
    const svc = new TeamService(prisma as never, feePolicy as never);
    await expect(
      svc.setRevenueSharing('head-A', 'sub-of-head-B', false),
    ).rejects.toThrow(NotFoundException);
    expect(feePolicy.upsertOverride).not.toHaveBeenCalled();
  });

  it('disables the split (head_coach_split_bps=0) when enabled=false on a valid sub-coach', async () => {
    const prisma: any = {
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'tsca-1' })),
      },
    };
    const upsertOverride = jest.fn(async () => undefined);
    const feePolicy: any = { upsertOverride };
    const svc = new TeamService(prisma as never, feePolicy as never);
    const out = await svc.setRevenueSharing('head-A', 'sub-A1', false);
    expect(out.revenue_sharing_enabled).toBe(false);
    expect(upsertOverride).toHaveBeenCalledWith(
      'sub-A1',
      expect.objectContaining({ head_coach_split_bps: 0 }),
    );
  });

  it('re-enables the split (head_coach_split_bps=null → default 500 bps) when enabled=true', async () => {
    const prisma: any = {
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'tsca-1' })),
      },
    };
    const upsertOverride = jest.fn(async () => undefined);
    const feePolicy: any = { upsertOverride };
    const svc = new TeamService(prisma as never, feePolicy as never);
    const out = await svc.setRevenueSharing('head-A', 'sub-A1', true);
    expect(out.revenue_sharing_enabled).toBe(true);
    expect(upsertOverride).toHaveBeenCalledWith(
      'sub-A1',
      expect.objectContaining({ head_coach_split_bps: null }),
    );
  });
});
