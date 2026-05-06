import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPtmController } from '../src/admin/ptm/admin-ptm.controller';
import {
  LabelOutcomeDto,
  OutcomeHistoryQueryDto,
  RiskBoardQueryDto,
} from '../src/admin/ptm/admin-ptm.dto';
import { RolesGuard } from '../src/auth/roles.guard';

// Controller-level tests for the Phase 1C admin teaching surface.
//
// Two surfaces under test:
//   1. The class-level RolesGuard rejects coach/student tokens with 403.
//      JwtAuthGuard is exercised in the broader auth suite; here we
//      verify the @Roles('owner') metadata wired on the class is what
//      RolesGuard reads.
//   2. The DTOs reject unknown outcome_type values and >2000-char notes.
//   3. The handlers forward args to the service.

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function run<T>(dto: new () => T, value: unknown, type: 'body' | 'query' = 'body'): Promise<T> {
  return pipe.transform(value, { type, metatype: dto as any });
}

function buildSvc() {
  return {
    labelOutcome: jest.fn(async () => ({ outcome: { id: 'oc-1' }, prediction: null })),
    getClientPtm: jest.fn(async () => ({ client: { id: 'student-1' } })),
    getRiskBoard: jest.fn(async () => ({ data: [], next_cursor: null, generated_at: 'ts' })),
    getOutcomeHistory: jest.fn(async () => ({ data: [], next_cursor: null })),
  } as any;
}

function makeContext(role: string | null) {
  const user = role ? { id: 'u-1', role, email: 'u@x.test' } : null;
  const req: any = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => AdminPtmController.prototype.labelOutcome,
    getClass: () => AdminPtmController,
  } as any;
}

describe('AdminPtmController — class-level RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('owner passes', () => {
    expect(guard.canActivate(makeContext('owner'))).toBe(true);
  });

  it('coach is rejected with ForbiddenException (403)', () => {
    expect(() => guard.canActivate(makeContext('coach'))).toThrow(
      'Insufficient role',
    );
  });

  it('student is rejected with ForbiddenException (403)', () => {
    expect(() => guard.canActivate(makeContext('student'))).toThrow(
      'Insufficient role',
    );
  });

  it('unauthenticated request rejected before role lookup', () => {
    expect(() => guard.canActivate(makeContext(null))).toThrow(
      'Authenticated user required',
    );
  });
});

describe('AdminPtmController — handlers', () => {
  it('labelOutcome forwards body and actor context', async () => {
    const svc = buildSvc();
    const ctrl = new AdminPtmController(svc);
    const req = {
      user: { id: 'owner-1', role: 'owner', email: 'o@o.test' },
    } as any;
    await ctrl.labelOutcome(req, 'student-1', {
      outcome_type: 'churned',
      notes: 'x',
    });
    expect(svc.labelOutcome).toHaveBeenCalledWith(
      'student-1',
      { outcome_type: 'churned', notes: 'x' },
      { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
    );
  });

  it('getClientPtm forwards id', async () => {
    const svc = buildSvc();
    const ctrl = new AdminPtmController(svc);
    await ctrl.getClientPtm('student-9');
    expect(svc.getClientPtm).toHaveBeenCalledWith('student-9');
  });

  it('getRiskBoard forwards bucket / cursor / limit', async () => {
    const svc = buildSvc();
    const ctrl = new AdminPtmController(svc);
    await ctrl.getRiskBoard({
      bucket: 'red',
      cursor: '2026-05-01T00:00:00.000Z',
      limit: 25,
    } as any);
    expect(svc.getRiskBoard).toHaveBeenCalledWith({
      bucket: 'red',
      cursor: '2026-05-01T00:00:00.000Z',
      limit: 25,
    });
  });

  it('getOutcomeHistory forwards filters', async () => {
    const svc = buildSvc();
    const ctrl = new AdminPtmController(svc);
    await ctrl.getOutcomeHistory({
      outcome_type: 'renewed',
      before: '2026-05-01T00:00:00.000Z',
      limit: 50,
    } as any);
    expect(svc.getOutcomeHistory).toHaveBeenCalledWith({
      outcome_type: 'renewed',
      before: '2026-05-01T00:00:00.000Z',
      limit: 50,
    });
  });
});

describe('AdminPtmController — DTO validation', () => {
  it('LabelOutcomeDto accepts a known outcome_type', async () => {
    const dto = await run(LabelOutcomeDto, { outcome_type: 'churned' });
    expect(dto).toEqual({ outcome_type: 'churned' });
  });

  it('LabelOutcomeDto rejects an unknown outcome_type', async () => {
    await expect(
      run(LabelOutcomeDto, { outcome_type: 'made_up' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('LabelOutcomeDto rejects notes >2000 chars', async () => {
    await expect(
      run(LabelOutcomeDto, {
        outcome_type: 'churned',
        notes: 'x'.repeat(2001),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('LabelOutcomeDto rejects extra unknown fields (forbidNonWhitelisted)', async () => {
    await expect(
      run(LabelOutcomeDto, {
        outcome_type: 'churned',
        actor_id: 'forged',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('RiskBoardQueryDto accepts empty / partial query', async () => {
    const dto = await run(RiskBoardQueryDto, {}, 'query');
    expect(dto).toEqual({});
  });

  it('RiskBoardQueryDto rejects an invalid bucket', async () => {
    await expect(
      run(RiskBoardQueryDto, { bucket: 'purple' }, 'query'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('OutcomeHistoryQueryDto rejects an invalid outcome_type', async () => {
    await expect(
      run(OutcomeHistoryQueryDto, { outcome_type: 'made_up' }, 'query'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
