/**
 * AUD-SOL-FU2-118: exact-head adversarial privacy probes. Synthetic data only.
 * These assertions express the PR's no-address/name/free-text log boundary.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../src/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { Request } from 'express';
import { EmailService } from '../../src/email/email.service';
import { EmailTemplateKey } from '../../src/email/email.types';
import { DigestService } from '../../src/notifications/digest.service';
import { SchedulingWebhookController } from '../../src/scheduling/scheduling-webhook.controller';

const PERSON = 'Patricia Quill';
const ADDRESS = 'patricia.quill@example.test';
const PRIVATE_TEXT = 'private consultation details';
const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
const realFetch = global.fetch;

function fake<T>(value: unknown): T {
  return value as T;
}

function config(values: Record<string, string | undefined>): ConfigService {
  return fake<ConfigService>({ get: (key: string) => values[key] });
}

function spyLogs(): () => string {
  const spies = LEVELS.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

function emailDb() {
  return {
    emailSendLog: {
      create: jest.fn().mockResolvedValue({ id: 'row-privacy-probe' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

const input = {
  to: ADDRESS,
  template: EmailTemplateKey.NUDGE_ONBOARDING_ABANDONED,
  data: { first_name: 'Patricia', app_url: 'https://app.example.test' },
  idempotencyKey: 'probe:user-1',
};

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('B-700-1: email/digest error diagnostics are codes, not arbitrary provider/exception text', () => {
  it('EmailService provider failure cannot retain a display name or other free text', async () => {
    const logs = spyLogs();
    const db = emailDb();
    global.fetch = fake<typeof fetch>(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({ message: `Invalid recipient ${PERSON} <${ADDRESS}>; ${PRIVATE_TEXT}` }),
      }),
    );
    const svc = new EmailService(
      fake<PrismaService>(db),
      config({
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_test',
        EMAIL_FROM_ADDRESS: 'team@example.test',
      }),
    );
    const result = await svc.send(input);
    expect(result.status).toBe('failed');
    expect(logs()).toContain('row=row-privacy-probe');
    expect(logs()).not.toContain(ADDRESS);
    const stored = String(db.emailSendLog.update.mock.calls[0][0].data.error);
    const diagnosticSurfaces = `${logs()} ${result.error} ${stored}`;
    expect(diagnosticSurfaces).not.toContain(PERSON);
    expect(diagnosticSurfaces).not.toContain(PRIVATE_TEXT);
  });

  it('EmailService render exception cannot retain the template recipient name', async () => {
    spyLogs();
    const db = emailDb();
    const svc = new EmailService(fake<PrismaService>(db), config({}));
    jest.spyOn(svc, 'render').mockImplementation(() => {
      throw new Error(`Cannot render greeting for ${PERSON}; ${PRIVATE_TEXT}`);
    });
    const result = await svc.send(input);
    expect(result.status).toBe('failed');
    const stored = String(db.emailSendLog.update.mock.calls[0][0].data.error);
    expect(`${result.error} ${stored}`).not.toContain(PERSON);
    expect(`${result.error} ${stored}`).not.toContain(PRIVATE_TEXT);
  });

  it('DigestService provider failure cannot log/store a display name or free text', async () => {
    const logs = spyLogs();
    const notifications = {
      claimDigestWindow: jest.fn().mockResolvedValue('digest-probe'),
      createNotification: jest.fn().mockResolvedValue({}),
      markDigestSent: jest.fn().mockResolvedValue(undefined),
      markDigestFailed: jest.fn().mockResolvedValue(undefined),
    };
    global.fetch = fake<typeof fetch>(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({ message: `Invalid recipient ${PERSON} <${ADDRESS}>; ${PRIVATE_TEXT}` }),
      }),
    );
    const svc = new DigestService(
      fake<PrismaService>({}),
      fake<NotificationsService>(notifications),
      config({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' }),
    );
    const internals = fake<{
      _activeClientsWithEmailDigest: () => Promise<unknown>;
      _buildClientDigestData: () => Promise<unknown>;
    }>(svc);
    jest
      .spyOn(internals, '_activeClientsWithEmailDigest')
      .mockResolvedValue([{ id: 'user-1', email: ADDRESS, name: PERSON }]);
    jest.spyOn(internals, '_buildClientDigestData').mockResolvedValue({
      date: 'test-date',
      checkins: [],
      weightMetrics: [],
      streakMetrics: [],
    });
    await svc.sendClientDailyDigests();
    expect(notifications.markDigestFailed).toHaveBeenCalledTimes(1);
    expect(logs()).not.toContain(ADDRESS);
    const stored = String(notifications.markDigestFailed.mock.calls[0][1]);
    expect(`${logs()} ${stored}`).not.toContain(PERSON);
    expect(`${logs()} ${stored}`).not.toContain(PRIVATE_TEXT);
  });

  it('Resend body must not be truncated before removing an address crossing the cut', async () => {
    const logs = spyLogs();
    const db = emailDb();
    global.fetch = fake<typeof fetch>(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => `${' '.repeat(488)}${ADDRESS}`,
      }),
    );
    const svc = new EmailService(
      fake<PrismaService>(db),
      config({
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_test',
        EMAIL_FROM_ADDRESS: 'team@example.test',
      }),
    );
    const result = await svc.send(input);
    const stored = String(db.emailSendLog.update.mock.calls[0][0].data.error);
    expect(`${logs()} ${result.error} ${stored}`).not.toContain('patricia.qu');
  });
});

describe('B-700-2: webhook shape labels must be finite server-owned labels, not attacker-controlled tokens', () => {
  it.each(['zoom', 'googleCalendar'] as const)(
    '%s cannot publish a syntactically valid private name as an event or object key',
    async (handler) => {
      const logs = spyLogs();
      const savedSecret = process.env.SCHEDULING_WEBHOOK_SECRET;
      delete process.env.SCHEDULING_WEBHOOK_SECRET;
      try {
        const ctrl = new SchedulingWebhookController();
        const res = await ctrl[handler](
          { event: 'Patricia-Quill', 'Patricia-Quill': { details: PRIVATE_TEXT } },
          fake<Request>({ headers: {} }),
        );
        expect(res).toEqual({ ok: true, handler: 'stub' });
        expect(logs()).not.toContain('Patricia-Quill');
        expect(logs()).not.toContain(PRIVATE_TEXT);
      } finally {
        if (savedSecret === undefined) delete process.env.SCHEDULING_WEBHOOK_SECRET;
        else process.env.SCHEDULING_WEBHOOK_SECRET = savedSecret;
      }
    },
  );
});
