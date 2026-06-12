/**
 * v3-1 controller pagination wiring (D-040, B-PAG-1).
 *
 * The leaderboard and comments GET handlers had NO @Query() before this slice;
 * they now accept a PaginationQueryDto and forward it to the service unchanged.
 * The challenge list handler already had a @Query() — its DTO now extends
 * PaginationQueryDto, so limit/cursor ride through too. These tests construct
 * the controller with a faked service (no Nest container, no HTTP server) and
 * assert the handler passes the parsed query straight through with the
 * authenticated user + path param.
 */
import type { AuthedRequest } from '../../../auth/auth-request';
import { CommunityChallengesController } from '../community-challenges.controller';
import {
  ListChallengesQueryDto,
  PaginationQueryDto,
} from '../community-challenges.dto';

const USER_ID = '55555555-5555-5555-8555-555555555555';
const WS = '11111111-1111-1111-8111-111111111111';
const CH = '44444444-4444-4444-8444-444444444444';
const CURSOR = '66666666-6666-4666-8666-666666666666';

interface TestUser {
  id: string;
  role: string;
}

function reqFor(user: TestUser): AuthedRequest {
  return { user } as Pick<AuthedRequest, 'user'> as AuthedRequest;
}

function pagination(over: Partial<PaginationQueryDto>): PaginationQueryDto {
  const dto = new PaginationQueryDto();
  Object.assign(dto, over);
  return dto;
}

describe('CommunityChallengesController pagination wiring (D-040)', () => {
  const user: TestUser = { id: USER_ID, role: 'student' };
  let service: {
    list: jest.Mock;
    getLeaderboard: jest.Mock;
    listComments: jest.Mock;
  };
  let controller: CommunityChallengesController;

  beforeEach(() => {
    service = {
      list: jest.fn(async () => ({ challenges: [], next_cursor: null })),
      getLeaderboard: jest.fn(async () => ({
        available: false,
        opted_in: false,
        rows: [],
        next_cursor: null,
      })),
      listComments: jest.fn(async () => ({ comments: [], next_cursor: null })),
    };
    controller = new CommunityChallengesController(service as never);
  });

  it('leaderboard forwards limit + cursor to the service', async () => {
    const query = pagination({ limit: 20, cursor: CURSOR });
    await controller.leaderboard(reqFor(user), CH, query);
    expect(service.getLeaderboard).toHaveBeenCalledWith(user, CH, query);
    expect(service.getLeaderboard.mock.calls[0][2]).toMatchObject({
      limit: 20,
      cursor: CURSOR,
    });
  });

  it('leaderboard forwards an empty pagination query (defaults resolved downstream)', async () => {
    const query = pagination({});
    await controller.leaderboard(reqFor(user), CH, query);
    expect(service.getLeaderboard).toHaveBeenCalledWith(user, CH, query);
  });

  it('comments forwards limit + cursor to the service', async () => {
    const query = pagination({ limit: 50, cursor: CURSOR });
    await controller.listComments(reqFor(user), CH, query);
    expect(service.listComments).toHaveBeenCalledWith(user, CH, query);
    expect(service.listComments.mock.calls[0][2]).toMatchObject({
      limit: 50,
      cursor: CURSOR,
    });
  });

  it('challenge list forwards inherited limit + cursor alongside cohort_id/status', async () => {
    const query = new ListChallengesQueryDto();
    Object.assign(query, { status: 'active', limit: 10, cursor: CURSOR });
    await controller.list(reqFor(user), WS, query);
    expect(service.list).toHaveBeenCalledWith(user, WS, query);
    expect(service.list.mock.calls[0][2]).toMatchObject({
      status: 'active',
      limit: 10,
      cursor: CURSOR,
    });
  });
});
