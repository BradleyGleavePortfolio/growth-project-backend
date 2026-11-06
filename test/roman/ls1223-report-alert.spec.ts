/**
 * LS-1223 B1: a report of a Roman reply must reach the same support-alert
 * boundary used by direct-message and community reports.
 * Test only. No owner-facing subject/body copy is proposed here.
 */
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { ReportAlertService } from '../../src/report-alerts/report-alert.service';
import { RomanMessageReportService } from '../../src/roman/roman-message-report.service';

describe('LS-1223 B1: Roman report support delivery', () => {
  it('alerts the support boundary once for a new report, not again for a repeat tap', async () => {
    const reportFiled = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      romanMessage: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-A' }) },
      romanMessageReport: {
        create: jest.fn()
          .mockResolvedValueOnce({ id: 'report-A' })
          .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate report', {
            code: 'P2002', clientVersion: '6.0.0',
          })),
        findUnique: jest.fn().mockResolvedValue({ id: 'report-A' }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        RomanMessageReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReportAlertService, useValue: { reportFiled } },
      ],
    }).compile();
    const service = module.get(RomanMessageReportService);
    const reporter = { id: 'client-A', role: 'student' };

    await expect(service.report(reporter, 'reply-A', { reason: 'self_harm' })).resolves.toEqual({
      reportId: 'report-A', status: 'received',
    });
    await expect(service.report(reporter, 'reply-A', { reason: 'self_harm' })).resolves.toEqual({
      reportId: 'report-A', status: 'already_reported',
    });
    expect(prisma.romanMessageReport.create).toHaveBeenCalledTimes(2);
    expect(reportFiled).toHaveBeenCalledTimes(1);
    expect(reportFiled).toHaveBeenCalledWith(expect.objectContaining({
      reportId: 'report-A',
      targetId: 'reply-A',
      reason: 'self_harm',
    }));
    await module.close();
  });
});
