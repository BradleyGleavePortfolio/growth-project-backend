import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  EmailTemplateKey,
  SendEmailInput,
  SendEmailResult,
} from './email.types';

// Provider abstraction is intentionally minimal: send(from, to, subject,
// html) -> providerMessageId. Each transport implementation lives below.
interface EmailTransport {
  send(args: {
    from: string;
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<{ providerMessageId: string }>;
}

// Per-template subject lines. Subject strings live next to the template
// key so callers do not need to repeat them across the codebase, and so
// localisation can later attach to one map. Subjects may contain a single
// {{var}} placeholder which is resolved against `data`.
const TEMPLATE_SUBJECTS: Record<EmailTemplateKey, string> = {
  'coach-invites-client': '{{coach_name}} invited you to The Growth Project',
  'payment-reminder': 'Your subscription payment is due soon',
  'payment-failed': 'We could not process your payment',
  'coach-onboarding-welcome':
    'Welcome to The Growth Project, Coach {{coach_name}}',
  'client-onboarding-welcome': 'Welcome to The Growth Project',
  'weekly-digest': 'Your weekly Growth Project summary',
  'payment-receipt': 'Receipt for your Growth Project subscription',
  // PR #281 P2-4: differentiated cadence subjects — Day 7 is a second
  // warning that names the cutoff but stays recoverable; only Day 14 calls
  // itself a final notice. Stillwater Standard: declarative, no exclamation,
  // no all-caps.
  'dunning-final': 'Your subscription is ending {{cancellation_date}}',
  // DUNNING-V1 — cadence subjects. Append-only.
  'payment-reminder-soft': "Heads up — we couldn't process your payment",
  'payment-reminder-urgent': 'Your Growth Project payment is still failing',
  'payment-final-notice':
    "A second heads-up — subscription ends {{cancellation_date}} if payment doesn't go through",
  'payment-recovered': "You're all set — payment received",
};

// EmailService is the single entry point for sending transactional email.
// It owns:
//   * transport selection (resend | log)
//   * Handlebars template loading + rendering
//   * idempotency via EmailSendLog (one row per idempotency_key)
//   * structured logging for support / forensics
//
// Doctrine: NO FAKE SUCCESS. If EMAIL_TRANSPORT=resend and RESEND_API_KEY
// is unset, send() throws a clear configuration error rather than silently
// returning success. The historical 'log' transport remains for dev/test
// only and is selected explicitly via EMAIL_TRANSPORT=log.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly templates = new Map<string, HandlebarsTemplateDelegate>();
  private readonly subjectTemplates = new Map<
    EmailTemplateKey,
    HandlebarsTemplateDelegate
  >();
  private transport: EmailTransport | null = null;
  private transportKind: 'resend' | 'log' = 'log';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this._loadTemplates();
    this._initTransport();
  }

  // Resolves a template + data into a `{html, subject}` pair. Exposed for
  // tests; production code uses send() which calls this internally.
  render(
    template: EmailTemplateKey,
    data: Record<string, unknown>,
  ): { html: string; subject: string } {
    const tpl = this.templates.get(template);
    if (!tpl) {
      throw new InternalServerErrorException(
        `Email template not found: ${template}`,
      );
    }
    const subjectTpl = this.subjectTemplates.get(template);
    const html = tpl(data);
    const subject = subjectTpl ? subjectTpl(data) : TEMPLATE_SUBJECTS[template];
    return { html, subject };
  }

  // Send a transactional email. Idempotent via input.idempotencyKey — a
  // second call with the same key (regardless of recipient/template) is
  // a no-op that returns status:'skipped'.
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    // Hardened recipient check (A1-C5-P1-1):
    //   - Must be a non-empty string containing exactly one '@' (no multiple-address trick)
    //   - Must not contain CR or LF characters (CRLF-injection guard)
    //   - Must not contain commas (single-address enforcement)
    if (
      !input.to ||
      !input.to.includes('@') ||
      /[\r\n]/.test(input.to) ||
      input.to.split(',').length > 1
    ) {
      throw new BadRequestException('Invalid recipient email address');
    }
    if (!input.idempotencyKey) {
      throw new InternalServerErrorException(
        'EmailService.send requires a non-empty idempotencyKey',
      );
    }

    // Idempotency: try to INSERT a 'sending' row. On unique violation
    // (P2002) the same key was already used — return 'skipped'. The row
    // is updated to 'sent' / 'failed' / 'logged' once the transport
    // returns. We never delete rows so support can trace history.
    let logRow: { id: string } | null = null;
    try {
      logRow = await this.prisma.emailSendLog.create({
        data: {
          idempotency_key: input.idempotencyKey,
          template_key: input.template,
          recipient_email: input.to.toLowerCase(),
          status: 'sending',
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `email send skipped: idempotency hit key=${input.idempotencyKey}`,
        );
        return {
          status: 'skipped',
          providerMessageId: null,
          idempotencyKey: input.idempotencyKey,
        };
      }
      throw err;
    }

    const from =
      input.from ??
      (this.config.get<string>('EMAIL_FROM_ADDRESS') ||
        'noreply@thegrowthproject.app');

    let html: string;
    let subject: string;
    try {
      const rendered = this.render(input.template, input.data);
      html = rendered.html;
      subject = rendered.subject;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      await this._finalize(logRow.id, 'failed', null, `render: ${msg}`);
      return {
        status: 'failed',
        providerMessageId: null,
        idempotencyKey: input.idempotencyKey,
        error: `render: ${msg}`,
      };
    }

    // 'log' transport: structured log instead of an HTTP call. Used in
    // dev/test only — `_initTransport` enforces that production never
    // accidentally lands here.
    if (this.transportKind === 'log' || !this.transport) {
      this.logger.log(
        `[email:log] to=${input.to} template=${input.template} subject="${subject}" key=${input.idempotencyKey}`,
      );
      await this._finalize(logRow.id, 'logged', null, null);
      return {
        status: 'logged',
        providerMessageId: null,
        idempotencyKey: input.idempotencyKey,
      };
    }

    try {
      const { providerMessageId } = await this.transport.send({
        from,
        to: input.to,
        subject,
        html,
        replyTo: input.replyTo,
      });
      await this._finalize(logRow.id, 'sent', providerMessageId, null);
      this.logger.log(
        `email sent template=${input.template} to=${input.to} provider_id=${providerMessageId}`,
      );
      return {
        status: 'sent',
        providerMessageId,
        idempotencyKey: input.idempotencyKey,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      await this._finalize(logRow.id, 'failed', null, msg.slice(0, 500));
      this.logger.error(
        `email send failed template=${input.template} to=${input.to}: ${msg}`,
      );
      return {
        status: 'failed',
        providerMessageId: null,
        idempotencyKey: input.idempotencyKey,
        error: msg,
      };
    }
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async _finalize(
    rowId: string,
    status: 'sent' | 'failed' | 'logged',
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void> {
    try {
      await this.prisma.emailSendLog.update({
        where: { id: rowId },
        data: {
          status,
          provider_message_id: providerMessageId,
          error,
          sent_at: status === 'sent' ? new Date() : null,
        },
      });
    } catch (err) {
      // Audit-style: never let log-finalize failure mask the real send
      // outcome. Best-effort write; error makes Sentry via global logger.
      this.logger.error(
        `email send log finalize failed row=${rowId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private _initTransport(): void {
    const kind = (
      this.config.get<string>('EMAIL_TRANSPORT') ?? 'log'
    ).toLowerCase();

    if (kind === 'log') {
      this.transportKind = 'log';
      return;
    }
    if (kind === 'resend') {
      const apiKey = this.config.get<string>('RESEND_API_KEY');
      const fromAddr = this.config.get<string>('EMAIL_FROM_ADDRESS');
      if (!apiKey) {
        throw new InternalServerErrorException(
          'EMAIL_TRANSPORT=resend requires RESEND_API_KEY to be set. See README §Resend setup.',
        );
      }
      if (!fromAddr) {
        throw new InternalServerErrorException(
          'EMAIL_TRANSPORT=resend requires EMAIL_FROM_ADDRESS to be set (must be a domain you have verified with Resend). See README §Resend setup.',
        );
      }
      this.transportKind = 'resend';
      this.transport = new ResendTransport(apiKey, this.logger);
      return;
    }
    throw new InternalServerErrorException(
      `Unsupported EMAIL_TRANSPORT=${kind}. Use 'resend' or 'log'.`,
    );
  }

  private _loadTemplates(): void {
    // Subject templates compile every entry in TEMPLATE_SUBJECTS so a
    // missing `{{var}}` value renders as empty string rather than
    // throwing at send time. Body templates load from src/email/templates.
    for (const key of Object.keys(TEMPLATE_SUBJECTS) as EmailTemplateKey[]) {
      this.subjectTemplates.set(key, Handlebars.compile(TEMPLATE_SUBJECTS[key]));
    }

    const dir = path.join(__dirname, 'templates');
    const keys = Object.values(EmailTemplateKey);
    for (const key of keys) {
      const file = path.join(dir, `${key}.hbs`);
      try {
        const src = fs.readFileSync(file, 'utf8');
        this.templates.set(key, Handlebars.compile(src));
      } catch (err) {
        // Missing template = configuration error; fail loud at boot so
        // ops sees this immediately rather than at first send.
        throw new Error(
          `Failed to load email template ${file}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
  }
}

// ── Resend HTTP transport ─────────────────────────────────────────────────
// Thin wrapper around the v1 /emails endpoint. We do not pull in the
// official `resend` SDK because it adds runtime weight and ESM-related
// jest gymnastics for one HTTP POST.
class ResendTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
  ) {}

  async send(args: {
    from: string;
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<{ providerMessageId: string }> {
    const body: Record<string, unknown> = {
      from: args.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
    };
    if (args.replyTo) body.reply_to = args.replyTo;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      throw new Error(`Resend ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (!json.id) {
      throw new Error('Resend response missing id field');
    }
    return { providerMessageId: json.id };
  }
}
