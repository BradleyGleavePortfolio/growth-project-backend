/**
 * B-636-6: every authenticated account role (student, coach, sub_coach,
 * owner) can request, check and download its own data export. Before the
 * fix the three self-scoped routes carried @Roles('student', 'coach',
 * 'owner'); roleSatisfies gives sub_coach no inheritance, so the real
 * RolesGuard answered 403 "Insufficient role" to a sub-coach's own export.
 *
 * This suite runs the actual RolesGuard against the actual controller
 * metadata, then proves the handlers stay scoped to req.user.id.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/auth/roles.guard';
import { DataExportController } from '../src/data-export/data-export.controller';
import type { DataExportService } from '../src/data-export/data-export.service';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';

function stub<T>(value: unknown): T {
  return value as T;
}

const HANDLERS = ['requestExport', 'getStatus', 'createDownloadLink'] as const;
const ROLES = ['student', 'coach', 'sub_coach', 'owner'] as const;
const proto = DataExportController.prototype;

function contextFor(handler: (typeof HANDLERS)[number], role: string): ExecutionContext {
  return stub<ExecutionContext>({
    getHandler: () => proto[handler],
    getClass: () => DataExportController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: `${role}-1`, role } }) }),
  });
}

function guardAllows(handler: (typeof HANDLERS)[number], role: string): boolean {
  try {
    return new RolesGuard(new Reflector()).canActivate(contextFor(handler, role));
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

describe('data export routes admit every account role (B-636-6)', () => {
  for (const handler of HANDLERS) {
    it.each(ROLES)(`${handler}: the real RolesGuard admits %s`, (role) => {
      expect(guardAllows(handler, role)).toBe(true);
    });

    it(`${handler} is not @Public (the global JwtAuthGuard still authenticates it)`, () => {
      expect(new Reflector().get(IS_PUBLIC_KEY, proto[handler])).toBeUndefined();
    });
  }

  it('the browser download route stays @Public (its signed token is the credential)', () => {
    expect(new Reflector().get(IS_PUBLIC_KEY, proto.download)).toBe(true);
  });

  it('a sub-coach request, status and link are scoped to its own id', async () => {
    const service = {
      requestExport: jest
        .fn()
        .mockResolvedValue({ id: 'e1', status: 'PENDING', created_at: new Date() }),
      getLatestStatus: jest.fn().mockResolvedValue({ status: 'READY' }),
      createDownloadLink: jest.fn().mockResolvedValue({ download_path: '/x', expires_at: 'y' }),
    };
    const controller = new DataExportController(stub<DataExportService>(service));
    const req = stub<Parameters<DataExportController['requestExport']>[0]>({
      user: { id: 'sub-coach-1', role: 'sub_coach' },
      // A forged id anywhere else in the request is ignored.
      body: { user_id: 'victim' },
      query: { user_id: 'victim' },
      params: { user_id: 'victim' },
    });
    await controller.requestExport(req);
    await controller.getStatus(req);
    await controller.createDownloadLink(req);
    expect(service.requestExport).toHaveBeenCalledWith('sub-coach-1');
    expect(service.getLatestStatus).toHaveBeenCalledWith('sub-coach-1');
    expect(service.createDownloadLink).toHaveBeenCalledWith('sub-coach-1');
  });
});
