import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma.service';

const SENTINEL =
  'postgresql://synthetic-user:synthetic-password@synthetic-db.internal.invalid/synthetic_schema';
const failureCases: Array<[string, unknown]> = [
  ['driver error', new Error(`Connection failed: ${SENTINEL}`)],
  ['string rejection', `Query failed: ${SENTINEL}`],
  ['plain object rejection', { message: SENTINEL, metadata: { query: SENTINEL } }],
  ['nested cause', Object.assign(new Error('Query failed'), { cause: new Error(SENTINEL) })],
  ['null rejection', null],
  ['undefined rejection', undefined],
  [
    'throwing string conversion',
    {
      toString() {
        throw new Error(SENTINEL);
      },
    },
  ],
];

describe('public readiness HTTP boundary', () => {
  let app: INestApplication;
  let baseUrl: string;
  const query = jest.fn<Promise<unknown[]>, [TemplateStringsArray]>();
  const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { $queryRaw: query } }],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    query.mockReset().mockResolvedValue([{ value: 1 }]);
    logged.mockClear();
  });

  afterAll(async () => {
    await app.close();
    logged.mockRestore();
  });

  it.each(failureCases)('redacts a %s without evaluating its contents', async (_name, failure) => {
    query.mockRejectedValueOnce(failure);
    const response = await fetch(new URL('/readyz', baseUrl));
    const body: unknown = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      db: 'down',
      error: 'database_unavailable',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(query).toHaveBeenCalledWith(['SELECT 1']);
    expect(logged).toHaveBeenCalledWith({
      event: 'readiness_database_unavailable',
      operation: 'health.readiness',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SENTINEL);
  });

  it('retains the successful readiness response and tagged database round trip', async () => {
    const response = await fetch(new URL('/readyz', baseUrl));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      db: 'up',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(['SELECT 1']);
    expect(logged).not.toHaveBeenCalled();
  });

  it.each(['/health', '/healthz'])('keeps %s independent of database health', async (path) => {
    query.mockRejectedValue(new Error(SENTINEL));
    const response = await fetch(new URL(path, baseUrl));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      uptime: expect.any(Number),
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(query).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });
});
