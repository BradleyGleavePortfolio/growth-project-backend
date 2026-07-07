import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ScoutCompleteDto, ScoutProgressDto } from './scout.dto';

// Drive the DTOs through the SAME ValidationPipe config the app installs
// globally (src/main.ts): whitelist + forbidNonWhitelisted + transform. This
// exercises the real acceptance/rejection behaviour of every route body rather
// than class-validator in isolation.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function meta(metatype: ArgumentMetadata['metatype']): ArgumentMetadata {
  return { type: 'body', metatype };
}

const validProgress = {
  intent_id: 'intent-1',
  progress: [
    { entity_type: 'clients', count_committed: 3, total_estimated: 10 },
    { entity_type: 'workouts', count_committed: 0, total_estimated: 40 },
  ],
};

const validComplete = {
  intent_id: 'intent-1',
  terminal_status: 'success',
  final_counts: { clients: 10 },
};

describe('ScoutProgressDto validation', () => {
  it('accepts a well-formed status_snapshot', async () => {
    const out = await pipe.transform(validProgress, meta(ScoutProgressDto));
    expect(out).toBeInstanceOf(ScoutProgressDto);
    expect(out.intent_id).toBe('intent-1');
    expect(out.progress).toHaveLength(2);
  });

  it('accepts an optional lastError string', async () => {
    const out = await pipe.transform(
      { ...validProgress, lastError: 'rate limited' },
      meta(ScoutProgressDto),
    );
    expect(out.lastError).toBe('rate limited');
  });

  it('accepts an empty progress array (nothing committed yet)', async () => {
    const out = await pipe.transform(
      { intent_id: 'intent-1', progress: [] },
      meta(ScoutProgressDto),
    );
    expect(out.progress).toEqual([]);
  });

  it('rejects a missing intent_id', async () => {
    await expect(pipe.transform({ progress: [] }, meta(ScoutProgressDto))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-string intent_id', async () => {
    await expect(
      pipe.transform({ intent_id: 123, progress: [] }, meta(ScoutProgressDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing progress array', async () => {
    await expect(
      pipe.transform({ intent_id: 'intent-1' }, meta(ScoutProgressDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects progress that is not an array', async () => {
    await expect(
      pipe.transform({ intent_id: 'intent-1', progress: 'nope' }, meta(ScoutProgressDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a progress entry missing entity_type', async () => {
    await expect(
      pipe.transform(
        {
          intent_id: 'intent-1',
          progress: [{ count_committed: 1, total_estimated: 2 }],
        },
        meta(ScoutProgressDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-integer count_committed', async () => {
    await expect(
      pipe.transform(
        {
          intent_id: 'intent-1',
          progress: [{ entity_type: 'clients', count_committed: 1.5, total_estimated: 2 }],
        },
        meta(ScoutProgressDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative total_estimated', async () => {
    await expect(
      pipe.transform(
        {
          intent_id: 'intent-1',
          progress: [{ entity_type: 'clients', count_committed: 0, total_estimated: -1 }],
        },
        meta(ScoutProgressDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown top-level field (forbidNonWhitelisted)', async () => {
    await expect(
      pipe.transform({ ...validProgress, coach_id: 'attacker-supplied' }, meta(ScoutProgressDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown nested field on a progress entry', async () => {
    await expect(
      pipe.transform(
        {
          intent_id: 'intent-1',
          progress: [
            {
              entity_type: 'clients',
              count_committed: 1,
              total_estimated: 2,
              secret: 'x',
            },
          ],
        },
        meta(ScoutProgressDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an oversized progress array (ArrayMaxSize)', async () => {
    const progress = Array.from({ length: 65 }, () => ({
      entity_type: 'clients',
      count_committed: 0,
      total_estimated: 1,
    }));
    await expect(
      pipe.transform({ intent_id: 'intent-1', progress }, meta(ScoutProgressDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an over-long lastError string', async () => {
    await expect(
      pipe.transform({ ...validProgress, lastError: 'x'.repeat(2001) }, meta(ScoutProgressDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ScoutCompleteDto validation', () => {
  it('accepts a well-formed success completion', async () => {
    const out = await pipe.transform(validComplete, meta(ScoutCompleteDto));
    expect(out).toBeInstanceOf(ScoutCompleteDto);
    expect(out.terminal_status).toBe('success');
    expect(out.final_counts).toEqual({ clients: 10 });
  });

  it('accepts a partial completion with an error_summary', async () => {
    const out = await pipe.transform(
      {
        intent_id: 'intent-1',
        terminal_status: 'partial',
        error_summary: 'library skipped',
      },
      meta(ScoutCompleteDto),
    );
    expect(out.terminal_status).toBe('partial');
    expect(out.error_summary).toBe('library skipped');
  });

  it('accepts a failed completion', async () => {
    const out = await pipe.transform(
      { intent_id: 'intent-1', terminal_status: 'failed' },
      meta(ScoutCompleteDto),
    );
    expect(out.terminal_status).toBe('failed');
  });

  it('accepts a completion without final_counts', async () => {
    const out = await pipe.transform(
      { intent_id: 'intent-1', terminal_status: 'success' },
      meta(ScoutCompleteDto),
    );
    expect(out.final_counts).toBeUndefined();
  });

  it('rejects a missing intent_id', async () => {
    await expect(
      pipe.transform({ terminal_status: 'success' }, meta(ScoutCompleteDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a terminal_status outside the allowed set', async () => {
    await expect(
      pipe.transform({ intent_id: 'intent-1', terminal_status: 'done' }, meta(ScoutCompleteDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing terminal_status', async () => {
    await expect(
      pipe.transform({ intent_id: 'intent-1' }, meta(ScoutCompleteDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-object final_counts', async () => {
    await expect(
      pipe.transform(
        {
          intent_id: 'intent-1',
          terminal_status: 'success',
          final_counts: 'lots',
        },
        meta(ScoutCompleteDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown top-level field', async () => {
    await expect(
      pipe.transform({ ...validComplete, coach_id: 'attacker-supplied' }, meta(ScoutCompleteDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an over-long error_summary', async () => {
    await expect(
      pipe.transform(
        {
          intent_id: 'intent-1',
          terminal_status: 'failed',
          error_summary: 'x'.repeat(2001),
        },
        meta(ScoutCompleteDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
