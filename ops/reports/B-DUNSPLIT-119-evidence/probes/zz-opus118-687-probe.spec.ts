/**
 * AUD-OPUS-D12-118 probe on backend #687 @ f8e47bf4 (audit only, never merge).
 *
 * Copy truth of the new client dunning email (src/email/templates/
 * dunning-v2-client.hbs:9). The dispatcher sends this template with
 * `update_card_url` for EVERY client email step, including the late-reversal
 * (dispute) cycle steps 2 and 3. The template then says "Once the new card is
 * saved, the amount owed is paid with it and your access stays on." In a
 * dispute cycle no invoice is open and a card update does not end the cycle
 * (DunningV2Service.applyImmediateClear refuses `card_update` on the dispute
 * marker; the Day-10 lock still lands), so the sentence is false there.
 * "probe" cases are expected to FAIL at this head; controls to PASS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Handlebars from 'handlebars';
import { DispatchContext, DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const TEMPLATE = Handlebars.compile(
  readFileSync(join(__dirname, '..', 'src', 'email', 'templates', 'dunning-v2-client.hbs'), 'utf8'),
);

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    dunningStateId: 'ds-1',
    cycleKey: '1790000000000',
    stepIndex: 2,
    isLateReversalCycle: true,
    clientUserId: 'client-a',
    coachUserId: 'coach-a',
    clientEmail: 'client@tgp.invalid',
    coachEmail: 'coach@tgp.invalid',
    tokens: {
      firstName: 'Avery',
      clientName: 'Avery Client',
      coachName: 'Morgan Coach',
      amount: '$150.00',
      lockoutDate: 'October 14',
    },
    dunningDetailDeeplink: 'tgp://coach/clients/client-a',
    ...over,
  };
}

async function renderedClientEmail(c: DispatchContext): Promise<{ text: string; subject: string }> {
  const sent: Array<{ template: string; data: Record<string, unknown> }> = [];
  const email = {
    send: jest.fn(async (m: { template: string; data: Record<string, unknown> }) => {
      sent.push(m);
      return { status: 'sent' };
    }),
  };
  const notifications = {
    pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
    createNotification: jest.fn(async () => ({ id: 'n1' })),
    pushToCoach: jest.fn(async () => true),
  };
  const telemetry = {
    attemptFailed: jest.fn(),
    notifySent: jest.fn(),
    blockerShown: jest.fn(),
    coachNotified: jest.fn(),
  };
  const d = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    stub(telemetry),
    stub(notifications),
    stub(email),
  );
  const { results } = await d.dispatchStepDetailed(c, undefined, { channels: ['client_email'] });
  expect(results.client_email?.status).toBe('sent');
  expect(sent).toHaveLength(1);
  const html = TEMPLATE(sent[0].data);
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return { text, subject: String(sent[0].data.subject ?? '') };
}

describe('AUD-OPUS-D12-118 probe #687: client dunning email copy truth', () => {
  it('control: a payment-cycle Day-7 email carries the card-update sentence', async () => {
    const { text } = await renderedClientEmail(ctx({ stepIndex: 3, isLateReversalCycle: false }));
    expect(text).toContain('Update card in the app');
    expect(text).toContain('your access stays on');
  });

  it.each([2, 3])(
    'probe: a dispute-cycle (late reversal) step %i email does not promise that a card update pays it and keeps access',
    async (stepIndex) => {
      const { text, subject } = await renderedClientEmail(ctx({ stepIndex }));
      expect(subject).toBe('Your recent payment was reversed');
      expect(text).not.toContain('the amount owed is paid with it');
      expect(text).not.toContain('your access stays on');
    },
  );
});
