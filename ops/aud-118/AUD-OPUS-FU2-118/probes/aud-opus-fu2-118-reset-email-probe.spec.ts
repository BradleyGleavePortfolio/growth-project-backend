/**
 * AUD-OPUS-FU2-118 probe (Claude Opus 5.5 lens, agent 118) on #700 @ 66569a61.
 * Not for merge. Claim under test (src/observability/README.md, added by
 * #700): "Text the service does not write itself (a provider's error body, an
 * exception message) goes through redactEmailAddresses first, because
 * providers echo addresses back."
 * Supabase Auth echoes the address in email_address_invalid errors
 * ("Email address \"a@a.com\" is invalid", supabase/auth#2252), and
 * AuthService.forgotPassword (public POST, caller-supplied address) logs
 * `resetPasswordForEmail failed: ${error.message}` unredacted.
 * Expected at the PR head: FAIL (the address reaches a log line).
 */
import { Logger } from '@nestjs/common';
import { AuthService } from '../../src/auth/auth.service';

const ADDRESS = 'pat.client+tgp@example.com';

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        resetPasswordForEmail: jest.fn(async (email: string) => ({
          data: null,
          error: { message: `Email address "${email}" is invalid`, code: 'email_address_invalid', status: 400 },
        })),
      },
    })),
  };
});

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

afterEach(() => jest.restoreAllMocks());

describe('AUD-OPUS-FU2-118 probe: forgotPassword and a Supabase error that echoes the address', () => {
  it('no log line holds the address', async () => {
    const spies = LEVELS.map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const anyMock = {} as never;
    const service = new AuthService(anyMock, anyMock, anyMock, anyMock, anyMock, anyMock);
    await service.forgotPassword(ADDRESS).catch(() => undefined);
    const lines = spies.flatMap((spy) =>
      spy.mock.calls.map((args: unknown[]) => args.map((a) => String(a)).join(' ')),
    );
    expect(lines.join('\n')).toContain('resetPasswordForEmail failed');
    for (const line of lines) {
      expect(line).not.toContain('@');
      expect(line).not.toContain('pat.client');
    }
  });
});
