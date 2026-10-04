/**
 * B-PRIVFU2-118 (agent 118): permanent replays of both lenses' #700 probes at
 * 66569a61, so the shapes they used stay covered. Synthetic data only.
 *  - GPT-6.1 Sol (AUD-SOL-FU2-118, run 37218198321): B-700-1 provider and
 *    render failure text with a display name and free text, through the
 *    email log, `EmailSendLog.error`, `SendEmailResult.error` and the digest
 *    failure row; an address crossing the old 500-character cut; B-700-2 a
 *    crafted webhook event name and key on both public stubs.
 *  - Claude Opus 5.5 (AUD-OPUS-FU2-118, run 37219384148): B-700-1 the coach
 *    brief log lines and the coach's name; B-700-2 a Supabase reset error
 *    that echoes the address, and the finance federation path that holds it.
 * Each case also checks the id or code that lets support find the failure.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { PrismaService } from '../../src/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { EmailService } from '../../src/email/email.service';
import { EmailTemplateKey } from '../../src/email/email.types';
import { DigestService } from '../../src/notifications/digest.service';
import { SchedulingWebhookController } from '../../src/scheduling/scheduling-webhook.controller';
import { CoachBriefService } from '../../src/coach/brief/coach-brief.service';
import type { BriefAiInput } from '../../src/coach/brief/coach-brief.service';
import { FinanceAdminClient } from '../../src/admin/federation/finance-admin.client';
import { AuthService } from '../../src/auth/auth.service';
import { clientDataSubject } from '../../src/ai-egress/ai-egress.types';
import {
  asAnthropic,
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeMockAnthropic,
  makeMockConfig,
  makeMockPrisma,
} from '../_fixtures/coach-brief-mocks';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';

const PERSON = 'Patricia Quill';
const SURNAME = 'Quillfeather';
const ADDRESS = 'patricia.quill@example.test';
const RESET_ADDRESS = 'pat.client+tgp@example.com';
const PRIVATE_TEXT = 'private consultation details';
const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

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

const realFetch = global.fetch;

function fake<T>(value: unknown): T {
  return value as T;
}

function config(values: Record<string, string | undefined>): ConfigService {
  return fake<ConfigService>({ get: (key: string) => values[key] });
}

function spyLogs(): () => string[] {
  const spies = LEVELS.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map((args: unknown[]) =>
        args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '),
      ),
    );
}

function expectNone(surface: string, ...needles: string[]): void {
  for (const needle of needles) expect(surface).not.toContain(needle);
}

function emailDb() {
  return {
    emailSendLog: {
      create: jest.fn().mockResolvedValue({ id: 'row-privacy-probe' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function resendFailure(status: number, body: string): typeof fetch {
  return fake<typeof fetch>(jest.fn().mockResolvedValue({ ok: false, status, text: async () => body }));
}

const resendConfig = config({
  EMAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM_ADDRESS: 'team@example.test',
});

const input = {
  to: ADDRESS,
  template: EmailTemplateKey.NUDGE_ONBOARDING_ABANDONED,
  data: { first_name: 'Patricia', app_url: 'https://app.example.test' },
  idempotencyKey: 'probe:user-1',
};

const saved = {
  base: process.env.FINANCE_API_BASE_URL,
  token: process.env.FINANCE_SERVICE_TOKEN,
  secret: process.env.SCHEDULING_WEBHOOK_SECRET,
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
  restoreEnv('FINANCE_API_BASE_URL', saved.base);
  restoreEnv('FINANCE_SERVICE_TOKEN', saved.token);
  restoreEnv('SCHEDULING_WEBHOOK_SECRET', saved.secret);
});

describe('Sol B-700-1 replay: provider and render failures keep codes, never text', () => {
  it('EmailService provider failure with a display name and free text', async () => {
    const logs = spyLogs();
    const db = emailDb();
    global.fetch = resendFailure(
      422,
      JSON.stringify({ message: `Invalid recipient ${PERSON} <${ADDRESS}>; ${PRIVATE_TEXT}` }),
    );
    const result = await new EmailService(fake<PrismaService>(db), resendConfig).send(input);
    expect(result.status).toBe('failed');
    const stored = String(db.emailSendLog.update.mock.calls[0][0].data.error);
    const surfaces = `${logs().join('\n')} ${result.error} ${stored}`;
    expectNone(surfaces, ADDRESS, PERSON, PRIVATE_TEXT, '@');
    expect(logs().join('\n')).toContain('row=row-privacy-probe');
    expect(result.error).toBe('provider=resend status=422 code=other');
    expect(stored).toBe('provider=resend status=422 code=other');
  });

  it('control: a Resend error name from the documented list is kept', async () => {
    spyLogs();
    const db = emailDb();
    global.fetch = resendFailure(
      422,
      JSON.stringify({ name: 'validation_error', message: `Invalid recipient ${PERSON} <${ADDRESS}>` }),
    );
    const result = await new EmailService(fake<PrismaService>(db), resendConfig).send(input);
    expect(result.error).toBe('provider=resend status=422 code=validation_error');
  });

  it('EmailService render exception that quotes the recipient name', async () => {
    const logs = spyLogs();
    const db = emailDb();
    const svc = new EmailService(fake<PrismaService>(db), config({}));
    jest.spyOn(svc, 'render').mockImplementation(() => {
      throw new Error(`Cannot render greeting for ${PERSON}; ${PRIVATE_TEXT}`);
    });
    const result = await svc.send(input);
    expect(result.status).toBe('failed');
    const stored = String(db.emailSendLog.update.mock.calls[0][0].data.error);
    expectNone(`${logs().join('\n')} ${result.error} ${stored}`, PERSON, PRIVATE_TEXT);
    expect(result.error).toBe('render: error=Error');
    expect(stored).toBe('render: error=Error');
  });

  it('DigestService provider failure with a display name and free text', async () => {
    const logs = spyLogs();
    const notifications = {
      claimDigestWindow: jest.fn().mockResolvedValue('digest-probe'),
      createNotification: jest.fn().mockResolvedValue({}),
      markDigestSent: jest.fn().mockResolvedValue(undefined),
      markDigestFailed: jest.fn().mockResolvedValue(undefined),
    };
    global.fetch = resendFailure(
      422,
      JSON.stringify({ message: `Invalid recipient ${PERSON} <${ADDRESS}>; ${PRIVATE_TEXT}` }),
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
    const stored = String(notifications.markDigestFailed.mock.calls[0][1]);
    expectNone(`${logs().join('\n')} ${stored}`, ADDRESS, PERSON, PRIVATE_TEXT, '@');
    expect(stored).toBe('provider=resend status=422 code=other');
    expect(logs().join('\n')).toContain('user=user-1');
  });

  it('an address that crossed the old 500-character cut leaves no fragment', async () => {
    const logs = spyLogs();
    const db = emailDb();
    global.fetch = resendFailure(422, `${' '.repeat(488)}${ADDRESS}`);
    const result = await new EmailService(fake<PrismaService>(db), resendConfig).send(input);
    const stored = String(db.emailSendLog.update.mock.calls[0][0].data.error);
    expectNone(`${logs().join('\n')} ${result.error} ${stored}`, 'patricia.qu', '@');
    expect(result.error).toBe('provider=resend status=422 code=unparsed');
  });
});

describe('Sol B-700-2 / Opus C-700-5 replay: webhook stubs log finite labels only', () => {
  it.each(['zoom', 'googleCalendar'] as const)(
    '%s: a crafted event name and key are counted, never shown',
    async (handler) => {
      const logs = spyLogs();
      delete process.env.SCHEDULING_WEBHOOK_SECRET;
      const res = await new SchedulingWebhookController()[handler](
        { event: 'Patricia-Quill', 'Patricia-Quill': { details: PRIVATE_TEXT } },
        fake<Request>({ headers: {} }),
      );
      expect(res).toEqual({ ok: true, handler: 'stub' });
      expectNone(logs().join('\n'), 'Patricia', PRIVATE_TEXT);
      expect(logs().join('\n')).toContain('event=other keys=event other_keys=1');
    },
  );

  it('control: a recognised Zoom event and its envelope keys are named', async () => {
    const logs = spyLogs();
    delete process.env.SCHEDULING_WEBHOOK_SECRET;
    await new SchedulingWebhookController().zoom(
      { event: 'meeting.started', event_ts: 1, payload: { object: { host_email: ADDRESS } } },
      fake<Request>({ headers: {} }),
    );
    expect(logs().join('\n')).toContain('event=meeting.started keys=event,event_ts,payload other_keys=0');
    expectNone(logs().join('\n'), '@');
  });
});

describe('Opus B-700-1 replay: coach brief log lines never hold the coach name', () => {
  function run(scenario: Parameters<typeof makeMockAnthropic>[0], coachId?: string) {
    const svc = new CoachBriefService(
      asPrismaService(makeMockPrisma()),
      asConfig(makeMockConfig()),
      grantAllEgress(),
      asAnthropic(makeMockAnthropic(scenario)),
    );
    const ctx = makeBriefContext({
      coach_name: `Patricia ${SURNAME}`,
      coach_first_name: 'Patricia',
      workouts_pending_approval: 1,
    });
    const ai: BriefAiInput = { ctx, subject: clientDataSubject(['client-1'], 'coach') };
    return svc.callClaude(ctx, ai, coachId);
  }

  it('Claude call error (the probe called without a coach id)', async () => {
    const lines = spyLogs();
    const res = await run(new Error(`upstream 529 overloaded for Patricia ${SURNAME}`));
    expect(res.generated_by).toBe('fallback');
    const all = lines().join('\n');
    expect(all).toContain('CoachBrief Claude call failed for coach=unset mode=solo_coach');
    expect(all).toContain(': error=Error');
    expectNone(all, SURNAME);
  });

  it('contract failure twice: the coach id, mode and date, never the name', async () => {
    const lines = spyLogs();
    const tooFew = 'Patricia, there are updates this morning. Watch for more.';
    const res = await run([tooFew, tooFew], 'coach-1');
    expect(res.generated_by).toBe('fallback');
    const all = lines().join('\n');
    expect(all).toContain('failed contract');
    expect(all).toContain('coach=coach-1 mode=solo_coach');
    expectNone(all, SURNAME);
  });
});

describe('Opus B-700-2 replay: addresses that arrive through upstream text or a path', () => {
  it('forgotPassword: a Supabase error that echoes the address logs status and code only', async () => {
    const logs = spyLogs();
    const anyMock = fake<never>({});
    const service = new AuthService(anyMock, anyMock, anyMock, anyMock, anyMock, anyMock);
    // The reply is the same whether or not the reset call failed.
    await expect(service.forgotPassword(RESET_ADDRESS)).resolves.toEqual({
      message: 'If an account exists with that email, a reset link has been sent.',
    });
    const all = logs().join('\n');
    expect(all).toContain('resetPasswordForEmail failed: error=Object status=400 code=email_address_invalid');
    expectNone(all, '@', 'pat.client');
  });

  it('finance federation degraded: a fixed route label, never the path with the address', async () => {
    process.env.FINANCE_API_BASE_URL = 'https://finance.example.test';
    process.env.FINANCE_SERVICE_TOKEN = 'svc-token';
    class Http400Client extends FinanceAdminClient {
      protected fetchImpl: typeof fetch = async () =>
        fake<Response>({ ok: false, status: 400, json: async () => ({}), text: async () => '' });
    }
    const logs = spyLogs();
    const outcome = await new Http400Client().setCoachPracticeByEmail(RESET_ADDRESS, 'both');
    expect(outcome.kind).toBe('degraded');
    const all = logs().join('\n');
    expect(all).toContain('Finance federation degraded route=coaches/by-email/practice reason=http_error');
    expectNone(all, 'pat.client', '%40', '@');
  });

  it('finance user search: the search text never reaches the line', async () => {
    process.env.FINANCE_API_BASE_URL = 'https://finance.example.test';
    process.env.FINANCE_SERVICE_TOKEN = 'svc-token';
    class Http500Client extends FinanceAdminClient {
      protected fetchImpl: typeof fetch = async () =>
        fake<Response>({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    }
    const logs = spyLogs();
    await new Http500Client().searchUsers(PERSON, 5);
    const all = logs().join('\n');
    expect(all).toContain('route=users/search');
    expectNone(all, 'Patricia', 'Quill');
  });
});
