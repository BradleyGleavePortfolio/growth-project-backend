/**
 * AUD-OPUS-FU2-118 probe (Claude Opus 5.5 lens, agent 118) on #700 @ 66569a61.
 * Not for merge. Claim under test: "no log line under src/ carries a person's
 * name" (src/observability/README.md, test/privacy/no-pii-in-logs.spec.ts
 * guard). CoachBriefService.callClaude logs `coach=${safeCoachName}`, the
 * coach's full name, on every Claude contract failure and Claude error.
 * Expected at the PR head: both tests FAIL (the name reaches a log line).
 */
import { Logger } from '@nestjs/common';
import { CoachBriefService } from '../../src/coach/brief/coach-brief.service';
import type { BriefAiInput } from '../../src/coach/brief/coach-brief.service';
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

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
const SURNAME = 'Quillfeather';

function spyLogs(): () => string[] {
  const spies = LEVELS.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map((args: unknown[]) =>
        args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '),
      ),
    );
}

afterEach(() => jest.restoreAllMocks());

function run(scenario: Parameters<typeof makeMockAnthropic>[0]) {
  const svc = new CoachBriefService(
    asPrismaService(makeMockPrisma()),
    asConfig(makeMockConfig()),
    grantAllEgress(),
    asAnthropic(makeMockAnthropic(scenario)),
  );
  const ctx = makeBriefContext({
    coach_name: `Patricia ${SURNAME}`,
    coach_first_name: 'Patricia',
    workouts_pending_approval: 1,
  });
  const ai: BriefAiInput = { ctx, subject: clientDataSubject(['client-1'], 'coach') };
  return svc.callClaude(ctx, ai);
}

describe('AUD-OPUS-FU2-118 probe: coach brief log lines and the coach name', () => {
  it('Claude call error: no log line holds the coach name', async () => {
    const lines = spyLogs();
    const res = await run(new Error('upstream 529 overloaded'));
    expect(res.generated_by).toBe('fallback');
    const all = lines();
    expect(all.join('\n')).toContain('CoachBrief Claude call failed');
    for (const line of all) expect(line).not.toContain(SURNAME);
  });

  it('Claude contract failure twice: no log line holds the coach name', async () => {
    const lines = spyLogs();
    const tooFew = 'Patricia, there are updates this morning. Watch for more.';
    const res = await run([tooFew, tooFew]);
    expect(res.generated_by).toBe('fallback');
    const all = lines();
    expect(all.join('\n')).toContain('failed contract');
    for (const line of all) expect(line).not.toContain(SURNAME);
  });
});
