/**
 * ROMAN-HOLD-BE (#197-D3, owner 11-04: "click and hold any other persons chat (opens reply, report,
 * etc)"): the report target for a Roman message. POST /roman/messages/:id/report files a report on one
 * of Roman's replies in the caller's own chat. Only the held message is named (by id, no copy of its
 * text) with a reason from the DM report list; only TGP's team reads the row (RLS: app.is_owner(), live
 * proof in test/rls/roman-message-report-rls.spec.ts); it goes with the message and with the account.
 *
 * Part 1 drives RomanMessageReportService on an in-memory Prisma double. Part 2 boots the real route
 * with the production ValidationPipe and HttpExceptionFilter. No DB, no new words: a message the caller
 * cannot report answers the shipped ROMAN_SESSION_NOT_FOUND (its conversation is gone or not theirs).
 */
import 'reflect-metadata';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { REPORT_REASONS } from '../../src/messages-safety/dto/report-message.dto';
import { PrismaService } from '../../src/prisma.service';
import { RomanMessageReportController } from '../../src/roman/roman-message-report.controller';
import { RomanMessageReportService } from '../../src/roman/roman-message-report.service';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { ROMAN_ERROR_SESSION_NOT_FOUND, ROMAN_SESSION_NOT_FOUND_MESSAGE } from '../../src/roman/roman.constants';

type Msg = { id: string; user_id: string; role: 'user' | 'roman'; session_deleted: boolean };
type Row = { id: string; reporter_id: string; roman_message_id: string; reason: string; details: string | null };

function fakePrisma(messages: Msg[]) {
  const rows: Row[] = [];
  const created: Record<string, unknown>[] = [];
  let n = 0;
  const prisma = {
    romanMessage: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const session = where.session as { deleted_at?: null } | undefined;
        const m = messages.find(
          (x) =>
            x.id === where.id &&
            x.user_id === where.user_id &&
            x.role === where.role &&
            (session?.deleted_at === null ? !x.session_deleted : true),
        );
        return m ? { id: m.id } : null;
      }),
    },
    romanMessageReport: {
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id'> }) => {
        created.push(data as unknown as Record<string, unknown>);
        if (rows.some((r) => r.reporter_id === data.reporter_id && r.roman_message_id === data.roman_message_id)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = { id: `rep_${++n}`, ...data };
        rows.push(row);
        return { id: row.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { reporter_id_roman_message_id: { reporter_id: string; roman_message_id: string } } }) => {
        const k = where.reporter_id_roman_message_id;
        const r = rows.find((x) => x.reporter_id === k.reporter_id && x.roman_message_id === k.roman_message_id);
        return r ? { id: r.id } : null;
      }),
    },
  };
  return { prisma, rows, created };
}

const MESSAGES: Msg[] = [
  { id: 'msg_roman_a', user_id: 'user-A', role: 'roman', session_deleted: false },
  { id: 'msg_turn_a', user_id: 'user-A', role: 'user', session_deleted: false },
  { id: 'msg_roman_b', user_id: 'user-B', role: 'roman', session_deleted: false },
  { id: 'msg_roman_a_deleted', user_id: 'user-A', role: 'roman', session_deleted: true },
];

const caller = { id: 'user-A', role: 'student' };

describe('RomanMessageReportService', () => {
  it("files a report on one of Roman's replies in the caller's own chat, naming only that message", async () => {
    const { prisma, rows, created } = fakePrisma(MESSAGES);
    const svc = new RomanMessageReportService(prisma as unknown as PrismaService);
    await expect(svc.report(caller, 'msg_roman_a', { reason: 'harassment', details: '  rude  ' })).resolves.toEqual({
      reportId: 'rep_1',
      status: 'received',
    });
    expect(rows).toEqual([
      { id: 'rep_1', reporter_id: 'user-A', roman_message_id: 'msg_roman_a', reason: 'harassment', details: 'rude' },
    ]);
    // Only the held message is named, by id: the report carries no copy of the chat.
    expect(Object.keys(created[0]).sort()).toEqual(['details', 'reason', 'reporter_id', 'roman_message_id']);
    expect(prisma.romanMessage.findFirst).toHaveBeenCalledWith({
      where: { id: 'msg_roman_a', user_id: 'user-A', role: 'roman', session: { deleted_at: null } },
      select: { id: true },
    });
  });

  it('stores no details when none (or only spaces) are given', async () => {
    const { prisma, rows } = fakePrisma(MESSAGES);
    const svc = new RomanMessageReportService(prisma as unknown as PrismaService);
    await svc.report(caller, 'msg_roman_a', { reason: 'other', details: '   ' });
    expect(rows[0].details).toBeNull();
  });

  it.each([
    ["the caller's own turn (only Roman's replies are reported)", 'msg_turn_a'],
    ["another client's Roman reply", 'msg_roman_b'],
    ['a reply in a chat the caller deleted', 'msg_roman_a_deleted'],
    ['an id that does not exist', 'msg_missing'],
  ])('refuses %s with the shipped ROMAN_SESSION_NOT_FOUND and writes nothing', async (_label, id) => {
    const { prisma, rows } = fakePrisma(MESSAGES);
    const svc = new RomanMessageReportService(prisma as unknown as PrismaService);
    await expect(svc.report(caller, id, { reason: 'spam' })).rejects.toMatchObject({
      status: 404,
      response: { code: ROMAN_ERROR_SESSION_NOT_FOUND, message: ROMAN_SESSION_NOT_FOUND_MESSAGE },
    });
    expect(rows).toEqual([]);
    expect(prisma.romanMessageReport.create).not.toHaveBeenCalled();
  });

  it('a second report of the same message keeps the first and says it is already reported', async () => {
    const { prisma, rows } = fakePrisma(MESSAGES);
    const svc = new RomanMessageReportService(prisma as unknown as PrismaService);
    await svc.report(caller, 'msg_roman_a', { reason: 'spam' });
    await expect(svc.report(caller, 'msg_roman_a', { reason: 'other', details: 'again' })).resolves.toEqual({
      reportId: 'rep_1',
      status: 'already_reported',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('spam');
  });

  it('passes on a database error that is not the duplicate', async () => {
    const { prisma } = fakePrisma(MESSAGES);
    prisma.romanMessageReport.create.mockRejectedValueOnce(new Error('connection reset'));
    const svc = new RomanMessageReportService(prisma as unknown as PrismaService);
    await expect(svc.report(caller, 'msg_roman_a', { reason: 'spam' })).rejects.toThrow('connection reset');
  });
});

describe('POST /roman/messages/:id/report', () => {
  let app: INestApplication;
  let baseUrl = '';
  const service = {
    report: jest.fn(async (..._a: unknown[]) => ({ reportId: 'rep_1', status: 'received' as const })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RomanMessageReportController],
      providers: [{ provide: RomanMessageReportService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = { id: 'user-A', role: 'student' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => service.report.mockClear());

  const post = (id: string, body: unknown) =>
    fetch(`${baseUrl}/roman/messages/${encodeURIComponent(id)}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('files the report for the signed-in caller and answers 201 { reportId, status }', async () => {
    const res = await post('msg_roman_a', { reason: 'self_harm', details: 'worrying' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reportId: 'rep_1', status: 'received' });
    expect(service.report).toHaveBeenCalledWith({ id: 'user-A', role: 'student' }, 'msg_roman_a', {
      reason: 'self_harm',
      details: 'worrying',
    });
  });

  it.each(REPORT_REASONS.map((r) => [r]))('accepts the DM report reason %s (the same list the report flow sends)', async (reason) => {
    expect((await post('msg_roman_a', { reason })).status).toBe(201);
  });

  it.each([
    ['no reason', {}],
    ['a reason off the list', { reason: 'boring' }],
    ['details over 1000 characters', { reason: 'other', details: 'x'.repeat(1001) }],
    ['a field the route does not take (no message text is accepted)', { reason: 'spam', content: 'copied text' }],
  ])('refuses %s with 400 and files nothing', async (_label, body) => {
    const res = await post('msg_roman_a', body);
    expect(res.status).toBe(400);
    expect(service.report).not.toHaveBeenCalled();
  });

  it('is open to every signed-in role, limited like the DM report, and not behind the Roman chat switch', () => {
    const handler = RomanMessageReportController.prototype.report;
    expect(Reflect.getMetadata('roles', handler)).toEqual(['student', 'coach', 'owner']);
    const guards = [
      ...((Reflect.getMetadata(GUARDS_METADATA, RomanMessageReportController) as unknown[]) ?? []),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
    ];
    expect(guards).not.toContain(RomanFeatureGuard);
    expect(guards).toContain(JwtAuthGuard);
    const keys = Reflect.getMetadataKeys(handler) as string[];
    const limit = keys.find((k) => /THROTTLER:LIMIT/.test(String(k)));
    const ttl = keys.find((k) => /THROTTLER:TTL/.test(String(k)));
    expect(limit && Reflect.getMetadata(limit, handler)).toBe(20);
    expect(ttl && Reflect.getMetadata(ttl, handler)).toBe(3_600_000);
  });
});
