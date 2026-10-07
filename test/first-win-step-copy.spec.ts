/**
 * FU-FIRSTRUN-126 (AUDIT-01-125 U-01-3): the Day One win is recorded the
 * moment the client taps a card, before anything is logged, and the app then
 * opens the logger. The message shown under "YOUR FIRST STEP" must not claim
 * the action already happened, and the habits card (first_checkin) must not
 * talk about a coach or a check-in: it opens the habit list and is shown to
 * clients without a coach too.
 */
import {
  PerplexityHandle,
  type PerplexityChatClient,
} from '../src/ai-egress/ai-egress.service';
import { FirstWinService, type WinType } from '../src/first-win/first-win.service';
import { egressWithGrants, fakeOf } from './ai-egress/ai-egress.fakes';

const WINS: readonly WinType[] = [
  'logged_first_weight',
  'set_first_goal',
  'first_checkin',
  'first_meal',
];

function prismaFake() {
  return {
    user: {
      findUniqueOrThrow: jest.fn(async () => ({ first_win_completed_at: null })),
      update: jest.fn(async () => ({})),
    },
  };
}

describe('first-win: the message matches a first step, not a finished action', () => {
  const prev = process.env.PERPLEXITY_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = prev;
  });

  it('the model is told what the client chose to do, never that it is done', async () => {
    process.env.PERPLEXITY_API_KEY = 'pk-test';
    const { egress } = egressWithGrants([]);
    const create = jest.fn(async (_req: { messages: Array<{ content: string }> }) => ({
      choices: [{ message: { content: 'A fixed two sentence reply here.' } }],
    }));
    const svc = new FirstWinService(fakeOf(prismaFake()), egress);
    svc['_perplexity'] = PerplexityHandle.bind(
      fakeOf<PerplexityChatClient>({ chat: { completions: { create } } }),
    );
    svc['_perplexityInitialized'] = true;
    for (const win of WINS) await svc.complete('user-1', win);

    const calls = create.mock.calls;
    const turns = calls.map((c) => c[0].messages[1].content);
    expect(turns).toHaveLength(4);
    for (const t of turns) {
      expect(t).toMatch(/^The client has just chosen to [a-z0-9 -]+ as their first step\. Write the 2-sentence message\.$/);
      expect(t).not.toMatch(/\b(logged|submitted)\b/);
    }
    expect(turns[2]).toContain('check off their daily habits');
    expect(calls[0][0].messages[0].content).toContain('Do not say or imply the action is already done');
  });

  it('without a provider, the habits fallback mentions neither a coach nor a check-in', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const { egress } = egressWithGrants([]);
    const svc = new FirstWinService(fakeOf(prismaFake()), egress);
    const habits = await svc.complete('user-1', 'first_checkin');
    expect(habits.aiMessage).toMatch(/habits/);
    expect(habits.aiMessage).not.toMatch(/coach|check-in/i);
    const meal = await svc.complete('user-1', 'first_meal');
    expect(meal.aiMessage).not.toMatch(/coach/i);
  });
});
