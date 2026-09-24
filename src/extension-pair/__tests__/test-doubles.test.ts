/**
 * Typed test doubles for the extension-pair specs.
 *
 * The specs stub only the handful of collaborators each unit under test reads
 * (a couple of Prisma delegates, the AuthService mint helper, the service the
 * controller calls, and a minimal authed request). The structural widens live
 * HERE, in one documented place, rather than being sprinkled across every spec.
 *
 * Each widen uses a justified `@ts-expect-error` — the repo's sanctioned escape
 * for partial structural mocks (see src/regimes/__tests__/prisma-test-double.ts
 * and src/community/voice/__tests__) rather than the banned unchecked-cast
 * tokens (R75). Callers keep full autocomplete on the mock literal.
 */

import type { ExecutionContext } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import type { PrismaService } from '../../prisma.service';
import type { AuthedRequest } from '../../auth/auth-request';
import type { ExtensionPairService } from '../extension-pair.service';

export function asPrismaDouble<T extends object>(mock: T): PrismaService {
  // @ts-expect-error partial structural mock — specs stub only the delegates
  // the service under test reads (R0-sanctioned escape).
  return mock;
}

// Hermetic transaction plumbing only; rollback/locking proof uses real PG.
export function withSetupTransaction<T extends object>(mock: T) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'coach-1' }]),
    importIntent: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    ...mock,
  };
  return {
    ...tx,
    $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  };
}

export function asAuthDouble<T extends object>(mock: T): AuthService {
  // @ts-expect-error partial structural mock — specs stub only the AuthService
  // methods the service under test calls.
  return mock;
}

export function asPairServiceDouble<T extends object>(mock: T): ExtensionPairService {
  // @ts-expect-error partial structural mock — specs stub only the service
  // methods the controller calls.
  return mock;
}

export function authedRequest(userId: string): AuthedRequest {
  // @ts-expect-error minimal authed request — the handlers read only req.user.id.
  return { user: { id: userId } };
}

// Minimal ExecutionContext whose only exercised path is
// switchToHttp().getRequest() → { user }. Guards under test read nothing else.
export function executionContextFor(user: unknown): ExecutionContext {
  // @ts-expect-error partial ExecutionContext — only switchToHttp().getRequest()
  // is touched by the guards (R0-sanctioned escape; see doc comment above).
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) };
}

/**
 * Construct the real AuthService with a partial Prisma double and no-op stand-ins
 * for its other injected collaborators. The mint spec mocks @supabase/supabase-js
 * at the module level and exercises only paths that read prisma + the Supabase
 * clients, so the other services are never invoked.
 */
export function makeAuthServiceUnderTest(prismaMock: object): AuthService {
  const noop = {};
  // @ts-expect-error partial construction — see doc comment above (R0-sanctioned).
  return new AuthService(prismaMock, noop, noop, noop, noop, noop);
}
