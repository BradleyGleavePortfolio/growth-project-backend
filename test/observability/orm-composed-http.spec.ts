import 'reflect-metadata';
import {
  BadRequestException,
  ConsoleLogger,
  Controller,
  Get,
  INestApplication,
  Logger,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { ThrottlerExceptionFilter } from '../../src/filters/throttler-exception.filter';
import { AppLoggerService } from '../../src/observability/app-logger.service';
import { LoggingInterceptor } from '../../src/observability/logging.interceptor';
import { MetricsService } from '../../src/observability/metrics.service';
import { reportProcessError } from '../../src/observability/process-errors';
import { buildSentryOptions } from '../../src/observability/sentry-config';
import { PrismaService } from '../../src/prisma.service';

const PRIVATE = 'SYNTHETIC_PRIVATE_ORM_MEDICAL_NOTE';
const orm = () => new Prisma.PrismaClientValidationError(PRIVATE, { clientVersion: 'test' });
let failure: unknown;

@Controller('diagnostic-fixture')
class DiagnosticController {
  @Get(':id')
  read() {
    if (failure) throw failure;
    return { ok: true };
  }
}

describe('composed ORM diagnostics before every shared sink', () => {
  let app: INestApplication;
  let url: string;
  const envelopes: unknown[] = [];
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  const originalEnv = process.env.NODE_ENV;
  const originalFormat = process.env.LOG_FORMAT;

  beforeAll(async () => {
    // Real SDK serialization with a local transport. No external telemetry.
    Sentry.init({
      ...buildSentryOptions('https://public@example.invalid/1', { NODE_ENV: 'test' }),
      defaultIntegrations: false,
      tracesSampleRate: 0,
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    process.env.LOG_FORMAT = 'json';
    const module = await Test.createTestingModule({
      controllers: [DiagnosticController],
      providers: [AppLoggerService, MetricsService],
    }).compile();
    app = module.createNestApplication({ logger: false });
    const logger = app.get(AppLoggerService);
    app.useLogger(logger);
    app.useGlobalInterceptors(new LoggingInterceptor(logger, app.get(MetricsService)));
    app.useGlobalFilters(
      new HttpExceptionFilter(),
      new ThrottlerExceptionFilter(app.get(MetricsService)),
    );
    // Failure before routing must use a static diagnostic path, not a raw URL.
    app.use('/unmatched-fixture', (_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
      next(failure);
    });
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = 'synthetic-correlation';
      next();
    });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  beforeEach(() => {
    envelopes.length = 0;
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.env.NODE_ENV = originalEnv;
    failure = undefined;
    AppLoggerService.requestId = undefined;
    AppLoggerService.userId = undefined;
  });

  afterAll(async () => {
    await app.close();
    await Sentry.close(2000);
    Logger.overrideLogger(new ConsoleLogger());
    if (originalFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = originalFormat;
  });

  it.each([
    ['validation', () => orm(), 500],
    ['wrapped cause', () => Object.assign(new Error(PRIVATE), { cause: orm() }), 500],
    ['HTTP wrapper', () => new BadRequestException(PRIVATE, { cause: orm() }), 400],
    [
      'known request',
      () =>
        new Prisma.PrismaClientKnownRequestError(PRIVATE, {
          code: 'P2002',
          clientVersion: 'test',
          meta: { private: PRIVATE },
        }),
      500,
    ],
  ] as const)(
    'sanitizes %s through interceptor, filter, stdout and SDK transport',
    async (_label, makeError, status) => {
      failure = makeError();
      Sentry.getCurrentScope().setExtra('unsafe_extra', PRIVATE);
      const response = await fetch(`${url}/diagnostic-fixture/record-123`);
      const body = await response.json();
      await Sentry.flush(2000);
      const output = JSON.stringify([stdout.mock.calls, stderr.mock.calls]);

      expect(response.status).toBe(status);
      expect(body.request_id).toBe('synthetic-correlation');
      expect(JSON.stringify(body)).not.toContain(PRIVATE);
      expect(output).not.toContain(PRIVATE);
      expect(output).toContain('diagnostic-fixture/:id');
      expect(envelopes).toHaveLength(status >= 500 ? 1 : 0);
      if (status >= 500) {
        expect(JSON.stringify(envelopes)).toContain('DatabaseRequestError');
        expect(JSON.stringify(envelopes)).toContain('synthetic-correlation');
        expect(JSON.stringify(envelopes)).not.toContain(PRIVATE);
      }
    },
  );

  it('retains useful successful HTTP metadata without logging concrete path identifiers', async () => {
    const response = await fetch(`${url}/diagnostic-fixture/private-path-id`);
    expect(await response.json()).toEqual({ ok: true });
    const output = JSON.stringify(stdout.mock.calls);
    expect(output).toContain('diagnostic-fixture/:id');
    expect(output).toContain('200');
    expect(output).not.toContain('private-path-id');
    expect(envelopes).toHaveLength(0);
  });

  it.each([
    ['ORM', () => orm(), 500],
    ['ordinary unexpected', () => new Error('Unexpected operation failure'), 500],
    ['throttled', () => new ThrottlerException(), 429],
  ] as const)(
    'does not log path/query credentials on matched and unmatched %s failures',
    async (_label, makeError, status) => {
      for (const prefix of ['/diagnostic-fixture', '/unmatched-fixture']) {
        failure = makeError();
        const requestPath = `${prefix}/SYNTHETIC_INVITATION_TOKEN?token=SYNTHETIC_QUERY_SECRET`;
        const response = await fetch(`${url}${requestPath}`);
        const body = await response.json();
        await Sentry.flush(2000);
        expect(response.status).toBe(status);
        const diagnostics = JSON.stringify([stdout.mock.calls, stderr.mock.calls, envelopes]);
        expect(diagnostics).not.toContain('SYNTHETIC_INVITATION_TOKEN');
        expect(diagnostics).not.toContain('SYNTHETIC_QUERY_SECRET');
        expect(JSON.stringify(stdout.mock.calls)).toContain(
          prefix === '/unmatched-fixture' ? '[unmatched]' : '/diagnostic-fixture/:id',
        );
        // Caller-owned URL remains in the existing client envelope deliberately.
        // This compatibility contract must not be changed as a logging repair.
        if (status !== 429 && prefix === '/diagnostic-fixture') {
          expect(body.path).toBe(requestPath);
        }
      }
    },
  );

  it('preserves non-ORM caller validation and does not log its private message', async () => {
    failure = new BadRequestException('Invalid field');
    const response = await fetch(`${url}/diagnostic-fixture/record`);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('Invalid field');
    expect(JSON.stringify(stdout.mock.calls)).not.toContain('Invalid field');
    expect(envelopes).toHaveLength(0);
  });

  it.each(['UnhandledRejection', 'UncaughtException'] as const)(
    'sanitizes the real %s reporter before both output sinks',
    async (kind) => {
      reportProcessError(kind, Object.assign(new Error(PRIVATE), { cause: orm() }));
      await Sentry.flush(2000);
      expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain(PRIVATE);
      expect(JSON.stringify(stdout.mock.calls)).toContain(kind);
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).toContain('DatabaseRequestError');
      expect(JSON.stringify(envelopes)).not.toContain(PRIVATE);
    },
  );

  it.each([orm(), PRIVATE, null])(
    'contains startup rejection without inspecting private content',
    async (error) => {
      process.env.NODE_ENV = 'production';
      const prisma = new PrismaService();
      jest.spyOn(prisma, '$connect').mockRejectedValueOnce(error);
      await prisma.onModuleInit();
      await Promise.resolve();
      const output = JSON.stringify([stdout.mock.calls, stderr.mock.calls]);
      expect(output).toContain('database_startup_connection_failed');
      expect(output).not.toContain(PRIVATE);
      expect(envelopes).toHaveLength(0);
    },
  );
});
