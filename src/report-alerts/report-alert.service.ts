import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { describeFailure } from '../observability/log-pii';
import { promRegistry } from '../observability/prom-metrics';
import { SUPPORT_EMAIL } from '../public-pages/trust-pages.html';
import { COMMUNITY_REPORT_REASONS } from '../community/safety/community-safety.service';

/**
 * B-REPORTALERT-125 (Apple 1.2): every new user report emails the support
 * inbox (SUPPORT_EMAIL, already the community safety contact) through the
 * existing EmailService, so a person sees it inside the promised 24 hours.
 * PII minimal: ids, kind, content type, reason label and time; never message
 * or post text, the reporter's details or notes, health data or names.
 * reportFiled() resolves in every case: a failure is logged and counted in
 * report_alert_email_total{outcome="failed"}, the report itself stands.
 */
export type ReportAlertKind = 'message' | 'community';

export interface ReportFiledInput {
  kind: ReportAlertKind;
  reportId: string;
  /** Stored reason code. */
  reason: string;
  createdAt: Date;
  /** 'message' for a DM, the moderation target type for community. */
  targetType: string;
  targetId: string;
  /** DM only. Read ONLY for the category label the app puts first; never emailed. */
  details?: string | null;
}

const DM_REASON_LABELS: Record<string, string> = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  sexual: 'Sexual content',
  self_harm: 'Self-harm or suicide',
  other: 'Something else',
};

/** Categories the app sends as a wider DM reason with the label first in details. */
const DM_FOLDED_CATEGORIES = ['Hate speech', 'Violence or threats', 'Misinformation'] as const;

const UNLISTED_REASON = 'Something else (unlisted reason code)';

const KIND_LABEL: Record<ReportAlertKind, string> = { message: 'Direct message report', community: 'Community report' };

const REVIEW_HINT: Record<ReportAlertKind, string> = {
  message: 'Look it up by the report id in the MessageReport table.',
  community: 'Open it in the coach app under Messages, then Reports, or by the report id in CommunityModerationAction.',
};

const PT_OPTIONS = { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' } as const;
const PT_TIME = new Intl.DateTimeFormat('en-US', PT_OPTIONS);

export function reportReasonLabel(input: Pick<ReportFiledInput, 'kind' | 'reason' | 'details'>): string {
  if (input.kind === 'community') {
    return COMMUNITY_REPORT_REASONS.find((r) => r.code === input.reason)?.label ?? UNLISTED_REASON;
  }
  const folded = DM_FOLDED_CATEGORIES.find((label) => input.details?.startsWith(`${label}.`));
  return folded ?? DM_REASON_LABELS[input.reason] ?? UNLISTED_REASON;
}

export function isSelfHarmReport(input: Pick<ReportFiledInput, 'reason'>): boolean {
  return input.reason === 'self_harm';
}

/** Subject: a self-harm report says so first; ids only, no names. */
export function reportAlertSubject(input: ReportFiledInput): string {
  const ref = `${input.kind === 'message' ? 'DM' : 'community'} report ${input.reportId.slice(0, 8)}`;
  if (isSelfHarmReport(input)) return `Self-harm or suicide report: review now (${ref})`;
  return `New ${ref}: ${reportReasonLabel(input)}`;
}

/** Template data for report-alert.hbs. Everything here is safe to email. */
export function reportAlertData(input: ReportFiledInput): Record<string, unknown> {
  return {
    subject: reportAlertSubject(input),
    self_harm: isSelfHarmReport(input),
    kind_label: KIND_LABEL[input.kind],
    report_id: input.reportId,
    reason_label: reportReasonLabel(input),
    target_type: input.targetType,
    target_id: input.targetId,
    time_pt: `${PT_TIME.format(input.createdAt)} PT`,
    time_utc: input.createdAt.toISOString(),
    review_hint: REVIEW_HINT[input.kind],
  };
}

const METRIC_NAME = 'report_alert_email_total';

function alertCounter(): Counter<string> {
  const existing = promRegistry.getSingleMetric(METRIC_NAME);
  if (existing instanceof Counter) return existing;
  return new Counter<string>({
    name: METRIC_NAME,
    help: 'User report alert emails to the support inbox, by report kind and outcome.',
    labelNames: ['kind', 'outcome'],
    registers: [promRegistry],
  });
}

@Injectable()
export class ReportAlertService {
  private readonly logger = new Logger(ReportAlertService.name);
  private readonly counter = alertCounter();

  constructor(private readonly email: EmailService) {}

  /** Emails the support inbox about a new report. Resolves in every case. */
  async reportFiled(input: ReportFiledInput): Promise<void> {
    let outcome: string;
    try {
      const result = await this.email.send({
        to: SUPPORT_EMAIL,
        template: EmailTemplateKey.REPORT_ALERT,
        data: reportAlertData(input),
        idempotencyKey: `report-alert:${input.kind}:${input.reportId}`,
      });
      outcome = result.status;
      if (result.status === 'failed') {
        this.logger.error(
          `report alert email failed kind=${input.kind} report=${input.reportId}: ${result.error ?? 'unknown'}`,
        );
      }
    } catch (err) {
      outcome = 'failed';
      this.logger.error(
        `report alert email failed kind=${input.kind} report=${input.reportId}: ${describeFailure(err)}`,
      );
    }
    this.counter.inc({ kind: input.kind, outcome });
  }
}
