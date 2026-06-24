import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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
// and handlers delegate to the service unchanged with the Idempotency-Key
// header folded in by the shared withKey helper.

function ownerReq(id: string): AuthedRequest {
  return { user: { id } as Pick<User, 'id'> as User };
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
});

describe('AdminApplicationsController — delegation', () => {
  it('forwards the applications query to the service unchanged', async () => {
    const { controller, service } = makeController();
    const query = { limit: 10 };
    await controller.list(query);
    expect(service.listApplications).toHaveBeenCalledWith(query);
  });

  it('forwards the authed owner id, application id and dto to reviewApplication', async () => {
    const { controller, service } = makeController();
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.review(ownerReq('owner-1'), 'app-1', dto, undefined);
    expect(service.reviewApplication).toHaveBeenCalledWith(
      'owner-1',
      'app-1',
      dto,
    );
  });

  it('folds the Idempotency-Key header into the dto when body omits it', async () => {
    const { controller, service } = makeController();
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.review(ownerReq('owner-1'), 'app-1', dto, 'hdr-key');
    expect(service.reviewApplication).toHaveBeenCalledWith('owner-1', 'app-1', {
      decision: 'approved',
      idempotency_key: 'hdr-key',
    });
  });
});
