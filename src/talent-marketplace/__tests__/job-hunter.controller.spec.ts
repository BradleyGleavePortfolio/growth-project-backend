import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { JobHunterController } from '../job-hunter.controller';
import { JobHunterService } from '../job-hunter.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import type { User } from '@prisma/client';

// TM-9a — the /me/* dashboard surface is owner-scoped: JWT-gated,
// @Roles('student'), and every handler forwards the JWT subject (req.user.id)
// to the service. The invariants under test:
//   1. AUTH + ROLE GATED — @Roles('student') pins the applicant role at class
//      level; JwtAuthGuard + RolesGuard are global APP_GUARDs (app.module.ts),
//      so no per-controller @UseGuards is needed (and none is declared).
//   2. OWNER-SCOPE — handlers pass req.user.id, never a client-supplied id, so
//      one applicant can never read another's data.

interface HunterShape {
  myApplications: jest.Mock;
  getPortfolio: jest.Mock;
  updatePortfolio: jest.Mock;
  profileStrength: jest.Mock;
}

function makeController() {
  const hunter: HunterShape = {
    myApplications: jest.fn(),
    getPortfolio: jest.fn(),
    updatePortfolio: jest.fn(),
    profileStrength: jest.fn(),
  };
  const injectedHunter = Object.assign(
    Object.create(JobHunterService.prototype) as JobHunterService,
    hunter,
  );
  return {
    hunter,
    controller: new JobHunterController(injectedHunter),
  };
}

// A concrete owner-scoped request fixture — only `user.id` is read by the
// handlers, so a narrow concrete cast on the user keeps this structurally an
// AuthedRequest without any forbidden double cast.
const reqFor = (id: string): AuthedRequest => ({
  user: { id } as Pick<User, 'id'> as User,
});

describe('JobHunterController — owner-scoped /me dashboard surface', () => {
  let hunter: HunterShape;
  let controller: JobHunterController;

  beforeEach(() => {
    ({ hunter, controller } = makeController());
  });

  describe('security contract', () => {
    it('declares no per-controller guard (relies on global APP_GUARDs)', () => {
      const guards =
        Reflect.getMetadata(GUARDS_METADATA, JobHunterController) ?? [];
      expect(guards).toEqual([]);
    });

    it("pins @Roles('student') at the class level", () => {
      expect(Reflect.getMetadata(ROLES_KEY, JobHunterController)).toEqual([
        'student',
      ]);
    });

    it('mounts at talent-marketplace/me', () => {
      expect(Reflect.getMetadata(PATH_METADATA, JobHunterController)).toBe(
        'talent-marketplace/me',
      );
    });
  });

  describe('routes', () => {
    it('GET applications', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, controller.myApplications),
      ).toBe('applications');
      expect(
        Reflect.getMetadata(METHOD_METADATA, controller.myApplications),
      ).toBe(RequestMethod.GET);
    });

    it('PUT portfolio', () => {
      expect(Reflect.getMetadata(PATH_METADATA, controller.updatePortfolio)).toBe(
        'portfolio',
      );
      expect(
        Reflect.getMetadata(METHOD_METADATA, controller.updatePortfolio),
      ).toBe(RequestMethod.PUT);
    });

    it('GET profile-strength', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, controller.profileStrength),
      ).toBe('profile-strength');
      expect(
        Reflect.getMetadata(METHOD_METADATA, controller.profileStrength),
      ).toBe(RequestMethod.GET);
    });
  });

  describe('owner-scope delegation (forwards req.user.id, never a client id)', () => {
    it('myApplications forwards the caller id + query', async () => {
      hunter.myApplications.mockResolvedValue({ items: [], next_cursor: null });
      await controller.myApplications(reqFor('u1'), { limit: 5 });
      expect(hunter.myApplications).toHaveBeenCalledWith('u1', { limit: 5 });
    });

    it('getPortfolio forwards the caller id', async () => {
      hunter.getPortfolio.mockResolvedValue({});
      await controller.getPortfolio(reqFor('u2'));
      expect(hunter.getPortfolio).toHaveBeenCalledWith('u2');
    });

    it('updatePortfolio forwards the caller id + dto', async () => {
      hunter.updatePortfolio.mockResolvedValue({});
      const dto = { headline: 'hi' };
      await controller.updatePortfolio(reqFor('u3'), dto);
      expect(hunter.updatePortfolio).toHaveBeenCalledWith('u3', dto);
    });

    it('profileStrength forwards the caller id', async () => {
      hunter.profileStrength.mockResolvedValue({ score: 0, nudges: [] });
      await controller.profileStrength(reqFor('u6'));
      expect(hunter.profileStrength).toHaveBeenCalledWith('u6');
    });
  });
});
