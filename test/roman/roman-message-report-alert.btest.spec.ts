/**
 * LO-1223 B-TEST (Opus lens, b#1223 @ 95a97dfa): a report on one of Roman's replies must reach a person,
 * like every other user report (B-REPORTALERT-125, src/report-alerts/report-alert.service.ts:10-17:
 * "every new user report emails the support inbox ... so a person sees it inside the promised 24
 * hours"). At the head RomanMessageReportService never calls ReportAlertService.reportFiled and
 * RomanModule does not provide it, so a self-harm report on a Roman reply is stored and nobody is told.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { EmailService } from '../../src/email/email.service';
import { PrismaService } from '../../src/prisma.service';
import { ReportAlertService } from '../../src/report-alerts/report-alert.service';
import { RomanMessageReportService } from '../../src/roman/roman-message-report.service';
import { RomanModule } from '../../src/roman/roman.module';

const MSG_ID = 'cmsgromanreply000000000001';
const REPORT_ID = '6f1c2a40-0000-4000-8000-000000000001';
const DETAILS = 'details text the reporter typed';

describe('LO-1223 B-TEST: a Roman report alerts the support inbox', () => {
  it('a new Roman report emails the support inbox once (self-harm first, ids only); a repeat sends nothing', async () => {
    expect(Reflect.getMetadata('providers', RomanModule) ?? []).toContain(ReportAlertService);

    const rows: Array<{ reporter_id: string; roman_message_id: string }> = [];
    const prisma = {
      romanMessage: { findFirst: jest.fn(async () => ({ id: MSG_ID })) },
      romanMessageReport: {
        create: jest.fn(async ({ data }: { data: { reporter_id: string; roman_message_id: string } }) => {
          if (rows.some((r) => r.reporter_id === data.reporter_id && r.roman_message_id === data.roman_message_id)) {
            throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
          }
          rows.push(data);
          return { id: REPORT_ID, created_at: new Date('2026-11-05T20:00:00Z') };
        }),
        findUnique: jest.fn(async () => ({ id: REPORT_ID })),
      },
    };
    const send = jest.fn(async () => ({ status: 'sent' as const }));
    const mod = await Test.createTestingModule({
      providers: [
        RomanMessageReportService,
        ReportAlertService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send } },
      ],
    }).compile();
    const svc = mod.get(RomanMessageReportService);
    const caller = { id: 'client-a', role: 'student' };

    const first = await svc.report(caller, MSG_ID, { reason: 'self_harm', details: DETAILS });
    const again = await svc.report(caller, MSG_ID, { reason: 'self_harm' });
    await new Promise((r) => setImmediate(r));

    expect([first.status, again.status]).toEqual(['received', 'already_reported']);
    expect(send).toHaveBeenCalledTimes(1);
    const data = (send.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(String(data.subject).startsWith('Self-harm or suicide report')).toBe(true);
    expect(JSON.stringify(data)).toContain(REPORT_ID);
    expect(JSON.stringify(data)).toContain(MSG_ID);
    expect(JSON.stringify(data)).not.toContain(DETAILS);
  });
});
