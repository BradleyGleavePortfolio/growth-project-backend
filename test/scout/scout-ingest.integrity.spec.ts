import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PrismaService } from '../../src/prisma.service';
import { ScoutIngestDto } from '../../src/scout/scout-ingest.dto';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';

const invalidDates = [
  '0000-01-01T00:00:00Z',
  '0001-01-01T00:00:00+01:00',
  '20260915T234500Z',
  '2026-W35',
  '2026-241',
  '2026-09-15',
  '2026-02-30T12:00:00Z',
  '2026-09-15T24:00:00Z',
  '2026-09-15T12:00:60Z',
  '2026-09-15T12:00:00',
  'Infinity',
  '',
  '2026-09-15T12:00:00+25:00',
];
const validDates = [
  '2026-09-15T12:00:00Z',
  '2024-02-29T12:00:00.123Z',
  '2026-09-15T12:00:00+05:30',
  '2026-09-15T12:00:00.1-07:00',
];
function dto(capturedAt = validDates[0]): ScoutIngestDto {
  return {
    intent_id: 'integrity',
    entity_type: 'clients',
    entities: [
      {
        sourceId: '1042',
        sourcePlatform: 'truecoach',
        capturedAt,
        payload: {},
      },
    ],
  };
}
function build() {
  const createMany = jest.fn(async () => ({ count: 1 }));
  const capture = jest.fn();
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutIngestEntity: { createMany },
  });
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture,
  });
  return { service: new ScoutIngestService(prisma, analytics), createMany, capture };
}
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

describe('ingest integrity boundary', () => {
  it.each(invalidDates)('rejects unsupported timestamp %s with 400 before Prisma', async (date) => {
    const { service, createMany, capture } = build();
    await expect(
      pipe.transform(dto(date), { type: 'body', metatype: ScoutIngestDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ingest('coach', dto(date))).rejects.toBeInstanceOf(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
  it.each(validDates)('accepts finite supported timestamp %s', async (date) => {
    const { service, createMany } = build();
    const validated = await pipe.transform(dto(date), { type: 'body', metatype: ScoutIngestDto });
    await service.ingest('coach', validated);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            captured_at: new Date(date),
          }),
        ],
      }),
    );
  });
  it('requires canonical case-sensitive platform slugs instead of silently aliasing identities', async () => {
    const { service, createMany } = build();
    for (const sourcePlatform of ['TrueCoach', ' truecoach ', ' ', 'coách', 'bad/platform']) {
      const body = dto();
      body.entities[0].sourcePlatform = sourcePlatform;
      await expect(
        pipe.transform(body, { type: 'body', metatype: ScoutIngestDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.ingest('coach', body)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(createMany).not.toHaveBeenCalled();
  });
  it.each([
    'accessToken',
    'refresh-token',
    'PRIVATE.KEY',
    'api key',
    'creditCard',
    'card_number',
    'privateKey',
    'clientSecret',
    'sessionId',
    'paymentToken',
    'PAN',
    'cvc',
    'CVV',
    'password',
    'fullCardNumber',
    'credit-card-number',
    'paymentCredentials',
    'sessionSecret',
    'idToken',
    'cookies',
  ])('removes nested credential alias %s without losing billing metadata', async (key) => {
    const { service, createMany } = build();
    const billing = {
      membership: 'active',
      amount: 100,
      currency: 'USD',
      interval: 'month',
      nextPayment: '2026-10-15',
      paymentStatus: 'paid',
      brand: 'visa',
      last4: '4242',
    };
    const body = dto();
    body.entities[0].payload = { billing, nested: [{ [key]: 'SYNTHETIC_SECRET', value: 7 }] };
    await service.ingest('coach', body);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            payload: { billing, nested: [{ value: 7 }] },
          }),
        ],
      }),
    );
  });
});
