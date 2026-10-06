import { NotFoundException } from '@nestjs/common';

/**
 * A2 coach code tools kill switch. Default OFF: only the literal "true"
 * turns the /coach/codes surface on (ENV_RULES FEATURE_COACH_CODE_TOOLS;
 * flipped by the operator through .github/fly-env-desired-state.json after
 * audit and a device pass). The signup ledger and the specific attach
 * refusals are NOT behind this flag: the ledger must already hold history
 * when the coach first opens the screen, and the refusals only sharpen copy.
 */
export function coachCodeToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FEATURE_COACH_CODE_TOOLS ?? '').trim().toLowerCase() === 'true';
}

export const COACH_CODE_TOOLS_DISABLED = 'coach_code_tools_disabled' as const;

export function assertCoachCodeToolsEnabled(): void {
  if (coachCodeToolsEnabled()) return;
  throw new NotFoundException({
    code: COACH_CODE_TOOLS_DISABLED,
    message:
      'Code tools are not available on your account yet. Your coach link in Settings keeps working in the meantime.',
  });
}
