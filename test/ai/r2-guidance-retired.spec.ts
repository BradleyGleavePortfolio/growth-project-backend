// R2 (audit MED-01 two AI chats, MED-02 Guidance skips Roman's safety checks).
// POST /ai/chat is retired: it never calls the model (AiService.chat) and
// answers app builds already in users' hands with a fixed reply in the same
// response shape. A crisis message keeps the fixed 988 / 911 reply. The
// context reads (non-chat) keep working.
import { AiController } from '../../src/ai/ai.controller';
import { AI_GUIDE_CRISIS_REPLIES } from '../../src/ai/ai-crisis-router';
import type { AuthedRequest } from '../../src/auth/auth-request';

const RETIRED_REPLY =
  'Guidance has moved to Roman. Open the You tab and choose Roman to keep chatting.';

function fakeOf<T>(v: unknown): T {
  return v as T;
}

function makeAi() {
  return {
    chat: jest.fn().mockResolvedValue({
      reply: 'model reply',
      guardrails_applied: [],
      context_generated_at: '2026-10-11T00:00:00Z',
      model_used: 'anthropic',
      degraded: false,
    }),
    getUserContext: jest.fn().mockResolvedValue({ legacy: true }),
    getStructuredContext: jest.fn().mockResolvedValue({ structured: true }),
  };
}

// A coached client (coach_id set) passes the Roman-requires-coach check.
const COACHED = fakeOf<AuthedRequest>({
  user: { id: 'client-1', role: 'student', coach_id: 'coach-1' },
});

describe('R2 — POST /ai/chat is retired; Roman is the only AI chat', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('a coached client gets the fixed retirement reply and the model is never called', async () => {
    const ai = makeAi();
    const res = await new AiController(fakeOf(ai)).chat(COACHED, {
      message: 'What should I eat tonight?',
      conversation_history: [{ role: 'user', content: 'hi' }],
    });
    expect(ai.chat).not.toHaveBeenCalled();
    expect(res.reply).toBe(RETIRED_REPLY);
    expect(res).toMatchObject({ degraded: false, code: 'AI_GUIDE_RETIRED' });
    expect(typeof res.timestamp).toBe('string');
  });

  it('an urgent-sounding health question still never reaches the model', async () => {
    const ai = makeAi();
    const res = await new AiController(fakeOf(ai)).chat(COACHED, {
      message: 'I have been throwing up all day on my GLP-1 dose, what should I eat?',
    });
    expect(ai.chat).not.toHaveBeenCalled();
    expect(res.reply).toBe(RETIRED_REPLY);
  });

  it('a crisis message keeps the fixed 988 / 911 reply, still without the model', async () => {
    const ai = makeAi();
    const res = await new AiController(fakeOf(ai)).chat(COACHED, {
      message: 'I want to kill myself',
    });
    expect(ai.chat).not.toHaveBeenCalled();
    expect(res.reply).toBe(AI_GUIDE_CRISIS_REPLIES.self_harm);
    expect(res).not.toHaveProperty('code');
    expect(res.degraded).toBe(false);
  });

  it('production keeps the old shape without model or debug', async () => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production' };
    const res = await new AiController(fakeOf(makeAi())).chat(COACHED, { message: 'hi' });
    expect(Object.keys(res).sort()).toEqual(['code', 'degraded', 'reply', 'timestamp']);
  });

  it('the non-chat context reads keep working', async () => {
    const ai = makeAi();
    const ctrl = new AiController(fakeOf(ai));
    await expect(ctrl.getContext(COACHED)).resolves.toEqual({ legacy: true });
    await expect(ctrl.getStructuredContext(COACHED)).resolves.toEqual({ structured: true });
    expect(ai.getUserContext).toHaveBeenCalledWith('client-1');
    expect(ai.getStructuredContext).toHaveBeenCalledWith('client-1');
  });
});
