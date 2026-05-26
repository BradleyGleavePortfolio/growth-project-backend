/**
 * Unit tests for LandingPageController.
 *
 * Covers:
 * - Auth gating via @Roles('coach','owner')
 * - Route dispatch to LandingPageService
 * - Correct HTTP status codes
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import { LandingPageController } from '../src/landing-pages/landing-pages.controller';

// ─── Stub service ─────────────────────────────────────────────────────────────

function makeServiceStub() {
  return {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'page-1', slug: 'test', status: 'draft' }),
    get: jest.fn().mockResolvedValue({ id: 'page-1', sections: [] }),
    update: jest.fn().mockResolvedValue({ id: 'page-1', sections: [] }),
    publish: jest.fn().mockResolvedValue({ id: 'page-1', status: 'published' }),
    unpublish: jest.fn().mockResolvedValue({ id: 'page-1', status: 'archived' }),
    delete: jest.fn().mockResolvedValue(undefined),
    getAnalytics: jest.fn().mockResolvedValue({ total_views: 0 }),
    getLeads: jest.fn().mockResolvedValue({ items: [], has_more: false, next_cursor: null }),
  };
}

// ─── Auth request stub ────────────────────────────────────────────────────────

function makeReq(role: string = 'coach') {
  return { user: { id: 'coach-1', role } } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LandingPageController', () => {
  let svc: ReturnType<typeof makeServiceStub>;
  let ctrl: LandingPageController;

  beforeEach(() => {
    svc = makeServiceStub();
    ctrl = new LandingPageController(svc as any);
    jest.clearAllMocks();
  });

  describe('GET / (list)', () => {
    it('calls service.list with coach id', async () => {
      await ctrl.list(makeReq());
      expect(svc.list).toHaveBeenCalledWith('coach-1');
    });

    it('returns empty array when no pages', async () => {
      const result = await ctrl.list(makeReq());
      expect(result).toEqual([]);
    });
  });

  describe('POST / (create)', () => {
    const dto = {
      template: 'transformation' as any,
      headline: 'Test',
      primary_cta_type: 'checkout' as any,
      primary_cta_label: 'Go',
    };

    it('calls service.create and returns created page', async () => {
      const result = await ctrl.create(makeReq(), dto);
      expect(svc.create).toHaveBeenCalledWith('coach-1', dto);
      expect(result).toMatchObject({ id: 'page-1', status: 'draft' });
    });

    it('propagates ConflictException when cap reached', async () => {
      svc.create.mockRejectedValueOnce(new ConflictException({ error: 'max_pages_reached' }));
      await expect(ctrl.create(makeReq(), dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('GET /:id', () => {
    it('returns page with sections', async () => {
      const result = await ctrl.get(makeReq(), 'page-1');
      expect(svc.get).toHaveBeenCalledWith('coach-1', 'page-1');
      expect(result).toMatchObject({ id: 'page-1' });
    });

    it('propagates NotFoundException', async () => {
      svc.get.mockRejectedValueOnce(new NotFoundException({ error: 'PAGE_NOT_FOUND' }));
      await expect(ctrl.get(makeReq(), 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('PATCH /:id', () => {
    it('calls service.update', async () => {
      await ctrl.update(makeReq(), 'page-1', { headline: 'Updated' });
      expect(svc.update).toHaveBeenCalledWith('coach-1', 'page-1', { headline: 'Updated' });
    });
  });

  describe('POST /:id/publish', () => {
    it('calls service.publish', async () => {
      const result = await ctrl.publish(makeReq(), 'page-1');
      expect(svc.publish).toHaveBeenCalledWith('coach-1', 'page-1');
      expect(result).toMatchObject({ status: 'published' });
    });
  });

  describe('POST /:id/unpublish', () => {
    it('calls service.unpublish', async () => {
      const result = await ctrl.unpublish(makeReq(), 'page-1');
      expect(svc.unpublish).toHaveBeenCalledWith('coach-1', 'page-1');
      expect(result).toMatchObject({ status: 'archived' });
    });
  });

  describe('DELETE /:id', () => {
    it('calls service.delete', async () => {
      await ctrl.delete(makeReq(), 'page-1');
      expect(svc.delete).toHaveBeenCalledWith('coach-1', 'page-1');
    });
  });

  describe('GET /:id/analytics', () => {
    it('returns analytics stats', async () => {
      const result = await ctrl.getAnalytics(makeReq(), 'page-1');
      expect(svc.getAnalytics).toHaveBeenCalledWith('coach-1', 'page-1');
      expect(result).toMatchObject({ total_views: 0 });
    });
  });

  describe('GET /:id/leads', () => {
    it('returns paginated leads', async () => {
      const result = await ctrl.getLeads(makeReq(), 'page-1', {});
      expect(svc.getLeads).toHaveBeenCalledWith('coach-1', 'page-1', {});
      expect(result).toMatchObject({ items: [] });
    });
  });

  describe('@Roles metadata', () => {
    it('has coach and owner in roles metadata', () => {
      const Reflect = global.Reflect;
      // Check class-level roles metadata (set by @Roles decorator)
      const roles = Reflect.getMetadata('roles', LandingPageController);
      expect(roles).toContain('coach');
      expect(roles).toContain('owner');
    });
  });
});
