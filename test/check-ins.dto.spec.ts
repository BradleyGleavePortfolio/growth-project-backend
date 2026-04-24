import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCheckInDto } from '../src/check-ins/check-ins.dto';

// Validation-bounds coverage for the Tier-2 POST /check-ins DTO.
// The global ValidationPipe in main.ts sets { whitelist: true,
// forbidNonWhitelisted: true, transform: true }, so these tests mirror the
// transformation + validation pipeline the request actually goes through.
async function validateDto(payload: object) {
  const dto = plainToInstance(CreateCheckInDto, payload, {
    enableImplicitConversion: false,
  });
  return validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
}

describe('CreateCheckInDto validation', () => {
  it('accepts a full valid payload', async () => {
    const errors = await validateDto({
      date: '2026-04-24',
      mood: 3,
      energy: 4,
      sleep_hours: 7.5,
      weight_kg: 80,
      notes: 'ok',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts a payload with only `date` (all subjective fields optional)', async () => {
    const errors = await validateDto({ date: '2026-04-24' });
    expect(errors).toHaveLength(0);
  });

  it('rejects mood < 1', async () => {
    const errors = await validateDto({ date: '2026-04-24', mood: 0 });
    expect(errors.map((e) => e.property)).toContain('mood');
  });

  it('rejects mood > 5', async () => {
    const errors = await validateDto({ date: '2026-04-24', mood: 6 });
    expect(errors.map((e) => e.property)).toContain('mood');
  });

  it('rejects energy > 5', async () => {
    const errors = await validateDto({ date: '2026-04-24', energy: 7 });
    expect(errors.map((e) => e.property)).toContain('energy');
  });

  it('rejects a non-ISO date', async () => {
    const errors = await validateDto({ date: 'yesterday' });
    expect(errors.map((e) => e.property)).toContain('date');
  });

  it('rejects notes longer than 2000 chars', async () => {
    const errors = await validateDto({
      date: '2026-04-24',
      notes: 'x'.repeat(2001),
    });
    expect(errors.map((e) => e.property)).toContain('notes');
  });

  it('rejects sleep_hours > 24', async () => {
    const errors = await validateDto({ date: '2026-04-24', sleep_hours: 30 });
    expect(errors.map((e) => e.property)).toContain('sleep_hours');
  });
});
