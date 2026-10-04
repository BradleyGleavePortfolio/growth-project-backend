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
    expect(logs.lines().join('\n')).toContain('Resend 422');
    expect(res.error).toContain('Resend 422');
    expect(res.error).not.toContain('@');
    const updates = db.emailSendLog.update.mock.calls;
    const stored = String(updates[updates.length - 1][0].data.error);
    expect(stored).toContain('Resend 422');
    expect(stored).not.toContain('@');
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
    expect(stored).toContain('Resend API error 422');
    expect(stored).not.toContain('@');
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
      expect(logs.lines().join('\n')).toContain('event=meeting.participant_joined');
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

/** Each rule names what it forbids; `hit` gets the code of one log call. */
const RULES: ReadonlyArray<{ id: string; what: string; hit: (code: string) => boolean }> = [
  {
    id: 'email',
    what: 'an email address (an identifier named like email that is not an id, count, flag or template key)',
    hit: (code) =>
      (code.match(/[A-Za-z_$][\w$]*/g) ?? []).some(
        (tok) =>
          /e[-_]?mail/i.test(tok) &&
          !/(?:ids?|count|hash|hashed|kind|status|template|templatekey|key|enabled|verified|sent|service|transport|digest)$/i.test(tok) &&
          !/^(?:EmailService|EmailTemplateKey|EmailSendLog|emailSendLog)$/.test(tok) &&
          !/^redact/i.test(tok),
      ),
  },
  {
    id: 'recipient',
    what: 'a recipient address (`to`, `input.to`, `args.to`)',
    hit: (code) => /(?:^|[^\w$])(?:[\w$]+\.)?to\b(?!\s*:)/.test(code.replace(/\bSTR\b/g, '')),
  },
  {
    id: 'name',
    what: "a person's name",
    hit: (code) =>
      /\b(?:first_?name|last_?name|full_?name|display_?name|guest_?name|user_?name|recipient_?name|coach_?name|client_?name|sender_?name)\b/i.test(
        code,
      ) ||
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
];

function violations(code: string): string[] {
  return RULES.filter((r) => r.hit(code)).map((r) => r.id);
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

describe('C-611-17 guard: no log call under src/ interpolates an address, a name or free text', () => {
  it('the rules catch each kind of leak and pass ids, codes and static text', () => {
    const bad: Array<[string, string]> = [
      ['this.logger.log(`sent to=${input.to} id=${id}`)', 'recipient'],
      ['this.logger.warn(`no coach for ${u.email}`)', 'email'],
      ['this.logger.warn(`rebind refused (email=${supaEmail})`)', 'email'],
      ['logger.error(`recovery failed for ${email.slice(0, 3)}***`)', 'email'],
      ["this.logger.log(`[email log] to=${to} subject=\"x\"`)", 'recipient'],
      ['this.logger.log(`hello ${client.name}`)', 'name'],
      ['this.logger.log({ first_name: firstName })', 'name'],
      ['this.logger.log(`push skipped: ${alert.message}`)', 'free-text'],
      ['this.logger.error(`ticket error: ${ticket.message}`)', 'free-text'],
      ["this.logger.error('Push receipt error:', receipt.message)", 'free-text'],
      ['this.logger.log({ note: truncateNote(result.note) })', 'free-text'],
      ['this.logger.debug(`payload: ${safeStringify(body)}`)', 'free-text'],
      ['this.logger.debug(JSON.stringify(dto))', 'free-text'],
    ];
    for (const [snippet, rule] of bad) {
      const calls = logCalls(snippet);
      expect(calls).toHaveLength(1);
      expect(violations(calls[0].code)).toContain(rule);
    }
    const good = [
      'this.logger.log(`email sent template=${input.template} row=${logRow.id} provider_id=${providerMessageId}`)',
      "this.logger.warn('Invalid email address: the recipient is missing an @ sign')",
      'this.logger.error(`send failed user=${user.id}: ${(err as Error).message}`)',
      'this.logger.log(`digest sent user=${client.id} emailCount=${emailCount}`)',
      "this.logger.log(`provider ${provider.name} threw (err=${err instanceof Error ? err.name : 'unknown'})`)",
      'this.logger.log({ event: STR_EVENT, note_length: result.note?.length ?? 0 })',
      // Split so no single literal holds template syntax naming an import in
      // scope (CodeQL js/template-syntax-in-string-literal).
      'this.logger.log(`EMAIL_TRANSPORT=${kind}; templates=$' + '{EmailTemplateKey.WEEKLY_DIGEST}`)',
      'this.logger.error(`recovery failed checkout=${checkout.id}: ${redactEmailAddresses(err.message)}`)',
    ];
    for (const snippet of good) {
      const calls = logCalls(snippet);
      expect(calls).toHaveLength(1);
      expect(violations(calls[0].code)).toEqual([]);
    }
  });

  it('every log call under src/ passes the rules', () => {
    const root = join(__dirname, '..', '..', 'src');
    const found: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      for (const call of logCalls(src)) {
        scanned++;
        const v = violations(call.code);
        if (v.length > 0) {
          found.push(`${relative(join(root, '..'), file)}:${call.line} [${v.join(', ')}] ${call.code.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
        }
      }
    }
    // Hundreds of calls exist; a broken matcher that finds none must fail.
    expect(scanned).toBeGreaterThan(500);
    expect(found).toEqual([]);
  });
});
