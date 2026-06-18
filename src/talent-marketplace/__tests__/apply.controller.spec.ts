import type { User } from '@prisma/client';
import type { AuthedRequest } from '../../auth/auth-request';
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
  // The controller only reads req.user.id. Build a structurally complete-enough
  // User by spreading a base test user and overriding the id, so no widening
  // cast is needed beyond the single justified User assertion.
  const user: User = { ...BASE_USER, id: userId };
  return { user };
}

// A minimal but type-complete User row for controller wiring tests. Field values
// are inert placeholders; only `id` is consumed by the controller under test.
const BASE_USER = {
  id: 'user-0',
  supabase_id: 'precoach:test',
  email: 'test@example.com',
  name: 'Test User',
  role: 'student',
  created_at: new Date('2026-06-18T00:00:00.000Z'),
  updated_at: new Date('2026-06-18T00:00:00.000Z'),
} satisfies Pick<
  User,
  'id' | 'supabase_id' | 'email' | 'name' | 'role' | 'created_at' | 'updated_at'
> as User;

function makeController(parts: Partial<Record<keyof ApplyService, jest.Mock>>): {
  controller: ApplyController;
  service: Record<string, jest.Mock>;
} {
  const service = Object.assign(
    Object.create(ApplyService.prototype) as ApplyService,
    parts,
  );
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
