import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { JobHunterController } from '../job-hunter.controller';
import { JobHunterService } from '../job-hunter.service';
import { SpecialtyAlertsService } from '../specialty-alerts.service';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';

// TM-9 — the /me/* surface is owner-scoped: JWT-gated, @Roles('student'), and
// every handler forwards the JWT subject (req.user.id) to the service. The
// invariants under test:
//   1. AUTH-GATED — JwtAuthGuard is on the controller (no anon access).
//   2. ROLE-GATED — @Roles('student') pins the applicant role at class level.
//   3. OWNER-SCOPE — handlers pass req.user.id, never a client-supplied id, so
//      one applicant can never read another's data.

interface HunterShape {
  myApplications: jest.Mock;
  getPortfolio: jest.Mock;
  updatePortfolio: jest.Mock;
  profileStrength: jest.Mock;
}
interface AlertsShape {
  listForApplicant: jest.Mock;
  savePreferences: jest.Mock;
}

function makeController() {
  const hunter: HunterShape = {
    myApplications: jest.fn(),
    getPortfolio: jest.fn(),
    updatePortfolio: jest.fn(),
    profileStrength: jest.fn(),
  };
  const alerts: AlertsShape = {
    listForApplicant: jest.fn(),
    savePreferences: jest.fn(),
  };
  const injectedHunter = Object.assign(
    Object.create(JobHunterService.prototype) as JobHunterService,
    hunter,
  );
  const injectedAlerts = Object.assign(
    Object.create(SpecialtyAlertsService.prototype) as SpecialtyAlertsService,
    alerts,
  );
  return {
    hunter,
    alerts,
    controller: new JobHunterController(injectedHunter, injectedAlerts),
  };
}

const reqFor = (id: string): AuthedRequest =>
  ({ user: { id } }) as unknown as AuthedRequest;

describe('JobHunterController — owner-scoped /me surface', () => {
  let hunter: HunterShape;
  let alerts: AlertsShape;
  let controller: JobHunterController;

  beforeEach(() => {
    ({ hunter, alerts, controller } = makeController());
  });

  describe('security contract', () => {
    it('gates the controller with JwtAuthGuard', () => {
      const guards =
        Reflect.getMetadata(GUARDS_METADATA, JobHunterController) ?? [];
      expect(guards).toContain(JwtAuthGuard);
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

    it('POST alerts/preferences', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, controller.setAlertPreferences),
      ).toBe('alerts/preferences');
      expect(
        Reflect.getMetadata(METHOD_METADATA, controller.setAlertPreferences),
      ).toBe(RequestMethod.POST);
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

    it('myAlerts forwards the caller id', async () => {
      alerts.listForApplicant.mockResolvedValue([]);
      await controller.myAlerts(reqFor('u4'));
      expect(alerts.listForApplicant).toHaveBeenCalledWith('u4');
    });

    it('setAlertPreferences forwards the caller id + specialties only', async () => {
      alerts.savePreferences.mockResolvedValue({ specialties: [] });
      await controller.setAlertPreferences(reqFor('u5'), {
        specialties: ['Strength'],
      });
      expect(alerts.savePreferences).toHaveBeenCalledWith('u5', ['Strength']);
    });

    it('profileStrength forwards the caller id', async () => {
      hunter.profileStrength.mockResolvedValue({ score: 0, nudges: [] });
      await controller.profileStrength(reqFor('u6'));
      expect(hunter.profileStrength).toHaveBeenCalledWith('u6');
    });
  });
});
