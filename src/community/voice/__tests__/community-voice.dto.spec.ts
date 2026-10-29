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
import { CreateVoiceNoteDto, IssueVoiceUploadDto } from '../community-voice.dto';

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

  it('VOICE-BE: accepts up to 64 waveform peaks in 0..1 and a reply parent id', async () => {
    const peaks = Array.from({ length: 64 }, (_, i) => i / 63);
    const out = await pipe.transform(
      { ...VALID, waveform_peaks: peaks, parent_message_id: '33333333-3333-4333-8333-333333333333' },
      meta,
    );
    expect(out.waveform_peaks).toEqual(peaks);
    expect(out.parent_message_id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it.each([
    ['more than 64', Array.from({ length: 65 }, () => 0.5)],
    ['empty', []],
    ['below 0', [0.2, -0.1]],
    ['above 1', [0.2, 1.01]],
    ['not a number', [0.2, 'loud']],
    ['NaN', [0.2, Number.NaN]],
    ['not an array', 0.5],
  ])('VOICE-BE: rejects waveform peaks that are %s', async (_label, waveform_peaks) => {
    await expect(pipe.transform({ ...VALID, waveform_peaks }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('VOICE-BE: rejects a parent id that is not a uuid', async () => {
    await expect(
      pipe.transform({ ...VALID, parent_message_id: 'msg-1' }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still rejects fields the contract does not define', async () => {
    await expect(pipe.transform({ ...VALID, transcript: 'x' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// BPF-1: the upload may name the space the note is for, so that space's own rule decides.
describe('IssueVoiceUploadDto (global ValidationPipe)', () => {
  const upload = { type: 'body' as const, metatype: IssueVoiceUploadDto, data: '' };
  const BODY = { duration_ms: 5000, bytes: 120000, mime_type: 'audio/mp4' };

  it('BPF-1: takes an optional space (cohort_id), the field the send already takes', async () => {
    const out = await pipe.transform({ ...BODY, cohort_id: VALID.cohort_id }, upload);
    expect(out).toBeInstanceOf(IssueVoiceUploadDto);
    expect(out.cohort_id).toBe(VALID.cohort_id);
    await expect(pipe.transform({ ...BODY }, upload)).resolves.toBeInstanceOf(IssueVoiceUploadDto);
  });

  it('BPF-1: refuses a space that is not a uuid, and any other target', async () => {
    for (const extra of [{ cohort_id: 'space-1' }, { conversation_id: VALID.cohort_id }, { parent_message_id: VALID.cohort_id }]) {
      await expect(pipe.transform({ ...BODY, ...extra }, upload)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
