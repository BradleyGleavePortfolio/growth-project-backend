import 'reflect-metadata';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminApplicationsController } from '../admin-applications.controller';
import { AdminApplicationsService } from '../admin-applications.service';
import type { ReviewDecisionDto } from '../admin-applications.dto';
import type { AuthedRequest } from '../../auth/auth-request';
import type { User } from '@prisma/client';

// TM-7b — the applicant-review controller is owner-only. Its security contract
// is pinned locally (class path, @Roles('owner'), JwtAuthGuard + OwnerGuard),
// the review POST returns 200 (idempotent transition, not a 201 create), and
// handlers delegate to the service with the Idempotency-Key header folded in by
// the shared withKey helper and the request-scoped correlation id threaded
// through for the moderation audit event.

function ownerReq(id: string, requestId?: string): AuthedRequest {
  return { user: { id } as Pick<User, 'id'> as User, requestId };
}

interface ServiceShape {
  listApplications: jest.Mock;
  reviewApplication: jest.Mock;
}

function makeController(): {
  controller: AdminApplicationsController;
  service: ServiceShape;
} {
  const service: ServiceShape = {
    listApplications: jest.fn(async () => ({ items: [], next_cursor: null })),
    reviewApplication: jest.fn(async () => ({
      id: 'app-1',
      status: 'shortlisted',
      decision: 'approved',
      note: null,
      decided_by: 'owner-1',
      decided_at: '2026-06-18T04:41:00.000Z',
      replayed: false,
    })),
  };
  const injected = Object.assign(
    Object.create(AdminApplicationsService.prototype) as AdminApplicationsService,
    service,
  );
  return { controller: new AdminApplicationsController(injected), service };
}

describe('AdminApplicationsController — owner-only security contract', () => {
  it('is mounted under talent-marketplace/admin', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminApplicationsController),
    ).toBe('talent-marketplace/admin');
  });

  it('gates the class on @Roles(owner)', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminApplicationsController),
    ).toEqual(['owner']);
  });

  it('applies JwtAuthGuard + OwnerGuard at the class level', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminApplicationsController,
    );
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(OwnerGuard);
  });

  it('returns 200 (not 201) on the review POST — idempotent transition', () => {
    const code = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AdminApplicationsController.prototype.review,
    );
    expect(code).toBe(200);
  });
});

describe('AdminApplicationsController — delegation', () => {
  it('forwards the applications query to the service unchanged when no status filter', async () => {
    const { controller, service } = makeController();
    const query = { limit: 10 };
    await controller.list(query, undefined);
    expect(service.listApplications).toHaveBeenCalledWith(query);
  });

  it('re-pins the pipe-validated status onto the query the service consumes', async () => {
    const { controller, service } = makeController();
    const query = { limit: 10 };
    await controller.list(query, 'shortlisted');
    expect(service.listApplications).toHaveBeenCalledWith({
      limit: 10,
      status: 'shortlisted',
    });
  });

  it('forwards the authed owner id, application id, dto and request id to reviewApplication', async () => {
    const { controller, service } = makeController();
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.review(ownerReq('owner-1', 'req-9'), 'app-1', dto, undefined);
    expect(service.reviewApplication).toHaveBeenCalledWith(
      'owner-1',
      'app-1',
      dto,
      'req-9',
    );
  });

  it('forwards an undefined request id when the request carries none', async () => {
    const { controller, service } = makeController();
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.review(ownerReq('owner-1'), 'app-1', dto, undefined);
    expect(service.reviewApplication).toHaveBeenCalledWith(
      'owner-1',
      'app-1',
      dto,
      undefined,
    );
  });

  it('folds the Idempotency-Key header into the dto when body omits it', async () => {
    const { controller, service } = makeController();
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.review(ownerReq('owner-1'), 'app-1', dto, 'hdr-key');
    expect(service.reviewApplication).toHaveBeenCalledWith(
      'owner-1',
      'app-1',
      { decision: 'approved', idempotency_key: 'hdr-key' },
      undefined,
    );
  });
});
