/**
 * B-608-7: every authenticated account, including a sub-coach, can delete
 * itself. Self-scoped endpoints carry no @Roles restriction; the admin
 * force-delete stays owner-only.
 */
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AccountDeletionController } from '../../src/account-deletion/account-deletion.controller';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { RolesGuard } from '../../src/auth/roles.guard';
import { RecentAuthGuard } from '../../src/auth/recent-auth.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import type { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const reflector = new Reflector();
const proto = AccountDeletionController.prototype;
type Handler =
  'requestDeletion' | 'confirmDeletion' | 'cancelDeletion' | 'getStatus' | 'adminForceDelete';
const handler = (name: Handler) => proto[name];

describe('account deletion controller roles', () => {
  it('authenticates every endpoint with JwtAuthGuard at the class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AccountDeletionController)).toContain(JwtAuthGuard);
  });

  it.each(['requestDeletion', 'confirmDeletion', 'cancelDeletion', 'getStatus'] as const)(
    '%s has no role restriction and no RolesGuard',
    (name) => {
      expect(reflector.get(ROLES_KEY, handler(name))).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).not.toContain(RolesGuard);
    },
  );

  it('request still requires a fresh re-auth token', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('requestDeletion'))).toContain(
      RecentAuthGuard,
    );
  });

  it('admin force-delete stays owner-only', () => {
    expect(reflector.get(ROLES_KEY, handler('adminForceDelete'))).toEqual(['owner']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('adminForceDelete'))).toContain(RolesGuard);
  });

  it('a sub-coach request reaches the service scoped to its own id', async () => {
    const service = { requestDeletion: jest.fn().mockResolvedValue({ state: 'confirmed' }) };
    const controller = new AccountDeletionController(stub<AccountDeletionService>(service));
    await controller.requestDeletion(
      stub<Parameters<AccountDeletionController['requestDeletion']>[0]>({
        user: { id: 'sub-coach-1', role: 'sub_coach' },
        ip: '10.0.0.1',
        headers: {},
      }),
      { apple_authorization_code: undefined },
    );
    expect(service.requestDeletion).toHaveBeenCalledWith(
      'sub-coach-1',
      expect.objectContaining({ appleAuthorizationCode: null }),
    );
  });
});
