/**
 * B-REPORTALERT-125 (Apple 1.2): every new DM or community report emails the
 * support inbox (ids, kind, reason label, time; self-harm first), never any
 * message text, details, notes or names, and a failed email never fails the
 * report. On main no email is sent, so the delivery tests fail there.
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';

import { EmailService } from '../../src/email/email.service';
import { EmailTemplateKey, type SendEmailInput, type SendEmailResult } from '../../src/email/email.types';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { promRegistry } from '../../src/observability/prom-metrics';
import { SUPPORT_EMAIL } from '../../src/public-pages/trust-pages.html';
import { MessagesSafetyService } from '../../src/messages-safety/messages-safety.service';
import { MessagesSafetyModule } from '../../src/messages-safety/messages-safety.module';
import { CommunityModule } from '../../src/community/community.module';
import { CommunityModerationService } from '../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../src/community/moderation/community-moderation.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import { ReportAlertService, reportAlertData, reportAlertSubject, type ReportFiledInput } from '../../src/report-alerts/report-alert.service';
import { InMemoryPrisma } from '../community/safety/in-memory-prisma';

const stub = <T>(v: object): T => v as T;

const REPORT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const MSG_ID = 'b1b2c3d4-0000-4000-8000-000000000002';
const FILED = new Date('2026-10-06T21:45:00.000Z');

type SendFn = (input: SendEmailInput) => Promise<SendEmailResult>;

const emailWith = (send: jest.Mock<ReturnType<SendFn>, Parameters<SendFn>>) => stub<EmailService>({ send });
const sentOk: SendFn = (input) =>
  Promise.resolve({ status: 'sent', providerMessageId: 'em_1', idempotencyKey: input.idempotencyKey });
const render = (data: Record<string, unknown>) =>
  new EmailService(stub<PrismaService>({}), new ConfigService({})).render(EmailTemplateKey.REPORT_ALERT, data);
const tick = () => new Promise((r) => setImmediate(r));

async function counterValue(kind: string, outcome: string): Promise<number> {
  const metric = promRegistry.getSingleMetric('report_alert_email_total');
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.kind === kind && v.labels.outcome === outcome)?.value ?? 0;
}

const dmInput = (over: Partial<ReportFiledInput> = {}): ReportFiledInput => ({
  kind: 'message', reportId: REPORT_ID, reason: 'harassment', createdAt: FILED, targetType: 'message', targetId: MSG_ID, ...over,
});

describe('ReportAlertService: the support inbox hears about every report', () => {
  it('emails SUPPORT_EMAIL with the report id, kind, reason label and time', async () => {
    const send = jest.fn(sentOk);
    await new ReportAlertService(emailWith(send)).reportFiled(dmInput());
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.to).toBe(SUPPORT_EMAIL);
    expect(arg.template).toBe(EmailTemplateKey.REPORT_ALERT);
    expect(arg.idempotencyKey).toBe(`report-alert:message:${REPORT_ID}`);
    expect(arg.data).toMatchObject({ report_id: REPORT_ID, kind_label: 'Direct message report', target_id: MSG_ID });
    expect(arg.data).toMatchObject({ reason_label: 'Harassment or bullying', time_utc: FILED.toISOString(), self_harm: false });
    expect(String(arg.data.subject)).toBe('New DM report a1b2c3d4: Harassment or bullying');
  });

  it('puts "Self-harm or suicide" first in the subject and the body', () => {
    const input = dmInput({ reason: 'self_harm' });
    expect(reportAlertSubject(input).startsWith('Self-harm or suicide report')).toBe(true);
    const out = render(reportAlertData(input));
    expect(out.subject.startsWith('Self-harm or suicide report')).toBe(true);
    expect(out.html).toContain('This is a self-harm or suicide report. Review it first.');
    expect(out.html.indexOf('self-harm or suicide report')).toBeLessThan(out.html.indexOf(REPORT_ID));
  });

  it('names the folded DM category and fixed community labels, never the free text', async () => {
    const send = jest.fn(sentOk);
    const details = 'Violence or threats. Jordan Smith said he would hurt me at the gym';
    await new ReportAlertService(emailWith(send)).reportFiled(dmInput({ details }));
    const data = send.mock.calls[0][0].data;
    expect(data.reason_label).toBe('Violence or threats');
    const out = render(data);
    expect(`${out.subject} ${out.html}`).not.toMatch(/Jordan|hurt me|gym/);

    const community = reportAlertData({ ...dmInput(), kind: 'community', reason: 'Jordan is a creep', targetType: 'post' });
    expect(community.reason_label).toBe('Something else (unlisted reason code)');
    expect(JSON.stringify(community)).not.toContain('Jordan');
  });

  it('never rejects: a failed send or a thrown send is logged and counted', async () => {
    const before = await counterValue('message', 'failed');
    const failed = jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(async (input) => ({
      status: 'failed', providerMessageId: null, idempotencyKey: input.idempotencyKey, error: 'provider=resend status=500',
    }));
    await expect(new ReportAlertService(emailWith(failed)).reportFiled(dmInput())).resolves.toBeUndefined();
    const thrown = jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(() => Promise.reject(new Error('network down')));
    await expect(new ReportAlertService(emailWith(thrown)).reportFiled(dmInput())).resolves.toBeUndefined();

    expect(await counterValue('message', 'failed')).toBe(before + 2);
  });

  it('is provided by both report modules, so production injects it', () => {
    const providers = (m: object): unknown[] => Reflect.getMetadata('providers', m) ?? [];
    expect(providers(MessagesSafetyModule)).toContain(ReportAlertService);
    expect(providers(CommunityModule)).toContain(ReportAlertService);
  });
});

describe('MessagesSafetyService.reportMessage alerts the support inbox', () => {
  function build(send: jest.Mock<ReturnType<SendFn>, Parameters<SendFn>>) {
    const reports: Array<{ id: string; reporter_id: string; message_id: string }> = [];
    const msg = { id: MSG_ID, coach_id: 'coach-1', client_id: 'client-1', sender_id: 'coach-1' };
    const prisma = stub<PrismaService>({
      coachMessage: { findUnique: jest.fn(async () => msg) },
      messageReport: {
        create: jest.fn(async ({ data }: { data: { reporter_id: string; message_id: string } }) => {
          if (reports.some((r) => r.reporter_id === data.reporter_id && r.message_id === data.message_id)) {
            throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
          }
          const row = { id: REPORT_ID, created_at: FILED, ...data };
          reports.push(row);
          return { id: row.id, created_at: row.created_at };
        }),
        findUnique: jest.fn(async () => ({ id: REPORT_ID })),
      },
    });
    const audit = stub<AuditService>({ write: jest.fn(async () => undefined) });
    const analytics = stub<AnalyticsService>({ capture: jest.fn() });
    return { svc: new MessagesSafetyService(prisma, audit, analytics, new ReportAlertService(emailWith(send))), reports };
  }

  it('files the report and sends one alert with ids only', async () => {
    const send = jest.fn(sentOk);
    const { svc } = build(send);
    const out = await svc.reportMessage('client-1', { messageId: MSG_ID, reason: 'self_harm', details: 'he wants to end it' });
    await tick();
    expect(out).toEqual({ reportId: REPORT_ID, status: 'received' });
    expect(send).toHaveBeenCalledTimes(1);
    const data = send.mock.calls[0][0].data;
    expect(String(data.subject).startsWith('Self-harm or suicide report')).toBe(true);
    expect(JSON.stringify(data)).not.toContain('end it');
  });

  it('still files the report when the email throws, and a repeat report sends nothing', async () => {
    const send = jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(() => Promise.reject(new Error('resend down')));
    const { svc, reports } = build(send);
    const out = await svc.reportMessage('client-1', { messageId: MSG_ID, reason: 'spam' });
    const again = await svc.reportMessage('client-1', { messageId: MSG_ID, reason: 'spam' });
    await tick();
    expect([out.status, again.status]).toEqual(['received', 'already_reported']);
    expect(reports).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('CommunityModerationService.report alerts the support inbox', () => {
  const COACH = '11111111-1111-4111-8111-111111111111';
  const WS = '22222222-2222-4222-8222-222222222222';
  const MEMBER = '55555555-5555-4555-8555-555555555555';
  const POST = '66666666-6666-4666-8666-666666666666';

  it('files the report and emails the id, the post id and the reason label, never the notes', async () => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    const db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    db.seed('user', { id: COACH, role: 'coach', coach_id: null });
    const member = stub<User>(db.seed('user', { id: MEMBER, role: 'student', coach_id: COACH }));
    db.seed('communityWorkspace', { id: WS, coach_id: COACH, archived_at: null });
    db.seed('communityMembership', { workspace_id: WS, cohort_id: null, user_id: MEMBER, status: 'active', role: 'student' });
    db.seed('communityPost', { id: POST, workspace_id: WS, author_id: COACH });
    const send = jest.fn(sentOk);
    const svc = new CommunityModerationService(
      new CommunityAccessService(prisma),
      new CommunityModerationRepository(prisma),
      new CommunityMessagesRepository(prisma),
      new CommunityPostsRepository(prisma),
      stub<CommunityRealtimeService>({}),
      stub<CommunityNotificationsService>({}),
      prisma,
      stub<VoiceUploadProvider>({}),
      new ReportAlertService(emailWith(send)),
    );
    const out = await svc.report(member, 'post', POST, 'violence', 'my neighbour Sam keeps posting threats');
    await tick();
    expect(out.item.status).toBe('open');
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.idempotencyKey).toBe(`report-alert:community:${out.item.id}`);
    expect(arg.data).toMatchObject({ report_id: out.item.id, kind_label: 'Community report', target_id: POST });
    expect(arg.data).toMatchObject({ reason_label: 'Threats or violence', target_type: 'post' });
    expect(JSON.stringify(arg.data)).not.toMatch(/Sam|neighbour/);
  });
});
