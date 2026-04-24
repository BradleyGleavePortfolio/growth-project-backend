import { InviteCodesController } from '../src/invite-codes/invite-codes.controller';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

// Thin controller test — the meat is in invite-codes.service.spec.ts. This
// pins two things: (1) req.user.id is the coach scope for every mutation,
// (2) IDOR/404 errors from the service bubble unchanged to the HTTP layer.
describe('InviteCodesController (auth scoping)', () => {
  let serviceMock: any;
  let controller: InviteCodesController;

  beforeEach(() => {
    serviceMock = {
      createForCoach: jest.fn().mockResolvedValue({ id: 'ic-1', code: 'GP-ABC123' }),
      listForCoach: jest.fn().mockResolvedValue([]),
      revokeForCoach: jest.fn(),
    };
    controller = new InviteCodesController(serviceMock as any);
  });

  const reqAs = (id: string, role: 'coach' | 'student' = 'coach') =>
    ({ user: { id, role } } as any);

  it('create/list/revoke pass the caller\'s user id as the coach scope', async () => {
    await controller.create(reqAs('coach-1'), {});
    expect(serviceMock.createForCoach).toHaveBeenCalledWith('coach-1', {});

    await controller.list(reqAs('coach-2'));
    expect(serviceMock.listForCoach).toHaveBeenCalledWith('coach-2');

    serviceMock.revokeForCoach.mockResolvedValue({ id: 'ic-1', revoked: true });
    await controller.revoke(reqAs('coach-3'), 'ic-1');
    expect(serviceMock.revokeForCoach).toHaveBeenCalledWith('coach-3', 'ic-1');
  });

  it('propagates Forbidden when the service reports IDOR on revoke', async () => {
    serviceMock.revokeForCoach.mockRejectedValue(new ForbiddenException());
    await expect(controller.revoke(reqAs('coach-1'), 'ic-other')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('propagates NotFound on missing invite code', async () => {
    serviceMock.revokeForCoach.mockRejectedValue(new NotFoundException());
    await expect(controller.revoke(reqAs('coach-1'), 'ic-missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
