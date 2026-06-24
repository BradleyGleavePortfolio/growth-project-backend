import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { SpecialtyAlertsController } from '../specialty-alerts.controller';
import { SpecialtyAlertsService } from '../specialty-alerts.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';

// TM-9b — the /me/alerts/* surface is owner-scoped: @Roles('student'), and every
// handler forwards the JWT subject (req.user.id) to the service. Invariants:
//   1. AUTH + ROLE GATED — @Roles('student') pins the applicant role at class
//      level; JwtAuthGuard + RolesGuard are global APP_GUARDs (app.module.ts),
//      so no per-controller @UseGuards is declared.
//   2. OWNER-SCOPE — handlers pass req.user.id, never a client-supplied id.

interface AlertsShape {
  listForApplicant: jest.Mock;
  savePreferences: jest.Mock;
}

function makeController() {
  const alerts: AlertsShape = {
    listForApplicant: jest.fn(),
    savePreferences: jest.fn(),
  };
  const injected = Object.assign(
    Object.create(SpecialtyAlertsService.prototype) as SpecialtyAlertsService,
    alerts,
  );
  return { alerts, controller: new SpecialtyAlertsController(injected) };
}

// A concrete owner-scoped request fixture. The handlers read only `user.id`, so
// a minimal structural shape narrowed once to AuthedRequest is sufficient — and
// avoids the chained double cast (`X as A as B`) that prior lanes removed.
interface MinimalAuthedRequest {
  user: { id: string };
}
const reqFor = (id: string): AuthedRequest =>
  ({ user: { id } } satisfies MinimalAuthedRequest) as AuthedRequest;

describe('SpecialtyAlertsController — owner-scoped /me/alerts surface', () => {
  let alerts: AlertsShape;
  let controller: SpecialtyAlertsController;

  beforeEach(() => {
    ({ alerts, controller } = makeController());
  });

  describe('security contract', () => {
    it('declares no per-controller guard (relies on global APP_GUARDs)', () => {
      const guards =
        Reflect.getMetadata(GUARDS_METADATA, SpecialtyAlertsController) ?? [];
      expect(guards).toEqual([]);
    });

    it("pins @Roles('student') at the class level", () => {
      expect(Reflect.getMetadata(ROLES_KEY, SpecialtyAlertsController)).toEqual([
        'student',
      ]);
    });

    it('mounts at talent-marketplace/me/alerts', () => {
      expect(Reflect.getMetadata(PATH_METADATA, SpecialtyAlertsController)).toBe(
        'talent-marketplace/me/alerts',
      );
    });
  });

  describe('routes', () => {
    it('GET alerts (index)', () => {
      expect(Reflect.getMetadata(PATH_METADATA, controller.myAlerts)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, controller.myAlerts)).toBe(
        RequestMethod.GET,
      );
    });

    it('POST preferences', () => {
      expect(Reflect.getMetadata(PATH_METADATA, controller.setPreferences)).toBe(
        'preferences',
      );
      expect(
        Reflect.getMetadata(METHOD_METADATA, controller.setPreferences),
      ).toBe(RequestMethod.POST);
    });
  });

  describe('owner-scope delegation (forwards req.user.id, never a client id)', () => {
    it('myAlerts forwards the caller id + cursor', async () => {
      alerts.listForApplicant.mockResolvedValue({ items: [], next_cursor: null });
      await controller.myAlerts(reqFor('u1'), { cursor: 'c1' });
      expect(alerts.listForApplicant).toHaveBeenCalledWith('u1', 'c1');
    });

    it('myAlerts forwards undefined cursor for page 1 (no cursor query)', async () => {
      alerts.listForApplicant.mockResolvedValue({ items: [], next_cursor: null });
      await controller.myAlerts(reqFor('u1'), {});
      expect(alerts.listForApplicant).toHaveBeenCalledWith('u1', undefined);
    });

    it('setPreferences forwards the caller id + the dto specialties', async () => {
      alerts.savePreferences.mockResolvedValue({ specialties: ['Strength'] });
      await controller.setPreferences(reqFor('u2'), { specialties: ['Strength'] });
      expect(alerts.savePreferences).toHaveBeenCalledWith('u2', ['Strength']);
    });
  });
});
