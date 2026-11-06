import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReportAlertService } from '../report-alerts/report-alert.service';
import type { ReportReason } from '../messages-safety/dto/report-message.dto';
import { romanSessionNotFound, type RomanCaller } from './roman.service';

export interface RomanMessageReportInput {
  reason: ReportReason;
  details?: string;
}

export interface RomanMessageReportResult {
  reportId: string;
  status: 'received' | 'already_reported';
}

/**
 * ROMAN-HOLD-BE (owner #197-D3): files a client's report on one of Roman's replies, the server half of
 * press-and-hold Report in Roman's chat. The report names only the held message (by id) with a reason
 * from the DM report list; only TGP's team reads it (RLS, 20270502011200). The message must be Roman's
 * reply in the caller's own live chat; anything else (their own turn, another user's chat, a deleted
 * chat, an unknown id) answers the shipped ROMAN_SESSION_NOT_FOUND, so no new words and no probing.
 * One report per reporter and message: a second one keeps the first and says so.
 * B-REPORTALERT-125 (fix round 1, B1-1223): a new report emails the support inbox (ids and the reason
 * only), as the DM and community reports do; a repeat sends nothing, and a failed email keeps the report.
 * C1-1223: a new report also writes an audit row, as the DM report does (ids and the reason, no details
 * text). No analytics event: Roman sends nothing to product analytics today (b#1223 Found, not fixed).
 */
@Injectable()
export class RomanMessageReportService {
  constructor(
    private readonly prisma: PrismaService,
    // Both optional so unit harnesses that build the service by hand keep working (as
    // MessagesSafetyService). RomanModule provides ReportAlertService; AuditModule is global.
    @Optional() private readonly reportAlerts?: ReportAlertService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async report(
    caller: RomanCaller,
    messageId: string,
    input: RomanMessageReportInput,
  ): Promise<RomanMessageReportResult> {
    const message = await this.prisma.romanMessage.findFirst({
      where: { id: messageId, user_id: caller.id, role: 'roman', session: { deleted_at: null } },
      select: { id: true },
    });
    if (!message) throw romanSessionNotFound();

    const details = input.details?.trim() || null;
    let created: { id: string; created_at: Date };
    try {
      created = await this.prisma.romanMessageReport.create({
        data: { reporter_id: caller.id, roman_message_id: message.id, reason: input.reason, details },
        select: { id: true, created_at: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.romanMessageReport.findUnique({
          where: { reporter_id_roman_message_id: { reporter_id: caller.id, roman_message_id: message.id } },
          select: { id: true },
        });
        if (existing) return { reportId: existing.id, status: 'already_reported' };
      }
      throw err;
    }

    // Only a new report reaches here. Best-effort, fire-and-forget: neither can fail the report.
    // No coach id anywhere: the coach never sees a Roman chat or its reports.
    void this.audit?.write({
      action: 'safety.roman_message_reported',
      actorId: caller.id,
      actorRole: caller.role,
      targetType: 'roman_message',
      targetId: message.id,
      metadata: { reason: input.reason, has_details: details !== null },
    });
    // reportFiled() never rejects, so the report always files and the caller still gets `received`.
    void this.reportAlerts?.reportFiled({
      kind: 'roman',
      reportId: created.id,
      reason: input.reason,
      createdAt: created.created_at,
      targetType: 'roman_message',
      targetId: message.id,
    });
    return { reportId: created.id, status: 'received' };
  }
}
