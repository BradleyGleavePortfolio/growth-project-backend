import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateMessageDto, ListThreadQueryDto } from '../src/messaging/messaging.dto';

// The production app wires ValidationPipe globally with these flags (see
// src/main.ts). Recreating the same shape here ensures our DTOs behave in
// tests the way they will in production — in particular, `forbidNonWhitelisted`
// is what rejects mass-assignment attempts like a forged `sender_id`.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function run<T>(dto: new () => T, value: unknown, type: 'body' | 'query' = 'body'): Promise<T> {
  return pipe.transform(value, { type, metatype: dto as any });
}

describe('CreateMessageDto', () => {
  it('accepts a plain body and trims whitespace', async () => {
    const out = await run(CreateMessageDto, { body: '  hello  ' });
    expect(out.body).toBe('hello');
  });

  it('rejects empty-after-trim bodies with 400', async () => {
    await expect(run(CreateMessageDto, { body: '     ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(CreateMessageDto, { body: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an empty payload at the DTO layer (service enforces MESSAGE_EMPTY at send time)', async () => {
    // Phase 6C: `body` is now optional because a message can be voice-only.
    // The DTO no longer requires it; MessagingService.assertSendablePayload
    // is the cross-field guard that rejects (body missing && voice missing).
    const ok = await run(CreateMessageDto, {});
    expect(ok.body).toBeUndefined();
    expect(ok.voice).toBeUndefined();
  });

  it('rejects bodies larger than 4000 chars', async () => {
    await expect(
      run(CreateMessageDto, { body: 'x'.repeat(4001) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // exactly 4000 is fine.
    const ok = await run(CreateMessageDto, { body: 'x'.repeat(4000) });
    expect(ok.body?.length).toBe(4000);
  });

  it('strips / rejects forged fields (sender_id, coach_id, read_at)', async () => {
    // whitelist=true means unknown keys are stripped; forbidNonWhitelisted=true
    // means they instead throw — we expect the stricter behavior here.
    await expect(
      run(CreateMessageDto, {
        body: 'hi',
        sender_id: 'attacker',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateMessageDto, { body: 'hi', coach_id: 'other', read_at: new Date().toISOString() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ListThreadQueryDto', () => {
  it('accepts a valid ISO-8601 `before` and numeric `limit`', async () => {
    const out = await run(ListThreadQueryDto, { before: '2026-04-24T00:00:00Z', limit: '25' }, 'query');
    expect(out.before).toBe('2026-04-24T00:00:00Z');
    expect(out.limit).toBe(25);
  });

  it('rejects a non-ISO `before`', async () => {
    await expect(
      run(ListThreadQueryDto, { before: 'not-a-date' }, 'query'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects limit > 100 or < 1', async () => {
    await expect(run(ListThreadQueryDto, { limit: '101' }, 'query')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(ListThreadQueryDto, { limit: '0' }, 'query')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an empty query (both fields optional)', async () => {
    const out = await run(ListThreadQueryDto, {}, 'query');
    expect(out.before).toBeUndefined();
    expect(out.limit).toBeUndefined();
  });
});
