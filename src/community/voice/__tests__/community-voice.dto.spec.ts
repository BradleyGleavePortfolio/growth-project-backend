/**
 * CreateVoiceNoteDto through the app's real global ValidationPipe settings
 * (src/main.ts: whitelist + forbidNonWhitelisted + transform).
 *
 * Regression: `storage_key` had no class-validator decorator, so the
 * whitelist treated it as unknown and every POST /community/workspaces/:id/
 * voice-notes answered 400 "property storage_key should not exist". With
 * voice notes on at launch, no member could ever publish one.
 */
import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateVoiceNoteDto } from '../community-voice.dto';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = { type: 'body' as const, metatype: CreateVoiceNoteDto, data: '' };

const VALID = {
  storage_key: '11111111-1111-4111-8111-111111111111/1700000000-abc.m4a',
  cohort_id: '22222222-2222-4222-8222-222222222222',
  duration_ms: 5000,
  bytes: 120000,
  mime_type: 'audio/mp4',
};

describe('CreateVoiceNoteDto (global ValidationPipe)', () => {
  it('accepts the body the app sends, keeping storage_key', async () => {
    const out = await pipe.transform({ ...VALID }, meta);
    expect(out).toBeInstanceOf(CreateVoiceNoteDto);
    expect(out.storage_key).toBe(VALID.storage_key);
    expect(out.duration_ms).toBe(5000);
  });

  it('rejects a missing, empty or oversized storage_key', async () => {
    const missing: Record<string, unknown> = { ...VALID };
    delete missing.storage_key;
    await expect(pipe.transform(missing, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...VALID, storage_key: '' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      pipe.transform({ ...VALID, storage_key: 'k'.repeat(513) }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still rejects fields the contract does not define', async () => {
    await expect(pipe.transform({ ...VALID, transcript: 'x' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
