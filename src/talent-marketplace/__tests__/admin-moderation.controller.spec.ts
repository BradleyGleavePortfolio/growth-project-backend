import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminModerationController, withKey } from '../admin-moderation.controller';
import { AdminModerationService } from '../admin-moderation.service';
import type { ReviewDecisionDto } from '../admin-moderation.dto';
import type { AuthedRequest } from '../../auth/auth-request';
import type { User } from '@prisma/client';

// The controller reads only req.user.id. A minimal owner stub: the user field
// is narrowed with a concrete Pick<User,'id'> cast (no blanket any/never),
// which is all the handler dereferences.
function ownerReq(id: string): AuthedRequest {
  return { user: { id } as Pick<User, 'id'> as User };
}

// TM-7a — the admin controller is owner-only. Its security contract is pinned
// locally: class-level @Roles('owner') + JwtAuthGuard & OwnerGuard, and the
// handlers delegate to the service unchanged. The Idempotency-Key header is
// folded into the dto only when the body omits an explicit key.

interface ServiceShape {
  listListings: jest.Mock;
  reviewListing: jest.Mock;
}

function makeController(): {
  controller: AdminModerationController;
  service: ServiceShape;
} {
  const service: ServiceShape = {
    listListings: jest.fn(async () => ({ items: [], next_cursor: null })),
    reviewListing: jest.fn(async () => ({
      id: 'list-1',
      status: 'published',
      decision: 'approved',
      replayed: false,
    })),
  };
  const injected = Object.assign(
    Object.create(AdminModerationService.prototype) as AdminModerationService,
    service,
  );
  return { controller: new AdminModerationController(injected), service };
}

describe('AdminModerationController — owner-only security contract', () => {
  it('is mounted under talent-marketplace/admin', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminModerationController)).toBe(
      'talent-marketplace/admin',
    );
  });

  it('gates the class on @Roles(owner)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminModerationController)).toEqual(['owner']);
  });

  it('applies JwtAuthGuard + OwnerGuard at the class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminModerationController);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(OwnerGuard);
  });

  // Review is an idempotent state transition, not a creation: a first decision
  // AND a replay both return 200, never Nest's default 201 (FIX 5). The handler
  // returns the same shape on both paths, so the single @HttpCode(200) covers
  // both wire responses.
  it('pins HTTP 200 on the review POST (not the default 201)', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AdminModerationController.prototype.reviewListing,
    );
    expect(httpCode).toBe(HttpStatus.OK);
    expect(httpCode).toBe(200);
  });
});

describe('AdminModerationController — delegation', () => {
  it('forwards listings query to the service unchanged', async () => {
    const { controller, service } = makeController();
    const query = { limit: 10 };
    await controller.listings(query);
    expect(service.listListings).toHaveBeenCalledWith(query);
  });

  it('forwards the authed owner id, listing id and dto to reviewListing', async () => {
    const { controller, service } = makeController();
    const req = ownerReq('owner-1');
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.reviewListing(req, 'list-1', dto, undefined);
    expect(service.reviewListing).toHaveBeenCalledWith('owner-1', 'list-1', dto);
  });

  it('folds the Idempotency-Key header into the dto when body omits it', async () => {
    const { controller, service } = makeController();
    const req = ownerReq('owner-1');
    const dto: ReviewDecisionDto = { decision: 'approved' };
    await controller.reviewListing(req, 'list-1', dto, 'hdr-key');
    expect(service.reviewListing).toHaveBeenCalledWith('owner-1', 'list-1', {
      decision: 'approved',
      idempotency_key: 'hdr-key',
    });
  });
});

describe('withKey — header fallback', () => {
  it('prefers an explicit body key over the header', () => {
    const dto: ReviewDecisionDto = {
      decision: 'approved',
      idempotency_key: 'body-key',
    };
    expect(withKey(dto, 'hdr-key')).toBe(dto);
  });

  it('returns the dto untouched when neither key nor header is present', () => {
    const dto: ReviewDecisionDto = { decision: 'rejected' };
    expect(withKey(dto, undefined)).toBe(dto);
  });

  it('injects the header when the body has no key', () => {
    const dto: ReviewDecisionDto = { decision: 'approved' };
    expect(withKey(dto, 'hdr-key')).toEqual({
      decision: 'approved',
      idempotency_key: 'hdr-key',
    });
  });
});
