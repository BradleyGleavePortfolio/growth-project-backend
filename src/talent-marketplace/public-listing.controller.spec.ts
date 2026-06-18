import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { PublicListingController } from './public-listing.controller';
import { PublicListingService } from './public-listing.service';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { BrowseListingsQueryDto } from './public-listing.dto';

// TM-3 — the PUBLIC controller is the anon attack surface, so its security
// contract is pinned locally (A-P2-1 / B-P2-2). The invariants under test:
//   1. PUBLIC BY DESIGN — IS_PUBLIC_KEY metadata is present at the class level
//      (opts every route out of the global JwtAuthGuard); there is NO @Roles()
//      gate and NO controller-level guard array — anon must reach published rows.
//   2. RATE-LIMITED — @Throttle pins the unnamed `default` bucket to 60/min over
//      a 60_000ms window so the anon surface cannot be hammered unbounded.
//   3. INPUT BOUNDS — :id is validated by ParseUUIDPipe(v4) so a non-UUID is a
//      400 (never a DB hit); the browse query DTO rejects junk `limit`/oversized
//      facets at the ValidationPipe boundary.
//   4. DELEGATION + STATUS — handlers forward to the service unchanged; an
//      unpublished/unknown id surfaces the service's NotFoundException (404,
//      {error:'Not Found',message:'Job listing not found',code:'job_listing_not_found'})
//      — never a 401/403, which would leak the existence of the gate to an anon caller.
//
// The @nestjs/throttler decorator stores per-bucket metadata under
// `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>`; the unnamed bucket uses the
// suffix "default" (see src/regimes/__tests__/regimes-throttle-metadata.spec.ts).
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';

interface ServiceShape {
  browse: jest.Mock;
  detail: jest.Mock;
}

// Assemble the double onto the real PublicListingService prototype so it stays
// structurally a PublicListingService with no forbidden blanket cast (mirrors
// the TM-2 / public-listing.service.spec.ts double-construction pattern).
function makeService(): { service: ServiceShape; controller: PublicListingController } {
  const service: ServiceShape = { browse: jest.fn(), detail: jest.fn() };
  const injected = Object.assign(
    Object.create(PublicListingService.prototype) as PublicListingService,
    service,
  );
  return { service, controller: new PublicListingController(injected) };
}

describe('PublicListingController — public anon surface contract', () => {
  let service: ServiceShape;
  let controller: PublicListingController;

  beforeEach(() => {
    ({ service, controller } = makeService());
  });

  describe('public-by-design (no auth/role gate)', () => {
    it('marks the controller @Public() (opts out of the global JwtAuthGuard)', () => {
      expect(
        Reflect.getMetadata(IS_PUBLIC_KEY, PublicListingController),
      ).toBe(true);
    });

    it('declares NO controller-level guards (no JwtAuthGuard / RolesGuard array)', () => {
      const guards =
        Reflect.getMetadata(GUARDS_METADATA, PublicListingController) ?? [];
      expect(guards).toEqual([]);
    });

    it('carries NO @Roles() metadata on the class or its handlers', () => {
      // @Roles() stores under ROLES_KEY; its absence is the contract — an anon
      // caller must never be filtered by role on this public surface.
      expect(
        Reflect.getMetadata(ROLES_KEY, PublicListingController),
      ).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, controller.browse)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, controller.detail)).toBeUndefined();
    });

    it('mounts at the public listings path', () => {
      expect(Reflect.getMetadata(PATH_METADATA, PublicListingController)).toBe(
        'talent-marketplace/public/listings',
      );
    });
  });

  describe('rate-limited (anon surface bound)', () => {
    it('pins the default throttle bucket to 60 requests / 60_000ms', () => {
      expect(
        Reflect.getMetadata(THROTTLE_LIMIT_KEY, PublicListingController),
      ).toBe(60);
      expect(
        Reflect.getMetadata(THROTTLE_TTL_KEY, PublicListingController),
      ).toBe(60000);
    });
  });

  describe('routes', () => {
    it('GET / → browse', () => {
      expect(Reflect.getMetadata(PATH_METADATA, controller.browse)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, controller.browse)).toBe(
        RequestMethod.GET,
      );
    });

    it('GET :id → detail', () => {
      expect(Reflect.getMetadata(PATH_METADATA, controller.detail)).toBe(':id');
      expect(Reflect.getMetadata(METHOD_METADATA, controller.detail)).toBe(
        RequestMethod.GET,
      );
    });
  });

  describe('handler delegation + status surface', () => {
    it('browse forwards the validated query and returns the service result', async () => {
      const page = { items: [], next_cursor: null };
      service.browse.mockResolvedValue(page);
      const query = { limit: 10, specialty: 'Strength' };
      const res = await controller.browse(query as BrowseListingsQueryDto);
      expect(service.browse).toHaveBeenCalledWith(query);
      expect(res).toBe(page);
    });

    it('detail forwards the (already UUID-validated) id and returns the result', async () => {
      const payload = { listing: { id: 'x' }, json_ld: { '@type': 'JobPosting' } };
      service.detail.mockResolvedValue(payload);
      const res = await controller.detail('a3f1c2e4-0000-4000-8000-000000000001');
      expect(service.detail).toHaveBeenCalledWith(
        'a3f1c2e4-0000-4000-8000-000000000001',
      );
      expect(res).toBe(payload);
    });

    it('propagates the service 404 (unpublished/unknown id) as-is — never 401/403', async () => {
      // The service throws NotFoundException({error,message,code:'job_listing_not_found'})
      // for a draft/closed/missing id. The controller adds no auth layer, so an anon
      // caller sees a 404 (resource hidden), never a 401/403 (gate revealed).
      // Wire-shape pin lives in __tests__/public-listing.controller.http.spec.ts.
      const notFound = Object.assign(new Error('nf'), {
        getStatus: () => 404,
        getResponse: () => ({
          error: 'Not Found',
          message: 'Job listing not found',
          code: 'job_listing_not_found',
        }),
      });
      service.detail.mockRejectedValue(notFound);
      await expect(
        controller.detail('a3f1c2e4-0000-4000-8000-000000000001'),
      ).rejects.toBe(notFound);
    });
  });

  describe('input bounds (ParseUUIDPipe + ValidationPipe boundary)', () => {
    it(':id is guarded by ParseUUIDPipe(v4) — a non-UUID is a 400 before the service', async () => {
      // Exercise the exact pipe the route binds so a non-UUID param is rejected
      // at the boundary (HTTP 400) and never reaches service.detail / the DB.
      const pipe = new ParseUUIDPipe({ version: '4' });
      const meta = { type: 'param' as const, metatype: String, data: 'id' };
      await expect(pipe.transform('not-a-uuid', meta)).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        pipe.transform('a3f1c2e4-0000-4000-8000-000000000001', meta),
      ).resolves.toBe('a3f1c2e4-0000-4000-8000-000000000001');
    });

    it('browse query accepts a valid limit + coerces the string form', async () => {
      const dto = plainToInstance(BrowseListingsQueryDto, { limit: '20' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.limit).toBe(20);
    });

    it('browse query rejects a non-integer / out-of-range limit (400 boundary)', async () => {
      const bad = plainToInstance(BrowseListingsQueryDto, { limit: '1.5' });
      expect((await validate(bad)).some((e) => e.property === 'limit')).toBe(true);
      const tooBig = plainToInstance(BrowseListingsQueryDto, { limit: 9999 });
      expect((await validate(tooBig)).some((e) => e.property === 'limit')).toBe(
        true,
      );
    });

    it('browse query rejects an oversized facet (MaxLength bound)', async () => {
      const dto = plainToInstance(BrowseListingsQueryDto, {
        specialty: 'x'.repeat(121),
      });
      expect((await validate(dto)).some((e) => e.property === 'specialty')).toBe(
        true,
      );
    });
  });
});
