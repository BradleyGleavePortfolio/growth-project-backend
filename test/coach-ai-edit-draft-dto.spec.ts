/**
 * AUDIT-14-125 — POST /coach/ai/drafts/:id/edit must accept `{ patch }`.
 *
 * The app sends `{ patch: { ...edited payload } }` from AIWorkoutDraftScreen
 * and AIMealPlanDraftScreen ("Save edits"). The global ValidationPipe
 * (src/main.ts: whitelist + forbidNonWhitelisted + transform) refuses any
 * property without a class-validator decorator, so the undecorated `patch`
 * made every save a 400 "property patch should not exist".
 */
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { EditDraftDto } from '../src/ai/coach/coach-ai.dto';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta: ArgumentMetadata = { type: 'body', metatype: EditDraftDto, data: '' };

describe('EditDraftDto under the global ValidationPipe (AUDIT-14-125)', () => {
  it('accepts the edit body the app sends and keeps the patch intact', async () => {
    const patch = {
      title: 'Strength block',
      weeks: [{ week: 1, days: [{ day: 1, exercises: [{ name: 'Squat', sets: 4, reps: 6 }] }] }],
    };
    const out = (await pipe.transform({ patch }, meta)) as EditDraftDto;
    expect(out.patch).toEqual(patch);
  });

  it('still refuses a non-object patch and unknown keys', async () => {
    await expect(pipe.transform({ patch: 'x' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ patch: {}, extra: 1 }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });
});
