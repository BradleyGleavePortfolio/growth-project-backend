import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateNudgeDto, ListNudgesQueryDto } from '../src/nudges/nudges.dto';

// Recreates the production ValidationPipe shape from src/main.ts so these
// tests exercise the same whitelist/forbid semantics that reject forged fields
// in prod.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function run<T>(dto: new () => T, value: unknown, type: 'body' | 'query' = 'body'): Promise<T> {
  return pipe.transform(value, { type, metatype: dto as any });
}

describe('CreateNudgeDto', () => {
  it('accepts a valid title + body and trims whitespace on both', async () => {
    const out = await run(CreateNudgeDto, { title: '  Hydrate!  ', body: '  Drink water  ' });
    expect(out.title).toBe('Hydrate!');
    expect(out.body).toBe('Drink water');
  });

  it('rejects title longer than 80 chars; accepts exactly 80', async () => {
    await expect(
      run(CreateNudgeDto, { title: 'x'.repeat(81), body: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const ok = await run(CreateNudgeDto, { title: 'x'.repeat(80), body: 'ok' });
    expect(ok.title.length).toBe(80);
  });

  it('rejects body longer than 500 chars; accepts exactly 500', async () => {
    await expect(
      run(CreateNudgeDto, { title: 'ok', body: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const ok = await run(CreateNudgeDto, { title: 'ok', body: 'x'.repeat(500) });
    expect(ok.body.length).toBe(500);
  });

  it('rejects empty-after-trim title or body', async () => {
    await expect(run(CreateNudgeDto, { title: '   ', body: 'ok' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(CreateNudgeDto, { title: 'ok', body: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects missing title or body', async () => {
    await expect(run(CreateNudgeDto, { body: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(run(CreateNudgeDto, { title: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects forged fields (coach_id, client_id, read_at)', async () => {
    await expect(
      run(CreateNudgeDto, { title: 'ok', body: 'ok', coach_id: 'attacker' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateNudgeDto, { title: 'ok', body: 'ok', read_at: new Date().toISOString() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ListNudgesQueryDto', () => {
  it('accepts a valid ISO-8601 `since` and numeric `limit`', async () => {
    const out = await run(ListNudgesQueryDto, { since: '2026-04-24T00:00:00Z', limit: '10' }, 'query');
    expect(out.since).toBe('2026-04-24T00:00:00Z');
    expect(out.limit).toBe(10);
  });

  it('rejects non-ISO `since`', async () => {
    await expect(
      run(ListNudgesQueryDto, { since: 'not-a-date' }, 'query'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects limit > 100 or < 1', async () => {
    await expect(run(ListNudgesQueryDto, { limit: '101' }, 'query')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(ListNudgesQueryDto, { limit: '0' }, 'query')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an empty query (both fields optional)', async () => {
    const out = await run(ListNudgesQueryDto, {}, 'query');
    expect(out.since).toBeUndefined();
    expect(out.limit).toBeUndefined();
  });
});
