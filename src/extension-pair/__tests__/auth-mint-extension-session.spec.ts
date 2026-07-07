// Focused coverage for AuthService.mintExtensionSessionForCoach — the token
// authority reused by the pairing redeem flow (R80). We mock @supabase/supabase-js
// so no network is touched: the admin client's generateLink returns a hashed
// OTP token and the anon client's verifyOtp exchanges it for a session.
import { InternalServerErrorException } from '@nestjs/common';

const generateLink = jest.fn();
const verifyOtp = jest.fn();
const refreshSession = jest.fn();
const signInWithPassword = jest.fn();

function signInWithPasswordCalled(): boolean {
  return signInWithPassword.mock.calls.length > 0;
}

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      admin: { generateLink },
      verifyOtp,
      refreshSession,
      signInWithPassword,
    },
  }),
}));

import { makeAuthServiceUnderTest } from './test-doubles';

function makeAuthService(userEmail: string | null) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(userEmail ? { email: userEmail } : null),
    },
  };
  const svc = makeAuthServiceUnderTest(prisma);
  return { svc, prisma };
}

describe('AuthService.mintExtensionSessionForCoach', () => {
  beforeEach(() => {
    generateLink.mockReset();
    verifyOtp.mockReset();
    signInWithPassword.mockReset();
  });

  it('mints a Supabase session pair for the coach by identity', async () => {
    const { svc, prisma } = makeAuthService('coach@example.com');
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash-1' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'access-1', refresh_token: 'refresh-1' } },
      error: null,
    });

    const result = await svc.mintExtensionSessionForCoach('coach-1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'coach-1' },
      select: { email: true },
    });
    expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'coach@example.com' });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'email' });
    expect(result).toEqual({ access_token: 'access-1', refresh_token: 'refresh-1' });
  });

  it('throws when the coach user no longer exists', async () => {
    const { svc } = makeAuthService(null);
    await expect(svc.mintExtensionSessionForCoach('ghost')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('throws when generateLink returns no hashed token', async () => {
    const { svc } = makeAuthService('coach@example.com');
    generateLink.mockResolvedValue({ data: { properties: {} }, error: null });
    await expect(svc.mintExtensionSessionForCoach('coach-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('throws when verifyOtp returns no session', async () => {
    const { svc } = makeAuthService('coach@example.com');
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash-1' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({ data: { session: null }, error: { message: 'bad otp' } });
    await expect(svc.mintExtensionSessionForCoach('coach-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('never replays a password — the redeem flow has no credential to sign in with', async () => {
    const { svc } = makeAuthService('coach@example.com');
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash-1' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'a', refresh_token: 'r' } },
      error: null,
    });

    await svc.mintExtensionSessionForCoach('coach-1');
    // signInWithPassword lives on the same mocked auth surface; it must stay
    // untouched — R80: the session is minted by identity, not by password.
    expect(signInWithPasswordCalled()).toBe(false);
  });

  it('returns exactly the two session tokens and nothing else', async () => {
    const { svc } = makeAuthService('coach@example.com');
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash-1' } },
      error: null,
    });
    verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          // Supabase returns more than we surface; ensure we do not leak extras.
          provider_token: 'SHOULD_NOT_LEAK',
          user: { id: 'u1' },
        },
      },
      error: null,
    });

    const result = await svc.mintExtensionSessionForCoach('coach-1');
    expect(Object.keys(result).sort()).toEqual(['access_token', 'refresh_token']);
  });

  it('surfaces a Supabase generateLink error as a 500 (never a silent empty session)', async () => {
    const { svc } = makeAuthService('coach@example.com');
    generateLink.mockResolvedValue({
      data: { properties: {} },
      error: { message: 'supabase down' },
    });
    await expect(svc.mintExtensionSessionForCoach('coach-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
