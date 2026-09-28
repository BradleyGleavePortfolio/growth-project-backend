import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/**
 * FEATURE_CUSTOM_EXERCISE kill-switch.
 *
 * Gates the coach custom-exercise authoring surface (presign an upload URL,
 * durably create a library exercise) and the coach's library list read. Mirrors
 * the community voice-notes resolveVoiceNotesFlag() convention verbatim:
 * FEATURE_CUSTOM_EXERCISE defaults OFF — any value other than the literal
 * 'true' resolves to OFF. The flag is read at the call site EVERY request (never
 * boot-cached) so a runtime kill takes effect without a redeploy.
 *
 * This is the backend half of the mobile custom-exercise stack; the mobile data
 * layer is gated behind its own mobile flag (default off), so both surfaces stay
 * dark until each side is flipped independently.
 *
 * Defined locally in src/coach-exercise/** so the slice owns its own kill switch
 * outright rather than appending to a shared write-flag file.
 */
export const FEATURE_CUSTOM_EXERCISE = 'FEATURE_CUSTOM_EXERCISE';

const DISABLED_BODY = {
  error: 'service_unavailable',
  code: 'coach_exercise.disabled',
} as const;

export function resolveCustomExerciseFlag(): boolean {
  return process.env[FEATURE_CUSTOM_EXERCISE] === 'true';
}

@Injectable()
export class CoachExerciseEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveCustomExerciseFlag()) return true;
    throw new HttpException(DISABLED_BODY, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
