// test/roman/roman-urgent-symptoms.spec.ts
//
// A red-flag symptom on a GLP-1 or other weight-loss medicine gets the fixed
// reply (no model call) and the client's coach gets the existing coach alert.
// Symptom groups follow the FDA label warnings and Medication Guides
// (pancreatitis, gallbladder, dehydration, allergic reaction, fainting, low
// blood sugar, thyroid). No network, no DB.

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { RomanSession } from '@prisma/client';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import type { CoachAlertEmitter } from '../../src/notifications/emitters/coach-alert.emitter';
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
  ...'Ozempic Wegovy Rybelsus semaglutide Mounjaro Zepbound tirzepatide Victoza Saxenda'.split(' '),
  ...'liraglutide Trulicity Byetta Bydureon exenatide retatrutide Monjaro Ozempik Wegovey'.split(' '),
  ...['GLP-1', 'a GLP1', 'a weight loss shot', 'a fat jab'],
];

const SYMPTOMS: Record<string, string[]> = {
  'severe or lasting stomach pain': [
    'I have severe stomach pain',
    'I have severe stomach pains',
    'I have the worst stomach pain of my life',
    'there is a terrible pain in my upper stomach',
    "my stomach pain won't go away",
    'my belly hurts and it goes through to my back',
    'I have had abdominal pain for 3 days',
    'the pain in my stomach is severe',
    'my abdomen hurts really badly',
    'my stomach is killing me',
    // B-913-1 (R1): everyday wording.
    'my stomach has hurt for two days',
    'my stomach has been hurting for 3 days',
    "my stomach won't stop hurting",
    'I have a really bad stomachache',
    'I have had a terrible stomachache all day',
    'my tummy ache is awful',
    'I have sharp pains in my stomach',
    'my stomach pain is getting worse',
    'my stomach is hurting really badly',
    'my stomach has been hurting severely',
  ],
  'pancreatitis or gallbladder trouble': [
    'I think I have pancreatitis',
    'I have signs of gallbladder trouble',
    'I think I have gallstones',
    'my gallbladder hurts',
    'my gallbladder is hurting',
    'there is pain where my gallbladder is',
    "I think it's my gallbladder",
  ],
  'vomiting that will not stop, or severe dehydration': [
    "I can't keep any water down",
    "I can't even keep water down",
    'I cannot keep anything down since yesterday',
    'I keep throwing up',
    "I've been vomiting and it won't stop",
    "I'm puking constantly",
    "I've thrown up 6 times today",
    'I threw up all night',
    'I am severely dehydrated',
    "I haven't been able to drink anything in 2 days",
    "I can't keep down water",
    "I can't keep food or water down",
  ],
  'yellow skin or eyes': ['my eyes look yellow', 'I noticed yellowing of my skin', 'I am jaundiced'],
  'a serious allergic reaction': [
    'my face is swollen',
    'my lips swelled up after the dose',
    'I broke out in hives',
    'I have trouble swallowing',
  ],
  fainting: ['I fainted this morning', 'I passed out after my dose', 'I blacked out in the shower'],
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

  it('a denied symptom, a risk question or a coaching message is not a report', () => {
    for (const msg of [
      "I'm on Wegovy, what should I eat for lunch?",
      'Ozempic makes me a bit nauseous, any easy dinners?',
      'Mounjaro gives me mild stomach cramps',
      'I threw up once after my Wegovy shot',
      "I'm on Wegovy and my stomach fat won't go away",
      'I have a knot in my neck from deadlifts and I am on Mounjaro',
      "I'm on Wegovy and losing muscle mass, how do I train my neck and traps?",
      'On Mounjaro, my knees collapsed inward on my squats',
      'On Wegovy and my motivation collapsed',
      'On Zepbound I passed out at 9pm last night, slept great',
      'On Ozempic my hands are shaky on bench and I am confused about grip',
      'I had hives as a kid, can I take Ozempic?',
      "On Wegovy I can't keep food intake down below 2000",
      'Should I worry about getting low blood sugar on Ozempic?',
      'Can Mounjaro cause low blood sugar?',
      'Can Ozempic cause pancreatitis?',
      "I'm on Wegovy and have no severe stomach pain; what should I eat for lunch?",
      'I take Wegovy. I have not fainted and feel fine. What should I eat?',
      "I'm on Wegovy and my skin isn't yellow. How much protein should I eat?",
      "I'm on Ozempic and I don't have any severe stomach pain",
      "I'm on Ozempic, no vomiting at all",
      "I'm on Wegovy and my coach says to watch for severe stomach pain. I feel fine.",
      "I don't take Ozempic. I have a swollen neck from an old gym injury.",
    ]) {
      expect({ msg, cls: classifySafety(msg).class }).not.toEqual({ msg, cls: 'urgent_symptoms' });
    }
    expect(classifySafety("I'm on Wegovy. No vomiting, but severe stomach pain").class).toBe(
      'urgent_symptoms',
    );
  });

  it('plain medicine mentions route exactly as before', () => {
    expect(classifySafety("I'm on Wegovy, what should I eat for lunch?").class).toBe('medical_scope');
    expect(classifySafety('I just started Zepbound, how much protein do I need?').class).toBe('normal');
    expect(classifySafety('What do you think about GLP-1s?').class).toBe('normal');
  });

  it('a medicine named in an earlier turn counts; an earlier symptom does not', () => {
    const earlier = 'I started Wegovy two weeks ago';
    expect(classifySafety("I can't keep any water down", earlier).class).toBe('urgent_symptoms');
    expect(classifySafety("I can't keep any water down", "I don't take Wegovy").class).not.toBe(
      'urgent_symptoms',
    );
    expect(classifySafety('What should I eat for lunch?', `${earlier}. I keep throwing up`).class).toBe(
      'normal',
    );
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

  it('B-913-2 (R1): "my shot / jab / injection / pen" counts as the medicine for this route', () => {
    for (const msg of [
      "since my shot I can't keep anything down",
      'after my injection I keep throwing up',
      'since my weekly injection I keep throwing up',
      'my weekly shot made me throw up all night',
      "I'm on the shot and I fainted",
      'my jab day and now my stomach is killing me',
      "I took my pen this morning and I can't keep water down",
    ]) {
      expect({ msg, cls: classifySafety(msg).class }).toEqual({ msg, cls: 'urgent_symptoms' });
    }
    expect(classifySafety('my flu shot made my arm sore').class).not.toBe('urgent_symptoms');
    expect(classifySafety("I can't keep water down", 'I had my shot on Monday').class).toBe(
      'urgent_symptoms',
    );
  });

  it('B-913-3 (R1): a question or a past event is not a report; a report inside a question is', () => {
    for (const msg of [
      "I'm on Ozempic, what are the symptoms of pancreatitis",
      "I'm on Ozempic, how do I know if I have pancreatitis",
      "I'm on Ozempic, what does pancreatitis feel like?",
      'Is pancreatitis common on Mounjaro?',
      "I'm on Wegovy, is gallbladder pain a side effect?",
      'On Mounjaro, any tips to avoid gallstones?',
      'I had gallstones years ago, is it ok to take Mounjaro?',
      "I'm on Wegovy, what should I do if I can't keep water down?",
      "I'm on Wegovy. If I keep throwing up should I call my doctor?",
      "I'm on Zepbound and I want to know what to do if I get severe stomach pain",
    ]) {
      expect({ msg, cls: classifySafety(msg).class }).not.toEqual({ msg, cls: 'urgent_symptoms' });
    }
    for (const msg of [
      "I'm on Wegovy and I can't keep water down, what should I do?",
      'On Mounjaro, is it normal that I cannot keep water down?',
      "I'm on Ozempic and I think I have pancreatitis, what now?",
      'On Wegovy, why is my stomach pain so bad?',
    ]) {
      expect({ msg, cls: classifySafety(msg).class }).toEqual({ msg, cls: 'urgent_symptoms' });
    }
  });
});

// ─── the live turn: fixed reply, no model call, coach alert ──────────────────

const MESSAGE = "I'm on Zepbound and I can't keep any water down";
const SESSION = fakeOf<RomanSession>({ id: 'sess_1', user_id: 'client-1', surface: 'client' });
const CLIENT = { id: 'client-1', role: 'student' };

function harness(
  coachId: string | null,
  createAlert: jest.Mock = jest.fn(async () => ({})),
  earlierTurns: string[] = [],
) {
  const messages: Array<Record<string, unknown>> = [];
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `msg_${messages.length + 1}`, created_at: new Date(), ...data };
      messages.push(row);
      return row;
    }),
    findMany: jest.fn(async (_args: unknown) => earlierTurns.map((content) => ({ content }))),
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
  return { svc, stream, audit, alerts, messages, findMany: romanMessage.findMany };
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

  it('the controller treats it as a fixed reply, so no limit, consent or coach check stands in the way', async () => {
    const { svc } = harness(null);
    await expect(svc.isSafetyShortCircuit(CLIENT, SESSION.id, MESSAGE)).resolves.toBe(true);
    const lunch = "I'm on Wegovy, what should I eat for lunch?";
    await expect(svc.isSafetyShortCircuit(CLIENT, SESSION.id, lunch)).resolves.toBe(false);
  });

  it('a medicine named in an earlier turn: the next red flag gets the fixed reply and the alert', async () => {
    const h = harness('coach-1', undefined, ['I started Wegovy two weeks ago']);
    const symptom = "I can't keep any water down";
    await expect(h.svc.isSafetyShortCircuit(CLIENT, SESSION.id, symptom)).resolves.toBe(true);
    const chunks = await drain(h.svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: symptom }));
    expect(chunks[1]).toMatchObject({ type: 'done', text: REPLY });
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.alerts.createAlert).toHaveBeenCalledTimes(1);
    expect(h.findMany.mock.calls[0][0]).toMatchObject({
      where: { session_id: SESSION.id, user_id: CLIENT.id, role: 'user' },
    });
  });

  it('B-913-2 (R1, L-913-SOL probe): storing the turn keeps the urgent pre-check decision', async () => {
    // Newest first: the medicine was named five turns back.
    const rows = [
      'Thanks, that helps',
      'Could I swap chicken for tofu?',
      'What should I eat for dinner?',
      'How much protein should I aim for?',
      'I started Wegovy two weeks ago',
    ].map((content) => ({ role: 'user', content }));
    const h = harness('coach-1');
    h.findMany.mockImplementation(async (args: unknown) =>
      rows.slice(0, (args as { take: number }).take),
    );
    const symptom = "I can't keep any water down";
    await expect(h.svc.isSafetyShortCircuit(CLIENT, SESSION.id, symptom)).resolves.toBe(true);
    rows.unshift({ role: 'user', content: symptom }); // the controller stores the turn
    const chunks = await drain(h.svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: symptom }));
    expect(chunks[0]).toMatchObject({ type: 'delta', text: REPLY });
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.alerts.createAlert).toHaveBeenCalledTimes(1);
  });

  it('the production module graph gives RomanService the real CoachAlertsService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const roman = moduleRef.get(RomanService, { strict: false });
    expect(Reflect.get(roman, 'coachAlerts')).toBeInstanceOf(CoachAlertsService);
    await moduleRef.close();
  }, 60000);
});

describe('the coach alert for an urgent reply', () => {
  it('each urgent reply is its own alert: an earlier unacknowledged one never hides it', async () => {
    const earlier = { id: 'alert_0', acknowledged_at: null, created_at: new Date() };
    const prisma = {
      coachAlert: {
        findFirst: jest.fn(async () => earlier),
        create: jest.fn(async ({ data }: { data: object }) => ({ id: 'alert_new', ...data })),
      },
    };
    const emit = jest.fn(async () => ({ push: 'sent' }));
    const alerts = new CoachAlertsService(
      fakeOf<PrismaService>(prisma),
      fakeOf<CoachAlertEmitter>({ emit }),
    );
    const input = {
      coachId: 'coach-1',
      clientId: 'client-1',
      alertType: 'roman_urgent_reply' as const,
      message: ROMAN_URGENT_COACH_ALERT,
    };
    await alerts.createAlert(input);
    await alerts.createAlert(input);
    expect(prisma.coachAlert.create).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(2);
    await expect(alerts.createAlert({ ...input, alertType: 'streak_dropped' })).resolves.toBe(earlier);
  });
});
