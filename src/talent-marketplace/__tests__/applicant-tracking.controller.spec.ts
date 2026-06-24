import 'reflect-metadata';
import { NotImplementedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { User } from '@prisma/client';
import type { AuthedRequest } from '../../auth/auth-request';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { HirerVerifiedGuard } from '../hirer-verified.guard';
import { ApplicantTrackingController } from '../applicant-tracking.controller';
import { ApplicantTrackingService } from '../applicant-tracking.service';

// applicant-tracking.controller is thin: it forwards the caller's OWN subject
// (req.user.id) to the hirer-scoped service and pins the hirer authorization
// stack (JWT + coach role + verified-hirer). These tests assert the guard
// contract so a non-hirer can never reach the surface and the subject is never
// dropped.

const BASE_USER = {
  id: 'user-0',
  supabase_id: 'coach:test',
  email: 'test@example.com',
  name: 'Test User',
  phone: null,
  role: 'coach',
  coach_id: null,
  coach_practice_type: null,
  created_at: new Date('2026-06-18T00:00:00.000Z'),
  archived_at: null,
  deletion_scheduled_at: null,
  deleted_at: null,
  deletion_token_hash: null,
  deletion_token_expires_at: null,
  deletion_requested_at: null,
  deletion_confirmed_at: null,
  expo_push_token: null,
  default_payout_method_id: null,
  first_win_completed_at: null,
  show_on_leaderboard: false,
  leaderboard_display_name: null,
} satisfies User;

function authedReq(userId: string): AuthedRequest {
  return { user: { ...BASE_USER, id: userId } };
}

function makeController(
  parts: Partial<Record<keyof ApplicantTrackingService, jest.Mock>>,
): ApplicantTrackingController {
  const service = Object.assign(
    Object.create(ApplicantTrackingService.prototype) as ApplicantTrackingService,
    parts,
  );
  return new ApplicantTrackingController(service);
}

describe('ApplicantTrackingController — hirer authorization contract', () => {
  it('gates the class to the coach role (OWNER bypass inherited from RolesGuard)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ApplicantTrackingController)).toEqual(['coach']);
  });

  it('mounts the full hirer guard stack: JWT + RolesGuard + HirerVerifiedGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ApplicantTrackingController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard, HirerVerifiedGuard]);
  });
});

describe('ApplicantTrackingController — subject forwarding', () => {
  it('listApplicants forwards the caller id, listing id, and query', async () => {
    const listApplicants = jest.fn(async () => ({ items: [], next_cursor: null }));
    const controller = makeController({ listApplicants });
    await controller.listApplicants(authedReq('hirer-7'), 'listing-1', { limit: 10 });
    expect(listApplicants).toHaveBeenCalledWith('hirer-7', 'listing-1', { limit: 10 });
  });

  it('getApplicant forwards the caller id and application id', async () => {
    const getApplicantDetail = jest.fn(async () => ({}));
    const controller = makeController({ getApplicantDetail });
    await controller.getApplicant(authedReq('hirer-7'), 'app-1');
    expect(getApplicantDetail).toHaveBeenCalledWith('hirer-7', 'app-1');
  });

  it('moveStage forwards the caller id, application id, stage, and idempotency key', async () => {
    const moveStage = jest.fn(async () => ({ application_id: 'app-1', stage: 'screening' }));
    const controller = makeController({ moveStage });
    await controller.moveStage(
      authedReq('hirer-7'),
      'app-1',
      { stage: 'screening' },
      'idem-1',
    );
    expect(moveStage).toHaveBeenCalledWith('hirer-7', 'app-1', 'screening', 'idem-1');
  });
});

// TM-8b route contract is wired now (stable URL) but the persistence ships in
// 8b; the service methods throw NotImplementedException with documented codes.
// These specs pin that the controller routes exist, delegate to the service
// once, and are covered by the SAME class guard/role stack as moveStage (so a
// non-hirer can never reach them either).
describe('ApplicantTrackingController — 8b routes (notes / shortlist) delegation', () => {
  it('appendNote parses the applicationId and delegates to the service once', async () => {
    const appendNote = jest.fn(() => {
      throw new NotImplementedException({ code: 'NOTES_NOT_AVAILABLE' });
    });
    const controller = makeController({ appendNote });
    await expect(
      controller.appendNote('app-1', { note: 'great call' }),
    ).rejects.toMatchObject({ response: { code: 'NOTES_NOT_AVAILABLE' } });
    expect(appendNote).toHaveBeenCalledTimes(1);
  });

  it('toggleShortlist parses the applicationId and delegates to the service once', async () => {
    const toggleShortlist = jest.fn(() => {
      throw new NotImplementedException({ code: 'SHORTLIST_NOT_AVAILABLE' });
    });
    const controller = makeController({ toggleShortlist });
    await expect(controller.toggleShortlist('app-1')).rejects.toMatchObject({
      response: { code: 'SHORTLIST_NOT_AVAILABLE' },
    });
    expect(toggleShortlist).toHaveBeenCalledTimes(1);
  });

  it('covers the 8b routes with the same JWT + coach-role + verified-hirer stack', () => {
    // The guard/role stack is class-level, so it already gates appendNote and
    // toggleShortlist exactly as it gates moveStage.
    expect(Reflect.getMetadata(ROLES_KEY, ApplicantTrackingController)).toEqual(['coach']);
    const guards = Reflect.getMetadata(GUARDS_METADATA, ApplicantTrackingController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard, HirerVerifiedGuard]);
  });
});
