/**
 * C-611-17 (agent 117, B-PRIV-FU-117; AGENT_RULES G12): no email address,
 * person's name or free text reaches a log line. Logs carry ids and codes.
 *
 * Two layers:
 *  1. Behaviour, with a spy on every Nest Logger level: the email service
 *     (log transport, a sent email, a provider error that echoes the
 *     address), the digest sender, the coach alert push fallback, the
 *     practice federation fallback and the scheduling webhook stubs log no
 *     '@' and no name, and still log the id that lets support find the row.
 *  2. A guard over every log call under src/: no interpolated email,
 *     recipient, person-name or free-text expression. The guard proves its
 *     own rules on synthetic calls first, so it cannot pass vacuously.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CoachPracticeType } from '@prisma/client';
import type { Request } from 'express';
import type { PrismaService } from '../../src/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { FinanceAdminClient } from '../../src/admin/federation/finance-admin.client';
import { EmailService } from '../../src/email/email.service';
import { EmailTemplateKey } from '../../src/email/email.types';
import { DigestService } from '../../src/notifications/digest.service';
import { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import { PracticeTypeService } from '../../src/coach/practice-type/practice-type.service';
import { SchedulingWebhookController } from '../../src/scheduling/scheduling-webhook.controller';

const ADDRESS = 'pat.client+tgp@example.com';
const FIRST = 'Patricia';
const PERSON = 'Patricia Quill';

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

function spyLogs(): { lines: () => string[] } {
  const spies = LEVELS.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
  return {
    lines: () =>
      spies.flatMap((spy) =>
        spy.mock.calls.map((args: unknown[]) =>
          args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '),
        ),
      ),
  };
}

function expectNoPersonalData(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).not.toContain('@');
    expect(line).not.toContain('pat.client');
    expect(line).not.toContain(FIRST);
  }
}

/** A test double that carries only the members the code under test touches. */
function fake<T>(value: unknown): T {
  return value as T;
}

function config(values: Record<string, string | undefined>): ConfigService {
  return fake<ConfigService>({ get: (key: string) => values[key] });
}

const realFetch = global.fetch;

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = realFetch;
});

describe('C-611-17: EmailService logs the send-log row id and template, never the address or subject', () => {
  function prisma() {
    return {
      emailSendLog: {
        create: jest.fn().mockResolvedValue({ id: 'row-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }
  const input = {
    to: ADDRESS,
    template: EmailTemplateKey.NUDGE_ONBOARDING_ABANDONED,
    data: { first_name: FIRST, app_url: 'https://app.example.test' },
    idempotencyKey: 'nudge:onboarding_abandoned:sig-1:user-1',
  };

  it('log transport: no address, no rendered subject (it holds the first name)', async () => {
    const logs = spyLogs();
    const svc = new EmailService(fake<PrismaService>(prisma()), config({}));
    const res = await svc.send(input);
    expect(res.status).toBe('logged');
    expectNoPersonalData(logs.lines());
    expect(logs.lines().join('\n')).toContain('row=row-1');
    expect(logs.lines().join('\n')).toContain('template=nudge-onboarding-abandoned');
  });

  it('sent through the provider: logs the provider id and row id, not the address', async () => {
    const logs = spyLogs();
    global.fetch = fake<typeof fetch>(
      jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 're_msg_1' }) }),
    );
    const db = prisma();
    const svc = new EmailService(
      fake<PrismaService>(db),
      config({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM_ADDRESS: 'team@example.org' }),
    );
    const res = await svc.send(input);
    expect(res.status).toBe('sent');
    expectNoPersonalData(logs.lines());
    expect(logs.lines().join('\n')).toContain('provider_id=re_msg_1');
    expect(logs.lines().join('\n')).toContain('row=row-1');
  });

  it('provider error that echoes the address: the log, the result and the stored error hold no address', async () => {
    const logs = spyLogs();
    global.fetch = fake<typeof fetch>(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => `{"message":"Invalid \`to\` field: ${ADDRESS} is not a valid address"}`,
      }),
    );
    const db = prisma();
    const svc = new EmailService(
      fake<PrismaService>(db),
      config({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM_ADDRESS: 'team@example.org' }),
    );
    const res = await svc.send(input);
    expect(res.status).toBe('failed');
    expectNoPersonalData(logs.lines());
    // B-700-1: the provider, the HTTP status and the provider's code only.
    expect(logs.lines().join('\n')).toContain('provider=resend status=422 code=other');
    expect(res.error).toBe('provider=resend status=422 code=other');
    const updates = db.emailSendLog.update.mock.calls;
    const stored = String(updates[updates.length - 1][0].data.error);
    expect(stored).toBe('provider=resend status=422 code=other');
  });
});

describe('C-611-17: DigestService logs the user id, never the address', () => {
  function build(values: Record<string, string | undefined>) {
    const notifications = {
      claimDigestWindow: jest.fn().mockResolvedValue('digest-log-1'),
      createNotification: jest.fn().mockResolvedValue({}),
      markDigestSent: jest.fn().mockResolvedValue(undefined),
      markDigestFailed: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new DigestService(
      fake<PrismaService>({}),
      fake<NotificationsService>(notifications),
      config(values),
    );
    // The two database reads are private; replace them on the instance.
    const internals = fake<{
      _activeClientsWithEmailDigest: () => Promise<unknown>;
      _buildClientDigestData: () => Promise<unknown>;
    }>(svc);
    jest
      .spyOn(internals, '_activeClientsWithEmailDigest')
      .mockResolvedValue([{ id: 'user-1', email: ADDRESS, name: PERSON }]);
    jest.spyOn(internals, '_buildClientDigestData').mockResolvedValue({
      date: '3 October 2026',
      checkins: [],
      weightMetrics: [],
      streakMetrics: [],
    });
    return { svc, notifications };
  }

  it('log transport: the line names the user id and template only', async () => {
    const logs = spyLogs();
    const { svc, notifications } = build({ EMAIL_TRANSPORT: 'log' });
    await svc.sendClientDailyDigests();
    expect(notifications.markDigestSent).toHaveBeenCalledWith('digest-log-1');
    expectNoPersonalData(logs.lines());
    expect(logs.lines().join('\n')).toContain('user=user-1');
    expect(logs.lines().join('\n')).toContain('template=digest-client');
  });

  it('provider error that echoes the address: neither the log nor the stored failure holds it', async () => {
    const logs = spyLogs();
    global.fetch = fake<typeof fetch>(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => `Error parsing 'To': Illegal email address '${ADDRESS}'.`,
      }),
    );
    const { svc, notifications } = build({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' });
    await svc.sendClientDailyDigests();
    expect(notifications.markDigestFailed).toHaveBeenCalledTimes(1);
    const stored = notifications.markDigestFailed.mock.calls[0][1] as string;
    expect(stored).toBe('provider=resend status=422 code=unparsed');
    expectNoPersonalData(logs.lines());
    expect(logs.lines().join('\n')).toContain('user=user-1');
  });
});

describe('C-611-17: other log lines that carried a name, an address or a payload', () => {
  it('coach alert push fallback: no alert message (it holds the client name)', async () => {
    const logs = spyLogs();
    const alert = {
      id: 'alert-1',
      coach_id: 'coach-1',
      client_id: 'client-1',
      alert_type: 'consecutive_misses',
      severity: 'warning',
      message: `${PERSON} has not logged a workout in 5+ days`,
      payload: null,
      acknowledged_at: null,
      created_at: new Date(),
    };
    const prisma = fake<PrismaService>({
      coachAlert: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(alert),
      },
    });
    const notifications = fake<NotificationsService>({
      pushToCoach: jest.fn().mockResolvedValue(false),
    });
    const svc = new CoachAlertsService(prisma, notifications);
    await svc.createAlert({
      coachId: 'coach-1',
      clientId: 'client-1',
      alertType: 'consecutive_misses',
      message: alert.message,
    });
    expectNoPersonalData(logs.lines());
    expect(logs.lines().join('\n')).toContain('alert=alert-1');
  });

  it('practice federation fallback: the coach id, not the coach email', async () => {
    const logs = spyLogs();
    const prisma = fake<PrismaService>({
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: 'coach', email: ADDRESS }),
        update: jest.fn().mockResolvedValue({ coach_practice_type: CoachPracticeType.fitness_only }),
      },
    });
    const finance = fake<FinanceAdminClient>({
      isConfigured: () => true,
      hasAuth: () => true,
      setCoachPracticeByEmail: jest.fn().mockResolvedValue({ kind: 'not_found' }),
    });
    const svc = new PracticeTypeService(prisma, finance);
    const res = await svc.set('coach-1', CoachPracticeType.fitness_only);
    expect(res.finance_status).toBe('not_found');
    expectNoPersonalData(logs.lines());
    expect(logs.lines().join('\n')).toContain('coach-1');
  });

  it('scheduling webhook stubs: the payload shape, never its values', async () => {
    const saved = process.env.SCHEDULING_WEBHOOK_SECRET;
    delete process.env.SCHEDULING_WEBHOOK_SECRET;
    try {
      const logs = spyLogs();
      const ctrl = new SchedulingWebhookController();
      const zoomBody = {
        event: 'meeting.participant_joined',
        payload: { object: { participant: { user_name: PERSON, email: ADDRESS } } },
      };
      const req = fake<Request>({ headers: {} });
      await ctrl.zoom(zoomBody, req);
      await ctrl.googleCalendar({ attendee: { displayName: PERSON, email: ADDRESS } }, req);
      expectNoPersonalData(logs.lines());
      expect(logs.lines().join('\n')).toContain(
        'event=meeting.participant_joined keys=event,payload other_keys=0',
      );
      expect(logs.lines().join('\n')).toContain('event=none keys=none other_keys=1');
    } finally {
      if (saved === undefined) delete process.env.SCHEDULING_WEBHOOK_SECRET;
      else process.env.SCHEDULING_WEBHOOK_SECRET = saved;
    }
  });
});

// ── 2. Guard over every log call under src/ ──────────────────────────────

/**
 * Finds every logger/console call and returns the code inside its argument
 * list with the static text of string and template literals removed (so
 * "Invalid email" in a message is fine) and template expressions kept.
 */
const LOG_CALL =
  /(?:\b[\w$]*[lL]ogger\b|\b[A-Z_]*LOGGER\b|\bconsole\b|\bnew\s+Logger\([^()]*\))\s*\.\s*(?:log|warn|error|debug|verbose|info|fatal)\s*\(/g;

interface LogCall {
  line: number;
  code: string;
}

function logCalls(src: string): LogCall[] {
  const calls: LogCall[] = [];
  LOG_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOG_CALL.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({ line, code: argumentCode(src, m.index + m[0].length) });
  }
  return calls;
}

function argumentCode(src: string, start: number): string {
  let out = '';
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      out += ' STR ';
      continue;
    }
    if (c === '`') {
      const res = readTemplate(src, i);
      out += ` ${res.exprs.join(' ')} `;
      i = res.end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    out += c;
    i++;
  }
  return out;
}

function skipQuoted(src: string, i: number, q: string): number {
  i++;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i++;
    i++;
  }
  return i + 1;
}

function readTemplate(src: string, i: number): { exprs: string[]; end: number } {
  const exprs: string[] = [];
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '{') {
      let d = 1;
      let j = i + 2;
      let expr = '';
      while (j < src.length && d > 0) {
        const c = src[j];
        if (c === "'" || c === '"') {
          j = skipQuoted(src, j, c);
          expr += ' STR ';
          continue;
        }
        if (c === '`') {
          const inner = readTemplate(src, j);
          expr += ` ${inner.exprs.join(' ')} `;
          j = inner.end;
          continue;
        }
        if (c === '{') d++;
        if (c === '}') {
          d--;
          if (d === 0) break;
        }
        expr += c;
        j++;
      }
      exprs.push(expr);
      i = j + 1;
      continue;
    }
    i++;
  }
  return { exprs, end: i + 1 };
}

/**
 * What a rule sees: the code of one log call, plus whether the file it is
 * in builds a URL from an address (`encodeURIComponent(email)`), where any
 * logged path or URL carries that address (B-700-2).
 */
interface CallContext {
  encodesAddress: boolean;
}

const ENCODES_ADDRESS = /encodeURIComponent\(\s*[\w$.]*e[-_]?mail/i;

// B-700-1: any identifier that holds a person-name token, also inside a
// longer camelCase or snake_case name (`safeCoachName`, `client_display_name`).
const PERSON_NAME_TOKEN =
  /(?:first|last|full|display|guest|user|recipient|coach|client|sender|member|owner|author|person|buyer|contact|given|family|sur|nick)_?names?$/i;

function identifiers(code: string): string[] {
  return code.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** Each rule names what it forbids; `hit` gets the code of one log call. */
const RULES: ReadonlyArray<{
  id: string;
  what: string;
  hit: (code: string, ctx: CallContext) => boolean;
}> = [
  {
    id: 'email',
    what: 'an email address (an identifier named like email that is not an id, count, flag or template key)',
    hit: (code) =>
      identifiers(code).some(
        (tok) =>
          /e[-_]?mail/i.test(tok) &&
          !/(?:ids?|count|hash|hashed|kind|status|template|templatekey|key|enabled|verified|sent|service|transport|digest)$/i.test(tok) &&
          !/^(?:EmailService|EmailTemplateKey|EmailSendLog|emailSendLog)$/.test(tok),
      ),
  },
  {
    id: 'recipient',
    what: 'a recipient address (`to`, `input.to`, `args.to`)',
    hit: (code) => /(?:^|[^\w$])(?:[\w$]+\.)?to\b(?!\s*:)/.test(code.replace(/\bSTR\b/g, '')),
  },
  {
    id: 'name',
    what: "a person's name (an identifier holding a person-name token, or `<person>.name`)",
    hit: (code) =>
      identifiers(code).some((tok) => PERSON_NAME_TOKEN.test(tok)) ||
      /\b(?:user|client|coach|u|member|recipient|sender|owner|guest|profile|buyer|person|author|actor)\.name\b/.test(code),
  },
  {
    id: 'free-text',
    what: 'free text: a message body, note, alert or provider message, or a whole request payload',
    hit: (code) =>
      /\b(?:alert|ticket|receipt|post|comment|reply|thread|dm|chat|conversation|checkin|checkIn|entry|draft|lesson|application|listing|result|input|dto|body|payload|data)\.(?:message|body|content|text|note|notes|caption|bio|title|prompt|transcript)\b(?!\s*\??\.\s*length\b)/.test(
        code,
      ) ||
      /\btruncateNote\s*\(/.test(code) ||
      /\b(?:JSON\.stringify|safeStringify|inspect)\s*\(\s*(?:body|payload|dto|input|data|req\.body|request\.body)\b/.test(
        code,
      ),
  },
  {
    id: 'path',
    what: 'a raw request URL, or a path or URL in a file that puts an address into a URL',
    hit: (code, ctx) =>
      /\b(?:req|request)\s*\.\s*(?:originalUrl|url)\b/.test(code) ||
      (ctx.encodesAddress && /(?:^|[^\w$.])(?:path|url|uri|href|fullUrl)\b(?!\s*:)/.test(code)),
  },
  {
    id: 'exception-text',
    what: 'exception or provider text (`.message`, `.stack`, `String(err)`, a bare error argument, an error-message helper) instead of describeFailure(err)',
    hit: (code) => {
      const c = code.replace(/\bdescribeFailure\s*\([^()]*\)/g, ' SAFE ');
      return (
        /\.\s*(?:message|stack)\b/.test(c) ||
        /\bString\s*\(\s*(?:err|error|e|ex|exception|cause|reason)\b/.test(c) ||
        /(?:^|[^\w$.])(?:message|msg|errMsg|errorMessage|errMessage)\b(?!\s*:)/.test(c) ||
        /(?:^|[,(]\s*)(?:err|error|e|ex|exception|cause)\s*(?:,|$)/.test(c.trim()) ||
        /\b[\w$]*[mM]essage(?:Of|For|From)?\s*\(/.test(c)
      );
    },
  },
];

function violations(code: string, ctx: CallContext = { encodesAddress: false }): string[] {
  return RULES.filter((r) => r.hit(code, ctx)).map((r) => r.id);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__mocks__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts') && !/\.(?:spec|test)\.ts$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * C-700-2 legacy baseline: log calls that still print exception text, per
 * file, exact counts at agent 118 (B-PRIVFU2-118). Every other rule has no
 * baseline. A file not listed must have none; a listed count that grows or
 * shrinks fails, so the list is lowered as sites move to describeFailure.
 * Files this PR touches are fixed and are not listed.
 */
const LEGACY_EXCEPTION_TEXT: Readonly<Record<string, number>> = {
  'src/account-deletion/account-deletion.service.ts': 5,
  'src/account-deletion/apple-token-revocation.service.ts': 3,
  'src/admin/admin.service.ts': 1,
  'src/admin/ptm/admin-ptm.service.ts': 1,
  'src/admin/soc2/soc2-evidence.service.ts': 3,
  'src/ai-credits/coach-ai-budget.scheduler.ts': 1,
  'src/ai-credits/coach-ai-credit-pack.service.ts': 1,
  'src/ai/adapters/anthropic.adapter.ts': 2,
  'src/ai/ai.service.ts': 2,
  'src/ai/coach/coach-ai-state.service.ts': 1,
  'src/ai/coach/weekly-insight.cron.ts': 1,
  'src/ai/gateway/ai-approval.service.ts': 1,
  'src/ai/gateway/ai-gateway.service.ts': 2,
  'src/ai/gateway/materialisers/assign-meal-plan.materialiser.ts': 2,
  'src/ai/gateway/materialisers/assign-workout.materialiser.ts': 2,
  'src/ai/gateway/materialisers/coach-message.materialiser.ts': 2,
  'src/ai/gateway/materialisers/coach-wearable-message.materialiser.ts': 2,
  'src/ai/gateway/materialisers/create-workout-plan.materialiser.ts': 1,
  'src/ai/gateway/materialisers/edit-workout-plan.materialiser.ts': 1,
  'src/ai/gateway/materialisers/send-notification.materialiser.ts': 1,
  'src/analytics/analytics.service.ts': 1,
  'src/audit/audit.service.ts': 1,
  'src/auth/jwks.service.ts': 1,
  'src/auth/recent-auth.guard.ts': 1,
  'src/billing/billing.service.ts': 10,
  'src/bloodwork/bloodwork-stale.scheduler.ts': 1,
  'src/checkout/checkout-webhook-handler.service.ts': 12,
  'src/checkout/checkout.service.ts': 2,
  'src/checkout/dunning-v2/dunning-lockout.guard.ts': 1,
  'src/checkout/dunning-v2/dunning-lockout.scheduler.ts': 1,
  'src/checkout/dunning-v2/dunning-v2.dispatcher.ts': 1,
  'src/checkout/dunning-v2/dunning-v2.service.ts': 1,
  'src/checkout/dunning.service.ts': 6,
  'src/checkout/refund-dispute-handler.service.ts': 4,
  'src/coach-connect/coach-connect.service.ts': 2,
  'src/coach-media/coach-media.service.ts': 1,
  'src/coach-media/supabase-storage.provider.ts': 2,
  'src/coach/brief/coach-brief.scheduler.ts': 6,
  'src/coach/coach-effectiveness.scheduler.ts': 2,
  'src/coach/command-center/churn-intervention.service.ts': 3,
  'src/common/cors-origins.ts': 1,
  'src/common/env-validation.ts': 6,
  'src/common/feature-flag/pilot-coach-allowlist.guard.ts': 2,
  'src/common/interceptors/rls-context.interceptor.ts': 1,
  'src/common/middleware/rls-context.middleware.ts': 2,
  'src/community/ai-triage/ai-triage.service.ts': 2,
  'src/community/classroom/community-classroom.service.ts': 1,
  'src/community/events/community-events.scheduler.ts': 1,
  'src/community/moderation/community-moderation.service.ts': 1,
  'src/community/notifications/community-notifications.service.ts': 1,
  'src/community/realtime/community-realtime.service.ts': 2,
  'src/community/voice/community-voice.service.ts': 1,
  'src/community/voice/voice-upload.provider.ts': 7,
  'src/connect/connect.module.ts': 2,
  'src/connect/connect.service.ts': 1,
  'src/connect/fees/payout-readiness.service.ts': 4,
  'src/connect/fees/reconciliation.service.ts': 3,
  'src/consent/consent.service.ts': 1,
  'src/contracts/contract-envelope.service.ts': 2,
  'src/contracts/webhooks/hellosign-webhook.controller.ts': 3,
  'src/data-export/data-export-archive.store.ts': 1,
  'src/data-export/data-export-cleanup.cron.ts': 1,
  'src/data-export/data-export.controller.ts': 1,
  'src/data-export/data-export.service.ts': 11,
  'src/diagnostic/ai-roadmap.service.ts': 1,
  'src/diagnostic/diagnostic.service.ts': 1,
  'src/exercise-catalog/exercise-video-provider.service.ts': 11,
  'src/exercise-library/exercise-library.service.ts': 1,
  'src/filters/http-exception.filter.ts': 1,
  'src/first-win/first-win.service.ts': 1,
  'src/food/food.service.ts': 1,
  'src/invite-codes/invite-codes.service.ts': 5,
  'src/invite-grant/invite-grant.service.ts': 1,
  'src/landing-pages/crm/lead-sync.processor.ts': 3,
  'src/landing-pages/landing-pages.public.service.ts': 2,
  'src/landing-pages/lead-rate-limiter.service.ts': 2,
  'src/leaderboard/leaderboard.scheduler.ts': 1,
  'src/leaderboard/leaderboard.service.ts': 1,
  'src/messaging/messaging.service.ts': 1,
  'src/notifications/emitters/build-week-day-unlocked.emitter.ts': 1,
  'src/notifications/emitters/checkin-submitted.emitter.ts': 1,
  'src/notifications/emitters/coach-alert.emitter.ts': 1,
  'src/notifications/emitters/message-received.emitter.ts': 1,
  'src/notifications/emitters/milestone-reached.emitter.ts': 1,
  'src/notifications/emitters/missed-checkin.emitter.ts': 1,
  'src/notifications/emitters/weight-trend-alert.emitter.ts': 1,
  'src/notifications/nudges/nudge-engine.service.ts': 7,
  'src/notifications/nudges/nudge.scheduler.ts': 2,
  'src/packages/asset-resolvers/auto-message.resolver.ts': 1,
  'src/packages/drip-dispatcher.cron.ts': 5,
  'src/packages/drip-trigger.service.ts': 2,
  'src/packages/milestone.service.ts': 1,
  'src/packages/package-contents.service.ts': 1,
  'src/packages/package-push.service.ts': 4,
  'src/packages/purchase-fanout.service.ts': 4,
  'src/ptm/ptm-recompute.service.ts': 2,
  'src/ptm/ptm.scheduler.ts': 1,
  'src/ptm/ptm.service.ts': 1,
  'src/roman/roman.service.ts': 1,
  'src/scheduling/google-calendar/google-calendar.service.ts': 2,
  'src/storefront/checkout-cookie.service.ts': 1,
  'src/storefront/checkout-idempotency.service.ts': 3,
  'src/storefront/checkout-rate-limiter.service.ts': 2,
  'src/storefront/checkout-receipt.scheduler.ts': 2,
  'src/storefront/checkout-receipt.service.ts': 4,
  'src/storefront/connect-preflight.service.ts': 4,
  'src/storefront/guest-checkout-pii-scrub.service.ts': 2,
  'src/storefront/guest-checkout-reconciliation.service.ts': 3,
  'src/storefront/guest-checkout.service.ts': 2,
  'src/storefront/lost-webhook-reconcile.service.ts': 5,
  'src/sub-coach/sub-coach-idempotency.service.ts': 2,
  'src/supabase/supabase.service.ts': 2,
  'src/talent-marketplace/admin-moderation.service.ts': 1,
  'src/talent-marketplace/anti-bot/in-house-anti-bot.provider.ts': 2,
  'src/team/team.service.ts': 1,
  'src/throttler/login-throttle-reset.service.ts': 3,
  'src/throttler/throttler.config.ts': 2,
  'src/wearables/connections/connections.service.ts': 1,
  'src/wearables/connectors/fitbit/fitbit-webhook.controller.ts': 1,
  'src/wearables/connectors/fitbit/fitbit.connector.ts': 2,
  'src/wearables/connectors/oura/oura-webhook.controller.ts': 1,
  'src/wearables/connectors/oura/oura.connector.ts': 1,
  'src/wearables/connectors/polar/polar-webhook.controller.ts': 1,
  'src/wearables/connectors/polar/polar.connector.ts': 2,
  'src/wearables/connectors/wahoo/wahoo-webhook.controller.ts': 1,
  'src/wearables/connectors/wahoo/wahoo.connector.ts': 2,
  'src/wearables/connectors/withings/withings-webhook.controller.ts': 1,
  'src/wearables/connectors/withings/withings.connector.ts': 2,
  'src/wearables/http/provider-http-client.ts': 1,
  'src/wearables/ingestion/ingestion.service.ts': 2,
  'src/wearables/insights/wearable-insights.service.ts': 3,
  'src/wearables/maintenance/wearable-processed-event-prune.scheduler.ts': 1,
  'src/wearables/samples/wearable-samples.service.ts': 2,
  'src/workout-builder/program-library.service.ts': 2,
  'src/workout-builder/workout-builder-revision-prune.cron.ts': 2,
  'src/workout-builder/workout-builder.service.ts': 2,
};

describe('C-611-17 / B-700-1 / B-700-2 guard: no log call under src/ interpolates personal data', () => {
  it('the rules catch each kind of leak and pass ids, codes and static text', () => {
    const bad: Array<[string, string, CallContext?]> = [
      ['this.logger.log(`sent to=${input.to} id=${id}`)', 'recipient'],
      ['this.logger.warn(`no coach for ${u.email}`)', 'email'],
      ['this.logger.warn(`rebind refused (email=${supaEmail})`)', 'email'],
      ['logger.error(`recovery failed for ${email.slice(0, 3)}***`)', 'email'],
      ["this.logger.log(`[email log] to=${to} subject=\"x\"`)", 'recipient'],
      ['this.logger.log(`hello ${client.name}`)', 'name'],
      ['this.logger.log({ first_name: firstName })', 'name'],
      // B-700-1 (Opus probe shape): a camelCase identifier holding a name.
      ['this.logger.warn(`Claude call failed for coach=${safeCoachName}`)', 'name'],
      ['this.logger.log(`welcome ${clientDisplayName}`)', 'name'],
      ['this.logger.log(`push skipped: ${alert.message}`)', 'free-text'],
      ['this.logger.error(`ticket error: ${ticket.message}`)', 'free-text'],
      ["this.logger.error('Push receipt error:', receipt.message)", 'free-text'],
      ['this.logger.log({ note: truncateNote(result.note) })', 'free-text'],
      ['this.logger.debug(`payload: ${safeStringify(body)}`)', 'free-text'],
      ['this.logger.debug(JSON.stringify(dto))', 'free-text'],
      // B-700-2 (Opus probe shapes): a path built from an address, and
      // Supabase error text that echoes the address.
      ['this.logger.warn(`Finance federation degraded path=${path} reason=${r}`)', 'path', { encodesAddress: true }],
      ['this.logger.warn(`lookup failed url=${url}`)', 'path', { encodesAddress: true }],
      ['this.logger.warn(`unmatched ${req.originalUrl}`)', 'path'],
      ['this.logger.warn(`resetPasswordForEmail failed: ${error.message}`)', 'exception-text'],
      ['this.logger.error(`pair redeem: generateLink failed: ${linkError?.message ?? STR}`)', 'exception-text'],
      // B-700-1 (Sol probe shape): provider and exception text in any form.
      ['this.logger.error(`send failed user=${user.id}: ${(err as Error).message}`)', 'exception-text'],
      ['this.logger.error(`render failed: ${msg}`)', 'exception-text'],
      ["this.logger.error('boot failed', (err as Error).stack)", 'exception-text'],
      ["this.logger.error('claim failed', err)", 'exception-text'],
      ['this.logger.warn(`failed: ${String(err)}`)', 'exception-text'],
      ['this.logger.warn(`failed: ${errorMessageOf(err)}`)', 'exception-text'],
      ["this.logger.warn({ msg: 'x', error_message: message })", 'exception-text'],
    ];
    for (const [snippet, rule, ctx] of bad) {
      const calls = logCalls(snippet);
      expect(calls).toHaveLength(1);
      expect(violations(calls[0].code, ctx)).toContain(rule);
    }
    const good: Array<[string, CallContext?]> = [
      ['this.logger.log(`email sent template=${input.template} row=${logRow.id} provider_id=${providerMessageId}`)'],
      ["this.logger.warn('Invalid email address: the recipient is missing an @ sign')"],
      ['this.logger.error(`send failed user=${user.id}: ${describeFailure(err)}`)'],
      ['this.logger.error(`brief failed: ${describeFailure(err, BRIEF_ERROR_CODES)}`)'],
      ['this.logger.log(`digest sent user=${client.id} emailCount=${emailCount}`)'],
      ["this.logger.log(`provider ${provider.name} threw (err=${err instanceof Error ? err.name : 'unknown'})`)"],
      ['this.logger.log({ event: STR_EVENT, note_length: result.note?.length ?? 0 })'],
      ['this.logger.warn(`Finance federation degraded route=${route} reason=${r}`)', { encodesAddress: true }],
      ["this.logger.warn({ message: 'throttler.rejected', userId, path, method })"],
      ['this.logger.warn(`secret ${secretName} rotated; exercise ${exerciseName}`)'],
      // Split so no single literal holds template syntax naming an import in
      // scope (CodeQL js/template-syntax-in-string-literal).
      ['this.logger.log(`EMAIL_TRANSPORT=${kind}; templates=$' + '{EmailTemplateKey.WEEKLY_DIGEST}`)'],
    ];
    for (const [snippet, ctx] of good) {
      const calls = logCalls(snippet);
      expect(calls).toHaveLength(1);
      expect(violations(calls[0].code, ctx)).toEqual([]);
    }
  });

  it('every log call under src/ passes the rules (exception text: only the listed legacy counts)', () => {
    const root = join(__dirname, '..', '..', 'src');
    const found: string[] = [];
    const exceptionText: Record<string, number> = {};
    let scanned = 0;
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(join(root, '..'), file).split('\\').join('/');
      const ctx: CallContext = { encodesAddress: ENCODES_ADDRESS.test(src) };
      for (const call of logCalls(src)) {
        scanned++;
        const v = violations(call.code, ctx);
        if (v.includes('exception-text')) exceptionText[rel] = (exceptionText[rel] ?? 0) + 1;
        const strict = v.filter((id) => id !== 'exception-text');
        if (strict.length > 0) {
          found.push(`${rel}:${call.line} [${strict.join(', ')}] ${call.code.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
        }
      }
    }
    // Hundreds of calls exist; a broken matcher that finds none must fail.
    expect(scanned).toBeGreaterThan(500);
    expect(found).toEqual([]);
    expect(exceptionText).toEqual(LEGACY_EXCEPTION_TEXT);
  });

  it('the files B-PRIVFU2-118 fixed print no exception text at all', () => {
    for (const rel of [
      'src/auth/auth.service.ts',
      'src/email/email.service.ts',
      'src/notifications/digest.service.ts',
      'src/notifications/notifications.service.ts',
      'src/storefront/checkout-recovery.service.ts',
      'src/coach/brief/coach-brief.service.ts',
      'src/admin/federation/finance-admin.client.ts',
      'src/scheduling/scheduling-webhook.controller.ts',
      'src/users/gdpr-scrub.service.ts',
      'src/users/gdpr-scrub.scheduler.ts',
      'src/users/account.service.ts',
    ]) {
      expect(LEGACY_EXCEPTION_TEXT[rel]).toBeUndefined();
    }
  });
});
