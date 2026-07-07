// DTO-boundary validation for the pairing endpoints. A malformed chosen_platform
// or code must be rejected by class-validator BEFORE the request reaches the
// service (and thus before any DB lookup), so these tests drive the DTOs through
// the same validate() path the global ValidationPipe uses.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PairInitDto, PairRedeemDto } from '../extension-pair.dto';

async function errorsFor<T extends object>(cls: new () => T, payload: unknown) {
  const dto = plainToInstance(cls, payload);
  return validate(dto as object);
}

describe('PairInitDto', () => {
  it('accepts a well-formed lowercase platform slug', async () => {
    const errors = await errorsFor(PairInitDto, { chosen_platform: 'truecoach' });
    expect(errors).toHaveLength(0);
  });

  it('accepts slugs with digits, dashes and underscores', async () => {
    for (const slug of ['trainerize', 'mypt-hub', 'my_pt_hub2']) {
      const errors = await errorsFor(PairInitDto, { chosen_platform: slug });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an uppercase platform slug', async () => {
    const errors = await errorsFor(PairInitDto, { chosen_platform: 'TrueCoach' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('matches');
  });

  it('rejects a slug containing spaces or punctuation', async () => {
    for (const bad of ['true coach', 'true.coach', 'true/coach']) {
      const errors = await errorsFor(PairInitDto, { chosen_platform: bad });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects an over-long slug (> 64 chars)', async () => {
    const errors = await errorsFor(PairInitDto, { chosen_platform: 'a'.repeat(65) });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('maxLength');
  });

  it('rejects a non-string platform', async () => {
    const errors = await errorsFor(PairInitDto, { chosen_platform: 12345 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('isString');
  });

  it('rejects a missing platform', async () => {
    const errors = await errorsFor(PairInitDto, {});
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('PairRedeemDto', () => {
  it('accepts exactly six digits', async () => {
    const errors = await errorsFor(PairRedeemDto, { code: '142856' });
    expect(errors).toHaveLength(0);
  });

  it('accepts a six-digit code with leading zeros', async () => {
    const errors = await errorsFor(PairRedeemDto, { code: '000042' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a code that is too short', async () => {
    const errors = await errorsFor(PairRedeemDto, { code: '12345' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('matches');
  });

  it('rejects a code that is too long', async () => {
    const errors = await errorsFor(PairRedeemDto, { code: '1234567' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric code', async () => {
    for (const bad of ['abcdef', '12ab56', '1428 6']) {
      const errors = await errorsFor(PairRedeemDto, { code: bad });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a non-string code', async () => {
    const errors = await errorsFor(PairRedeemDto, { code: 142856 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('isString');
  });

  it('rejects a missing code', async () => {
    const errors = await errorsFor(PairRedeemDto, {});
    expect(errors.length).toBeGreaterThan(0);
  });
});
