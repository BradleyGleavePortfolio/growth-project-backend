/**
 * FIX-1223 (b#1223 fix round 1, B1-1223, class-first): every place in src/ that creates a user report
 * emails the support inbox exactly once per new report (B-REPORTALERT-125), with ids only, and a failed
 * email never fails the report. The class is "a user report with no person told". The source scan
 * below fails if a new report-creating call appears in src/ without a row in this table.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, type User } from '@prisma/client';

import type { EmailService } from '../../src/email/email.service';
import type { SendEmailInput, SendEmailResult } from '../../src/email/email.types';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService, AuditWriteInput } from '../../src/audit/audit.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
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
import { RomanMessageReportService } from '../../src/roman/roman-message-report.service';
import { RomanModule } from '../../src/roman/roman.module';
import { ReportAlertService, reportAlertData, type ReportFiledInput } from '../../src/report-alerts/report-alert.service';
import { InMemoryPrisma } from '../community/safety/in-memory-prisma';

const stub = <T>(v: object): T => v as T;
type SendFn = (input: SendEmailInput) => Promise<SendEmailResult>;
type SendMock = jest.Mock<ReturnType<SendFn>, Parameters<SendFn>>;
const sentOk = (): SendMock =>
  jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(async (input) => ({
    status: 'sent', providerMessageId: 'em_1', idempotencyKey: input.idempotencyKey,
  }));
const sendThrows = (): SendMock =>
  jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(() => Promise.reject(new Error('provider down')));
const alertsWith = (send: SendMock) => new ReportAlertService(stub<EmailService>({ send }));
const tick = () => new Promise((r) => setImmediate(r));
const unique = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });

const FILED = new Date('2026-11-05T20:00:00.000Z');
const SECRET = 'free text the reporter typed';

interface Filed { reportId: string; status: string }
interface Path {
  /** The src/ file holding the create call (matched by the source scan). */
  file: string;
  kind: ReportFiledInput['kind'];
  targetId: string;
  /** A second report of the same target by the same person adds no row (and so no alert). */
  dedupes: boolean;
  build: (send: SendMock) => { file: () => Promise<Filed>; rows: () => number };
}

const DM_MSG = 'b1b2c3d4-0000-4000-8000-000000000002';
const ROMAN_MSG = 'cmsgromanreply000000000001';
const COACH = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const POST = '66666666-6666-4666-8666-666666666666';

function keyedRows<T extends { reporter_id: string }>(key: (d: T) => string) {
  const rows: T[] = [];
  return {
    rows,
    create: jest.fn(async ({ data }: { data: T }) => {
      if (rows.some((r) => key(r) === key(data))) throw unique();
      rows.push(data);
      return { id: `a1b2c3d4-0000-4000-8000-00000000000${rows.length}`, created_at: FILED };
    }),
    findUnique: jest.fn(async () => ({ id: 'a1b2c3d4-0000-4000-8000-000000000001' })),
  };
}

const PATHS: Path[] = [
  {
    file: 'src/messages-safety/messages-safety.service.ts',
    kind: 'message',
    targetId: DM_MSG,
    dedupes: true,
    build: (send) => {
      const table = keyedRows<{ reporter_id: string; message_id: string }>((d) => `${d.reporter_id}:${d.message_id}`);
      const prisma = stub<PrismaService>({
        coachMessage: { findUnique: jest.fn(async () => ({ id: DM_MSG, coach_id: 'coach-1', client_id: 'client-1', sender_id: 'coach-1' })) },
        messageReport: table,
      });
      const svc = new MessagesSafetyService(
        prisma,
        stub<AuditService>({ write: jest.fn(async () => undefined) }),
        stub<AnalyticsService>({ capture: jest.fn() }),
        alertsWith(send),
      );
      return {
        file: () => svc.reportMessage('client-1', { messageId: DM_MSG, reason: 'self_harm', details: SECRET }),
        rows: () => table.rows.length,
      };
    },
  },
  {
    // Also the path of POST /community/challenges/:id/comments/:commentId/report
    // (community-challenges.service.ts reportComment delegates to CommunityModerationService.report).
    file: 'src/community/moderation/community-moderation.repository.ts',
    kind: 'community',
    targetId: POST,
    dedupes: false,
    build: (send) => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const db = new InMemoryPrisma();
      const prisma = stub<PrismaService>(db);
      db.seed('user', { id: COACH, role: 'coach', coach_id: null });
      const member = stub<User>(db.seed('user', { id: MEMBER, role: 'student', coach_id: COACH }));
      db.seed('communityWorkspace', { id: WS, coach_id: COACH, archived_at: null });
      const space = db.seed('communityCohort', { workspace_id: WS, archived_at: null });
      db.seed('communityMembership', { workspace_id: WS, cohort_id: space.id, user_id: MEMBER, status: 'active', role: 'student' });
      db.seed('communityPost', { id: POST, workspace_id: WS, author_id: COACH });
      const svc = new CommunityModerationService(
        new CommunityAccessService(prisma),
        new CommunityModerationRepository(prisma),
        new CommunityMessagesRepository(prisma),
        new CommunityPostsRepository(prisma),
        stub<CommunityRealtimeService>({}),
        stub<CommunityNotificationsService>({}),
        prisma,
        stub<VoiceUploadProvider>({}),
        alertsWith(send),
      );
      let n = 0;
      return {
        file: async () => {
          n += 1;
          const out = await svc.report(member, 'post', POST, 'self_harm', SECRET);
          return { reportId: out.item.id, status: out.item.status };
        },
        rows: () => n,
      };
    },
  },
  {
    file: 'src/roman/roman-message-report.service.ts',
    kind: 'roman',
    targetId: ROMAN_MSG,
    dedupes: true,
    build: (send) => {
      const table = keyedRows<{ reporter_id: string; roman_message_id: string }>((d) => `${d.reporter_id}:${d.roman_message_id}`);
      const prisma = stub<PrismaService>({
        romanMessage: { findFirst: jest.fn(async () => ({ id: ROMAN_MSG })) },
        romanMessageReport: table,
      });
      const svc = new RomanMessageReportService(prisma, alertsWith(send));
      return {
        file: () => svc.report({ id: 'client-a', role: 'student' }, ROMAN_MSG, { reason: 'self_harm', details: SECRET }),
        rows: () => table.rows.length,
      };
    },
  },
];

/** Every src/ call that creates a user report row (the three report tables). */
function reportCreateSites(): string[] {
  const root = path.resolve(__dirname, '../../src');
  const hits = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/\.(messageReport|romanMessageReport|communityModerationAction)\s*\.\s*(create|createMany|upsert)\s*\(/.test(text)) {
          hits.add(path.relative(path.resolve(root, '..'), full).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(root);
  return [...hits].sort();
}

describe('FIX-1223 class-first: every user report reaches the support inbox once', () => {
  it('the table lists every report-creating call in src/', () => {
    expect(reportCreateSites()).toEqual(PATHS.map((p) => p.file).sort());
  });

  it('every report module provides ReportAlertService, so production injects it', () => {
    const providers = (m: object): unknown[] => Reflect.getMetadata('providers', m) ?? [];
    for (const m of [MessagesSafetyModule, CommunityModule, RomanModule]) expect(providers(m)).toContain(ReportAlertService);
  });

  it.each(PATHS.map((p) => [p.kind, p] as const))(
    '%s: a new report sends one alert (self-harm first, ids only); a repeat of a deduped report sends nothing',
    async (_kind, p) => {
      const send = sentOk();
      const lane = p.build(send);
      const first = await lane.file();
      await tick();
      expect(first.status).toBe(p.kind === 'community' ? 'open' : 'received');
      expect(send).toHaveBeenCalledTimes(1);
      const arg = send.mock.calls[0][0];
      expect(arg.idempotencyKey).toBe(`report-alert:${p.kind}:${first.reportId}`);
      expect(String(arg.data.subject).startsWith('Self-harm or suicide report: review now')).toBe(true);
      expect(arg.data).toMatchObject({ report_id: first.reportId, target_id: p.targetId, self_harm: true });
      expect(JSON.stringify(arg.data)).not.toContain(SECRET);

      if (p.dedupes) {
        const again = await lane.file();
        await tick();
        expect(again).toEqual({ reportId: first.reportId, status: 'already_reported' });
        expect(lane.rows()).toBe(1);
        expect(send).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(PATHS.map((p) => [p.kind, p] as const))('%s: a failed alert keeps the report and the receipt', async (_kind, p) => {
    const send = sendThrows();
    const lane = p.build(send);
    const out = await lane.file();
    await tick();
    expect(out.status).toBe(p.kind === 'community' ? 'open' : 'received');
    expect(lane.rows()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('FIX-1223: the Roman alert words and its audit row', () => {
  const base = { reportId: 'a1b2c3d4-0000-4000-8000-000000000001', createdAt: FILED, targetId: ROMAN_MSG };

  it('names a Roman report as such and leaves the DM and community subjects as they were', () => {
    const roman = reportAlertData({ ...base, kind: 'roman', reason: 'harassment', targetType: 'roman_message' });
    expect(roman).toMatchObject({
      subject: 'New Roman report a1b2c3d4: Harassment or bullying',
      kind_label: 'Roman reply report',
      reason_label: 'Harassment or bullying',
      target_type: 'roman_message',
      review_hint: 'Look it up by the report id in the RomanMessageReport table.',
    });
    expect(reportAlertData({ ...base, kind: 'message', reason: 'spam', targetType: 'message' }).subject).toBe(
      'New DM report a1b2c3d4: Spam',
    );
    expect(reportAlertData({ ...base, kind: 'community', reason: 'spam', targetType: 'post' }).subject).toBe(
      'New community report a1b2c3d4: Spam or scams',
    );
  });

  it('writes one audit row for a new Roman report (ids and reason, no text, no coach) and none on a repeat', async () => {
    const writes: AuditWriteInput[] = [];
    const audit = stub<AuditService>({ write: jest.fn(async (w: AuditWriteInput) => void writes.push(w)) });
    const table = keyedRows<{ reporter_id: string; roman_message_id: string }>((d) => `${d.reporter_id}:${d.roman_message_id}`);
    const prisma = stub<PrismaService>({ romanMessage: { findFirst: jest.fn(async () => ({ id: ROMAN_MSG })) }, romanMessageReport: table });
    const svc = new RomanMessageReportService(prisma, alertsWith(sentOk()), audit);
    const caller = { id: 'client-a', role: 'student' };
    await svc.report(caller, ROMAN_MSG, { reason: 'self_harm', details: SECRET });
    await svc.report(caller, ROMAN_MSG, { reason: 'self_harm' });
    await tick();
    expect(writes).toEqual([
      {
        action: 'safety.roman_message_reported',
        actorId: 'client-a',
        actorRole: 'student',
        targetType: 'roman_message',
        targetId: ROMAN_MSG,
        metadata: { reason: 'self_harm', has_details: true },
      },
    ]);
    expect(JSON.stringify(writes)).not.toContain(SECRET);
  });
});
