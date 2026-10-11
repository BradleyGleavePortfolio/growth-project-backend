// test/roman/roman-urgent-symptoms.spec.ts
//
// A red-flag symptom on a GLP-1 or other weight-loss medicine gets the fixed
// reply (no model call) and the client's coach gets the existing coach alert.
// Symptom groups follow the FDA label warnings and Medication Guides
// (pancreatitis, gallbladder, dehydration, allergic reaction, fainting, low
// blood sugar, thyroid). No network, no DB.

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import { RomanService } from '../../src/roman/roman.service';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import {
  classifySafety,
  ROMAN_SAFETY_ROUTER_MODEL_ID,
  ROMAN_SAFETY_TEMPLATES,
  ROMAN_URGENT_COACH_ALERT,
} from '../../src/roman/guardrails/safety-router';
import { postCheckRomanReply } from '../../src/roman/guardrails/roman-post-check';
import { AppModule } from '../../src/app.module';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  process.env[FLAG] = 'true';
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const REPLY =
  'This needs medical attention. Contact your prescribing clinic today. If symptoms are severe, call 911.';

const MEDICINES = [
  'Ozempic',
  'Wegovy',
  'Rybelsus',
  'semaglutide',
  'Mounjaro',
  'Zepbound',
  'tirzepatide',
  'Victoza',
  'Saxenda',
  'liraglutide',
  'GLP-1',
  'a GLP1',
  'a weight loss shot',
];

const SYMPTOMS: Record<string, string[]> = {
  'severe or persistent stomach pain': [
    'I have severe stomach pain',
    'there is a terrible pain in my upper stomach',
    "my stomach pain won't go away",
    'my belly hurts and it goes through to my back',
    'I have had abdominal pain for 3 days',
  ],
  'vomiting that will not stop': [
    "I can't keep any water down",
    'I cannot keep anything down since yesterday',
    'I keep throwing up',
    "I've been vomiting and it won't stop",
    'I threw up all night',
  ],
  'yellow skin or eyes': [
    'my eyes look yellow',
    'I noticed yellowing of my skin',
    'I think I am jaundiced',
  ],
  'a serious allergic reaction': [
    'my face is swollen',
    'my lips swelled up after the dose',
    'I broke out in hives',
    'I have trouble swallowing',
  ],
  fainting: ['I fainted this morning', 'I passed out after my shot', 'I blacked out in the shower'],
  'very low blood sugar': [
    'I think I am having low blood sugar',
    'my blood sugar is really low',
    'I feel shaky and confused',
  ],
  'a lump or swelling in the neck': ['I found a lump in my neck', 'my neck is swollen on one side'],
};

describe('urgent_symptoms: a weight-loss medicine plus a red-flag symptom', () => {
  for (const [group, phrases] of Object.entries(SYMPTOMS)) {
    it(`${group}: routes to the fixed reply with every medicine name`, () => {
      for (const symptom of phrases) {
        for (const med of MEDICINES) {
          const route = classifySafety(`I'm on ${med} and ${symptom}`);
          expect({ med, symptom, cls: route.class }).toEqual({ med, symptom, cls: 'urgent_symptoms' });
          expect(route.short_circuit).toBe(true);
        }
      }
    });
  }

  it('the same symptoms without a medicine name keep their usual route (drug-scoped)', () => {
    for (const symptom of Object.values(SYMPTOMS).flat()) {
      expect(classifySafety(symptom).class).not.toBe('urgent_symptoms');
    }
  });

  it('an emergency happening now still gets the 911 template first', () => {
    expect(classifySafety("I'm on Ozempic and my throat is closing").class).toBe('emergency');
    expect(classifySafety('Wegovy and I am about to pass out').class).toBe('emergency');
  });

  it('ordinary medicine mentions keep the medical hint, and the new names get it too', () => {
    for (const msg of [
      "I'm on Wegovy, what should I eat for lunch?",
      'Ozempic makes me a bit nauseous, any easy dinners?',
      'Can Mounjaro cause low blood sugar?',
      'I am worried about low blood sugar on Ozempic',
      'I just started Zepbound, how much protein do I need?',
      'Is Saxenda ok with my training plan?',
      'I take Rybelsus every morning, when should I train?',
      'Does a GLP-1 change how I should lift?',
      'I have a knot in my neck from deadlifts and I am on Mounjaro',
      "I'm on Wegovy and my stomach fat won't go away",
    ]) {
      expect({ msg, cls: classifySafety(msg).class }).toEqual({ msg, cls: 'medical_scope' });
    }
  });

  it('the template is the approved wording, word for word', () => {
    expect(ROMAN_SAFETY_TEMPLATES.urgent_symptoms).toBe(REPLY);
  });

  it('a reply that changes a newly listed medicine is a medication directive', () => {
    const r = postCheckRomanReply('You could pause your Zepbound this week and message your coach.', {
      routerClass: 'medical_scope',
      context: null,
      exclamationAllowed: false,
    });
    expect(r.guardrails_applied).toContain('medication_directive');
  });
});

// ─── the live turn: fixed reply, no model call, coach alert ──────────────────

const MESSAGE = "I'm on Zepbound and I can't keep any water down";
const SESSION = {
  id: 'sess_1',
  user_id: 'client-1',
  surface: 'client' as const,
  day_key: '2026-10-10',
  message_count: 1,
  started_at: new Date(),
  last_activity_at: new Date(),
  quips_in_session: 0,
  exclamation_used: false,
  subject_context_json: null,
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};
const CLIENT = { id: 'client-1', role: 'student' };

function harness(coachId: string | null, createAlert: jest.Mock = jest.fn(async () => ({}))) {
  const messages: Array<Record<string, unknown>> = [];
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `msg_${messages.length + 1}`, created_at: new Date(), ...data };
      messages.push(row);
      return row;
    }),
  };
  const romanSession = { updateMany: jest.fn(async () => ({ count: 1 })) };
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ coach_id: coachId })) },
    romanMessage,
    romanSession,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ romanMessage, romanSession }),
    ),
  };
  const stream = jest.fn();
  const audit = { write: jest.fn(async (_input: Record<string, unknown>) => undefined) };
  const alerts = { createAlert };
  const svc = new RomanService(
    fakeOf<PrismaService>(prisma),
    grantAllEgress(),
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>({ messages: { stream } })),
    null,
    fakeOf<AuditService>(audit),
    null,
    null,
    null,
    fakeOf<CoachAlertsService>(alerts),
  );
  return { svc, stream, audit, alerts, messages };
}

async function drain(gen: AsyncGenerator<unknown>) {
  const out: Array<{ type: string; text?: string }> = [];
  for await (const c of gen) out.push(c as { type: string; text?: string });
  return out;
}

describe('urgent_symptoms on the live turn', () => {
  it('replies with the fixed text, never calls the model, and alerts the coach without symptom text', async () => {
    const h = harness('coach-1');
    const chunks = await drain(h.svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: MESSAGE }));

    expect(h.stream).not.toHaveBeenCalled();
    expect(chunks.map((c) => [c.type, c.text])).toEqual([
      ['delta', REPLY],
      ['done', REPLY],
    ]);
    expect(h.messages).toEqual([
      expect.objectContaining({ role: 'roman', content: REPLY, model_id: ROMAN_SAFETY_ROUTER_MODEL_ID }),
    ]);
    expect(h.audit.write.mock.calls[0][0]).toMatchObject({
      action: 'roman.safety_route',
      metadata: { route_reason: 'contact_clinic' },
    });
    expect(h.alerts.createAlert).toHaveBeenCalledTimes(1);
    expect(h.alerts.createAlert).toHaveBeenCalledWith({
      coachId: 'coach-1',
      clientId: 'client-1',
      alertType: 'roman_urgent_reply',
      severity: 'critical',
      message: ROMAN_URGENT_COACH_ALERT,
    });
    expect(JSON.stringify(h.alerts.createAlert.mock.calls)).not.toMatch(/zepbound|water|keep/i);
  });

  it('a coachless client gets the reply only', async () => {
    const h = harness(null);
    const chunks = await drain(h.svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: MESSAGE }));
    expect(chunks[0].text).toBe(REPLY);
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
  });

  it('a failed alert never blocks the reply', async () => {
    const h = harness('coach-1', jest.fn().mockRejectedValue(new Error('db down')));
    const chunks = await drain(h.svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: MESSAGE }));
    expect(chunks[1]).toMatchObject({ type: 'done', text: REPLY });
  });

  it('the 911 and 988 templates still alert no one', async () => {
    const h = harness('coach-1');
    await drain(h.svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: 'I have chest pain right now' }));
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it('the controller treats it as a fixed reply, so no limit, consent or coach check stands in the way', () => {
    const { svc } = harness(null);
    expect(svc.isSafetyShortCircuit(MESSAGE)).toBe(true);
    expect(svc.isSafetyShortCircuit("I'm on Wegovy, what should I eat for lunch?")).toBe(false);
  });

  it('the production module graph gives RomanService the real CoachAlertsService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const roman = moduleRef.get(RomanService, { strict: false });
    expect(Reflect.get(roman, 'coachAlerts')).toBeInstanceOf(CoachAlertsService);
    await moduleRef.close();
  }, 60000);
});
