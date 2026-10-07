// B-EMAILFROM-126 — every email the backend sends uses ONE From address,
// EMAIL_FROM_ADDRESS, and a live transport with no valid sender fails closed
// with a log line naming the variable (no silent fallback to a domain that
// is not verified with Resend). The 'log' transport keeps working with no
// email env at all.
//
// Fails on main: the digest sent from 'noreply@thegrowthproject.app' when
// EMAIL_FROM_ADDRESS was unset, and the guest welcome email read a second
// variable (RESEND_FROM_EMAIL) and fell back to welcome@trygrowthproject.com.

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  DEV_EMAIL_FROM_ADDRESS,
  EmailSenderConfigError,
  parseEmailSender,
  resolveEmailSender,
} from '../src/email/email-sender';
import { DigestService } from '../src/notifications/digest.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';

const VERIFIED = 'The Growth Project <noreply@growthprojectapp.com>';

function okResponse(): Response {
  return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
}

function fromOf(fetchMock: jest.SpyInstance): unknown {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)).from;
}

describe('resolveEmailSender', () => {
  it('returns the configured sender for any transport', () => {
    const config = new ConfigService({ EMAIL_FROM_ADDRESS: `  ${VERIFIED} ` });
    expect(resolveEmailSender(config, 'resend')).toBe(VERIFIED);
    expect(resolveEmailSender(config, 'log')).toBe(VERIFIED);
  });

  it('keeps the dev/test log transport working with no sender set', () => {
    expect(resolveEmailSender(new ConfigService({}), 'log')).toBe(DEV_EMAIL_FROM_ADDRESS);
  });

  it('refuses a live transport with no sender and names the variable', () => {
    expect(() => resolveEmailSender(new ConfigService({}), 'resend')).toThrow(EmailSenderConfigError);
    expect(() => resolveEmailSender(new ConfigService({ EMAIL_FROM_ADDRESS: ' ' }), 'resend')).toThrow(
      /EMAIL_FROM_ADDRESS is not set/,
    );
    expect(() =>
      resolveEmailSender(new ConfigService({ EMAIL_FROM_ADDRESS: 'a@x.com, b@y.com' }), 'resend'),
    ).toThrow(/EMAIL_FROM_ADDRESS is not a valid sender address/);
  });

  it('parses bare and display-name senders and reports the domain', () => {
    expect(parseEmailSender('noreply@GrowthProjectApp.com')?.domain).toBe('growthprojectapp.com');
    expect(parseEmailSender(VERIFIED)?.address).toBe('noreply@growthprojectapp.com');
    expect(parseEmailSender('no-at-sign')).toBeNull();
    expect(parseEmailSender('a@b.com\r\nBcc: c@d.com')).toBeNull();
  });
});

describe('DigestService sender', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse());
  });
  afterEach(() => jest.restoreAllMocks());

  function digest(env: Record<string, string>): DigestService {
    return new DigestService(
      Object.create(PrismaService.prototype),
      Object.create(NotificationsService.prototype),
      new ConfigService(env),
    );
  }

  it('sends from EMAIL_FROM_ADDRESS', async () => {
    const svc = digest({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM_ADDRESS: VERIFIED });
    await svc['_send']('u1', 'client@example.com', 'Your daily summary', 'digest-client', {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fromOf(fetchMock)).toBe(VERIFIED);
  });

  it('sends nothing and names the variable when EMAIL_FROM_ADDRESS is unset (no wrong-domain fallback)', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = digest({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' });
    await expect(
      svc['_send']('u1', 'client@example.com', 'Your daily summary', 'digest-client', {}),
    ).rejects.toThrow(EmailSenderConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('digest not sent: EMAIL_FROM_ADDRESS is not set'));
  });

  it('log transport still works with no sender set', async () => {
    const svc = digest({ EMAIL_TRANSPORT: 'log' });
    await expect(
      svc['_send']('u1', 'client@example.com', 'Your daily summary', 'digest-client', {}),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GuestCheckoutService welcome email sender', () => {
  let fetchMock: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const checkout = {
    id: 'chk_1',
    guest_email: 'guest@example.com',
    guest_name: 'Sam',
    receipt_url: null,
    package: { name: 'Strength 12', coach: { name: 'Coach Lee' } },
  };

  async function sendWelcome(env: Record<string, string>): Promise<void> {
    const svc: GuestCheckoutService = Object.create(GuestCheckoutService.prototype);
    Object.defineProperty(svc, 'config', { value: new ConfigService(env) });
    Object.defineProperty(svc, 'logger', { value: new Logger('GuestCheckoutService') });
    await Reflect.apply(svc['sendWelcomeEmail'], svc, [checkout, null]);
  }

  it('uses the shared EMAIL_FROM_ADDRESS, not the retired RESEND_FROM_EMAIL', async () => {
    await sendWelcome({
      RESEND_API_KEY: 're_test',
      EMAIL_FROM_ADDRESS: VERIFIED,
      RESEND_FROM_EMAIL: 'Growth Project <welcome@unverified.example.com>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fromOf(fetchMock)).toBe(VERIFIED);
  });

  it('sends nothing and names the variable when EMAIL_FROM_ADDRESS is unset', async () => {
    await sendWelcome({ RESEND_API_KEY: 're_test' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(/Welcome email not sent for chk_1: EMAIL_FROM_ADDRESS is not set/),
    );
  });
});
