import { NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthedRequest } from '../../auth/auth-request';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ANTI_BOT_SURFACE_KEY } from '../anti-bot/anti-bot.guard';
import { ANTI_BOT_SURFACES } from '../anti-bot/anti-bot.types';
import { ApplyController } from '../apply.controller';
import { ApplyService } from '../apply.service';
import type {
  ApplicantProfileDto,
  ApplyConfirmationDto,
  MyApplicationsResponse,
} from '../apply.dto';

// apply.controller is thin: it must forward the caller's OWN subject (req.user.id)
// to the reads-own service methods and pass the validated DTOs through. These
// tests pin that wiring so a future edit can't accidentally read another
// applicant's data or drop the subject.

function authedReq(userId: string): AuthedRequest {
  // The controller only reads req.user.id. Build a type-complete User fixture
  // (every scalar field present) so the AuthedRequest is structurally valid
  // without any forbidden widening cast.
  const user: User = { ...BASE_USER, id: userId };
  return { user };
}

// A type-complete User fixture for controller wiring tests. `satisfies User`
// forces the compiler to flag any missing/renamed column, so this stays honest
// as the schema evolves. Only `id` is consumed by the controller under test.
const BASE_USER = {
  id: 'user-0',
  supabase_id: 'precoach:test',
  email: 'test@example.com',
  name: 'Test User',
  phone: null,
  role: 'student',
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
  signup_ref: null,
  default_payout_method_id: null,
  first_win_completed_at: null,
  show_on_leaderboard: false,
  leaderboard_display_name: null,
} satisfies User;

function makeController(parts: Partial<Record<keyof ApplyService, jest.Mock>>): {
  controller: ApplyController;
  service: Record<string, jest.Mock>;
} {
  const service = Object.assign(Object.create(ApplyService.prototype) as ApplyService, parts);
  return { controller: new ApplyController(service), service: parts as Record<string, jest.Mock> };
}

describe('ApplyController.applyToListing', () => {
  it('forwards the listing id and body to the service', async () => {
    const confirmation = { application_id: 'app-1' } as ApplyConfirmationDto;
    const apply = jest.fn(async () => confirmation);
    const { controller } = makeController({ apply });

    const dto = { email: 'jo@example.com', first_name: 'Jo', last_name: 'Coach' };
    const result = await controller.applyToListing('listing-1', dto);

    expect(apply).toHaveBeenCalledWith('listing-1', dto);
    expect(result).toBe(confirmation);
  });
});

describe('ApplyController reads-own routes pass the caller subject', () => {
  it('getMyProfile reads the caller user_id only', async () => {
    const profile = { id: 'applicant-1' } as ApplicantProfileDto;
    const getOwnProfile = jest.fn(async () => profile);
    const { controller } = makeController({ getOwnProfile });

    await controller.getMyProfile(authedReq('user-1'));

    expect(getOwnProfile).toHaveBeenCalledWith('user-1');
  });

  it('updateMyProfile writes against the caller user_id only', async () => {
    const updateOwnProfile = jest.fn(async () => ({ id: 'applicant-1' }) as ApplicantProfileDto);
    const { controller } = makeController({ updateOwnProfile });

    await controller.updateMyProfile(authedReq('user-1'), { first_name: 'Jordan' });

    expect(updateOwnProfile).toHaveBeenCalledWith('user-1', { first_name: 'Jordan' });
  });

  it('myApplications lists only the caller subject', async () => {
    const page = { items: [], next_cursor: null } as MyApplicationsResponse;
    const myApplications = jest.fn(async () => page);
    const { controller } = makeController({ myApplications });

    await controller.myApplications(authedReq('user-1'), { limit: 10 });

    expect(myApplications).toHaveBeenCalledWith('user-1', { limit: 10 });
  });
});

// AUTH BOUNDARY (the decorator contract). The roles-enforced doctrine pin
// requires every route to be @Roles() or @Public(); these specs lock the
// EXACT posture per route so a future edit cannot silently (a) gate the
// anonymous apply funnel — which would 403 every applicant — or (b) open a
// reads-own profile route to the public.
describe('ApplyController — auth boundary metadata', () => {
  const handler = (name: keyof ApplyController) => ApplyController.prototype[name];

  it('applyToListing is @Public() (anonymous funnel) behind the Apply anti-bot gate', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler('applyToListing'))).toBe(true);
    // It must NOT also carry @Roles — RolesGuard would 403 the anon caller.
    expect(Reflect.getMetadata(ROLES_KEY, handler('applyToListing'))).toBeUndefined();
    // The abuse control for the anonymous surface is the anti-bot gate.
    expect(Reflect.getMetadata(ANTI_BOT_SURFACE_KEY, handler('applyToListing'))).toBe(
      ANTI_BOT_SURFACES.Apply,
    );
  });

  it.each(['getMyProfile', 'updateMyProfile', 'myApplications'] as const)(
    '%s is @Roles(student) reads-own and never @Public()',
    (name) => {
      expect(Reflect.getMetadata(ROLES_KEY, handler(name))).toEqual(['student']);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler(name))).not.toBe(true);
    },
  );

  it('no route is gated to coach/owner (this is a student/anon surface)', () => {
    for (const name of ['getMyProfile', 'updateMyProfile', 'myApplications'] as const) {
      const roles = Reflect.getMetadata(ROLES_KEY, handler(name)) as string[] | undefined;
      expect(roles).not.toContain('coach');
      expect(roles).not.toContain('owner');
    }
  });
});

// HTTP CONTRACT. The thin controller delegates, so the wire-status contract is
// proven where it is decided: ParseUUIDPipe yields 400 on a bad id, and the
// service's NotFoundException maps to 404 for an unpublished/absent listing.
describe('ApplyController — error status contract', () => {
  it('propagates the service 404 (NotFoundException) for an unpublished/absent listing', async () => {
    const apply = jest.fn(async () => {
      throw new NotFoundException({
        error: 'Not Found',
        message: 'Job listing not found',
        code: 'job_listing_not_found',
      });
    });
    const { controller } = makeController({ apply });
    await expect(
      controller.applyToListing('listing-x', {
        email: 'jo@example.com',
        first_name: 'Jo',
        last_name: 'Coach',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
