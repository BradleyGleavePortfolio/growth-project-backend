import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
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
 */
@Injectable()
export class RomanMessageReportService {
  constructor(private readonly prisma: PrismaService) {}

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
    try {
      const created = await this.prisma.romanMessageReport.create({
        data: { reporter_id: caller.id, roman_message_id: message.id, reason: input.reason, details },
        select: { id: true },
      });
      return { reportId: created.id, status: 'received' };
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
  }
}
