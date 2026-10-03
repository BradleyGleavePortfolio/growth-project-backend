// Operator note (agent 113): the brief shipped a retired model id
// (claude-3-5-sonnet-20241022), so every call failed into the fallback.
// Pins the brief and Roman reply drafts to the shared model config
// (COACH_AI_MODEL) rather than any literal id. Fails on main before the fix.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { COACH_AI_MODEL } from '../../src/ai/coach/coach-ai.constants';
import { BRIEF_CLAUDE_MODEL, CoachBriefService } from '../../src/coach/brief/coach-brief.service';
import { ROMAN_DRAFT_MODEL } from '../../src/coach/brief/roman/roman-reply-drafts.service';
import {
  asAnthropic,
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeMockAnthropic,
  makeMockConfig,
  makeMockPrisma,
} from '../_fixtures/coach-brief-mocks';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { clientDataSubject } from '../../src/ai-egress/ai-egress.types';

// Ids the provider has retired. Extend when a retirement is announced.
const RETIRED_MODEL_IDS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20240620',
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('coach brief model config', () => {
  it('brief and Roman drafts use the shared COACH_AI_MODEL, which is not retired', () => {
    expect(BRIEF_CLAUDE_MODEL).toBe(COACH_AI_MODEL);
    expect(ROMAN_DRAFT_MODEL).toBe(COACH_AI_MODEL);
    expect(RETIRED_MODEL_IDS).not.toContain(COACH_AI_MODEL);
  });

  it('no file under src/coach/brief carries a literal model id', () => {
    const offenders = filesUnder(join(__dirname, '../../src/coach/brief')).filter((f) =>
      /['"`]claude-[a-z0-9.-]+['"`]/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the live brief call sends the shared model id to the provider', async () => {
    const anthropic = makeMockAnthropic(
      'Sarah, we ran your roster this morning and pulled together what matters. We saw 1 check-in so far today. We have nothing else that needs you yet.',
    );
    const svc = new CoachBriefService(
      asPrismaService(makeMockPrisma()),
      asConfig(makeMockConfig()),
      grantAllEgress(),
      asAnthropic(anthropic),
    );
    const ctx = makeBriefContext({ roster_size: 1 });
    await svc.callClaude(ctx, { ctx, subject: clientDataSubject(['client-1'], 'coach') });
    expect(anthropic.messages.create).toHaveBeenCalled();
    expect(anthropic.messages.create.mock.calls[0][0].model).toBe(COACH_AI_MODEL);
  });
});
