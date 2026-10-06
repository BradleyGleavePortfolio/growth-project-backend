// Independent Sol W1C delta assertions. Source files remain unmodified.
import {
  classifyAiGuideCrisis,
} from '../src/ai/ai-crisis-router';
import {
  AiService,
  DAILY_TOKEN_QUOTA,
  AI_DAILY_QUOTA_EXCEEDED,
} from '../src/ai/ai.service';
import {
  egressWithGrants,
  grantAllEgress,
} from './ai-egress/ai-egress.fakes';

// Invoke the real chat method, real consent gate, and real quota reservation.
// Only unrelated prompt construction and downstream collaborators are doubled.
function serviceAtCap(consent = true) {
  const model = jest.fn();
  const context = jest.fn().mockResolvedValue({});
  const upsert = jest.fn().mockResolvedValue({ tokens_used: DAILY_TOKEN_QUOTA });
  const updateMany = jest.fn();
  const svc = Object.create(AiService.prototype) as AiService;
  Object.assign(svc, {
    logger: { log: jest.fn() },
    contextSvc: { build: context },
    anthropic: { complete: model },
    coachAIState: { isReady: () => true },
    egress: consent ? grantAllEgress() : egressWithGrants([]).egress,
    prisma: { userAIQuota: { upsert, updateMany } },
    buildSystemPrompt: jest.fn().mockReturnValue(''),
  });
  return { svc, model, context, upsert, updateMany };
}

describe('AUD-SOL-W1C-123 prior crisis Bs and controls', () => {
  it.each([
    ['I took a whole bottle of Tylenol', 'emergency', '911'],
    ['I am going to hang myself', 'self_harm', '988'],
  ])('at cap and without consent: %s', async (message, classification, line) => {
    const { svc, model, context, upsert, updateMany } = serviceAtCap(false);
    const result = await svc.chat('client', message, []);
    expect(result.guardrails_applied).toEqual([`crisis:${classification}`]);
    expect(result.reply).toContain(line);
    expect(result.model_used).toBe('safety');
    expect(context).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it.each([
    'overdose on cardio',
    'can you overdose on creatine?',
    'I hurt myself deadlifting, can I train?',
    'kill this workout',
    "I'm dying after leg day",
    'took 2 Tylenol for my headache',
  ])('normal control retains the quota refusal rather than crisis: %s', async (message) => {
    expect(classifyAiGuideCrisis(message)).toBeNull();
    const { svc, model } = serviceAtCap();
    await expect(svc.chat('client', message, [])).rejects.toMatchObject({
      response: { error: AI_DAILY_QUOTA_EXCEEDED },
    });
    expect(model).not.toHaveBeenCalled();
  });
});

describe('AUD-SOL-W1C-123 breathing delta must retain acute emergencies', () => {
  it.each([
    'I cannot breathe after my workout. I need help now.',
    'I can’t breathe during my workout. Please help me.',
  ])('acute inability to breathe is not a form question: %s', async (message) => {
    const { svc, model, upsert } = serviceAtCap();
    const observation = await svc.chat('client', message, []).then(
      (result) => ({ reply: result.reply, model_used: result.model_used }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        response: Reflect.apply(Reflect.get(Object(error), 'getResponse'), error, []),
      }),
    );
    console.log('SOL acute-breathing observation', JSON.stringify({ message, observation }));
    expect(observation).toMatchObject({
      reply: expect.stringContaining('911'),
      model_used: 'safety',
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('unqualified inability to breathe remains an emergency control', async () => {
    const { svc } = serviceAtCap();
    const result = await svc.chat('client', 'I cannot breathe. I need help now.', []);
    expect(result.reply).toContain('911');
    expect(result.model_used).toBe('safety');
  });

  it.each([
    'I find it hard to breathe during heavy squats, how should I brace',
    'I can’t breathe through my nose when I run, any tips',
    'I have trouble breathing on long runs',
  ])('retains the requested ordinary breathing control: %s', (message) => {
    expect(classifyAiGuideCrisis(message)).toBeNull();
  });
});
