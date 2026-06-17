/**
 * TalentConnectAdapter — unit tests (TM-10)
 *
 * The adapter is thin and compose-only: it delegates to the existing
 * CoachConnectService (mocked here) and layers on a deterministic Stripe
 * Idempotency-Key, a 10s AbortController timeout guard, and structured
 * provider error envelopes. Tests are hermetic — no Stripe, no DB.
 */

import { createHash } from 'node:crypto';
import {
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// The adapter throws ServiceUnavailableException(<code:string>); Nest stores
// that string as the `message` of the response payload. Pull the safe code
// back out for assertions.
function safeCode(err: unknown): string {
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  const response = (err as HttpException).getResponse();
  return typeof response === 'string'
    ? response
    : String((response as { message?: unknown }).message);
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return safeCode(err);
  }
  throw new Error('expected promise to reject but it resolved');
}
import {
  CoachConnectService,
  CoachConnectStatus,
  OnboardingLink,
} from '../src/coach-connect/coach-connect.service';
import { TalentConnectAdapter } from '../src/talent-marketplace/connect-adapter.service';

interface CoachConnectMock {
  createOnboardingLink: jest.Mock<Promise<OnboardingLink>, [string]>;
  getStatus: jest.Mock<Promise<CoachConnectStatus>, [string]>;
}

function makeCoachConnect(): CoachConnectMock {
  return {
    createOnboardingLink: jest.fn(),
    getStatus: jest.fn(),
  };
}

// Mirrors the adapter's internal PROVIDER_TIMEOUT_MS (kept private there).
const PROVIDER_TIMEOUT_MS = 10_000;

const LINK: OnboardingLink = {
  url: 'https://connect.stripe.com/setup/acct_1',
  expires_at: '2026-06-17T00:00:00.000Z',
};

const STATUS: CoachConnectStatus = {
  configured: true,
  charges_enabled: true,
  payouts_enabled: true,
  account_id: 'acct_1',
  last_onboarded_at: '2026-06-17T00:00:00.000Z',
  requirements_due: ['individual.verification.document'],
};

describe('TalentConnectAdapter', () => {
  let adapter: TalentConnectAdapter;
  let coachConnect: ReturnType<typeof makeCoachConnect>;

  beforeEach(async () => {
    coachConnect = makeCoachConnect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TalentConnectAdapter,
        { provide: CoachConnectService, useValue: coachConnect },
      ],
    }).compile();
    adapter = module.get(TalentConnectAdapter);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('createOnboardingLink', () => {
    it('delegates to CoachConnectService.createOnboardingLink', async () => {
      coachConnect.createOnboardingLink.mockResolvedValue(LINK);

      const result = await adapter.createOnboardingLink('coach-1');

      expect(coachConnect.createOnboardingLink).toHaveBeenCalledWith('coach-1');
      expect(result.url).toBe(LINK.url);
      expect(result.expires_at).toBe(LINK.expires_at);
    });

    it('derives a deterministic Idempotency-Key with crypto.createHash', async () => {
      coachConnect.createOnboardingLink.mockResolvedValue(LINK);

      const expectedDigest = createHash('sha256')
        .update('coach-1:talent-onboarding')
        .digest('hex')
        .slice(0, 32);

      const first = await adapter.createOnboardingLink('coach-1');
      const second = await adapter.createOnboardingLink('coach-1');

      expect(first.idempotency_key).toBe(`talent-connect-${expectedDigest}`);
      // Deterministic: identical (coach, context) yields identical key.
      expect(second.idempotency_key).toBe(first.idempotency_key);
    });

    it('namespaces the key per returnContext', async () => {
      coachConnect.createOnboardingLink.mockResolvedValue(LINK);

      const a = await adapter.createOnboardingLink('coach-1', 'apply');
      const b = await adapter.createOnboardingLink('coach-1', 'offer-accept');

      expect(a.idempotency_key).not.toBe(b.idempotency_key);
    });

    it('uses a real crypto digest, not a hand-rolled 32-bit hash', async () => {
      coachConnect.createOnboardingLink.mockResolvedValue(LINK);

      const result = await adapter.createOnboardingLink('coach-1');
      const digest = result.idempotency_key.replace('talent-connect-', '');

      // A real sha256 hex slice is 32 lowercase hex chars; the dropped
      // hand-rolled hash produced a short variable-length base-16 string.
      expect(digest).toMatch(/^[0-9a-f]{32}$/);
      expect(digest).toBe(
        createHash('sha256')
          .update('coach-1:talent-onboarding')
          .digest('hex')
          .slice(0, 32),
      );
    });

    it('wraps provider failure in PAYMENTS_PROVIDER_ERROR envelope', async () => {
      coachConnect.createOnboardingLink.mockRejectedValue(
        new Error('stripe exploded with sk_live_secret in the message'),
      );

      expect(await rejectionCode(adapter.createOnboardingLink('coach-1'))).toBe(
        'PAYMENTS_PROVIDER_ERROR',
      );
    });

    it('maps a CONNECT_NOT_CONFIGURED failure to CONNECT_ONBOARDING_UNAVAILABLE', async () => {
      coachConnect.createOnboardingLink.mockRejectedValue(
        new ServiceUnavailableException({
          error: 'CONNECT_NOT_CONFIGURED',
          message: 'Stripe Connect is not configured on this environment.',
        }),
      );

      expect(await rejectionCode(adapter.createOnboardingLink('coach-1'))).toBe(
        'CONNECT_ONBOARDING_UNAVAILABLE',
      );
    });

    it('aborts and surfaces PAYMENTS_PROVIDER_TIMEOUT after 10s', async () => {
      jest.useFakeTimers();
      // Never settles — the AbortController must win the race.
      coachConnect.createOnboardingLink.mockReturnValue(
        new Promise<OnboardingLink>(() => {}),
      );

      const pending = adapter.createOnboardingLink('coach-1');
      const settled = rejectionCode(pending);

      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
      expect(await settled).toBe('PAYMENTS_PROVIDER_TIMEOUT');
      jest.useRealTimers();
    });
  });

  describe('getStatus', () => {
    it('maps the shared status onto the talent contract', async () => {
      coachConnect.getStatus.mockResolvedValue(STATUS);

      const result = await adapter.getStatus('coach-1');

      expect(coachConnect.getStatus).toHaveBeenCalledWith('coach-1');
      expect(result).toEqual({
        onboarded: true,
        charges_enabled: true,
        payouts_enabled: true,
        account_id: 'acct_1',
        requirements_due: ['individual.verification.document'],
      });
    });

    it('reports onboarded=false when a capability is missing', async () => {
      coachConnect.getStatus.mockResolvedValue({
        ...STATUS,
        payouts_enabled: false,
      });

      const result = await adapter.getStatus('coach-1');

      expect(result.onboarded).toBe(false);
      expect(result.charges_enabled).toBe(true);
      expect(result.payouts_enabled).toBe(false);
    });

    it('wraps status provider failure in the safe envelope', async () => {
      coachConnect.getStatus.mockRejectedValue(new Error('boom'));

      expect(await rejectionCode(adapter.getStatus('coach-1'))).toBe(
        'PAYMENTS_PROVIDER_ERROR',
      );
    });
  });
});
