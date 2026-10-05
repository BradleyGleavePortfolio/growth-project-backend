import { Logger } from '@nestjs/common';
import Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { DunningV2Dispatcher, DispatchContext } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// Exact D1 source, real notification service/emitter/dispatcher; only Expo is stubbed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
function ctx(late = false): DispatchContext {
  return {
    dunningStateId: 'ds-synthetic', cycleKey: 'synthetic-cycle', stepIndex: 3,
    isLateReversalCycle: late, clientUserId: 'client-synthetic', coachUserId: 'coach-synthetic',
    clientEmail: 'client@tgp.invalid', coachEmail: 'coach@tgp.invalid',
    tokens: { firstName: 'Synthetic', clientName: 'Synthetic Client', coachName: 'Synthetic Coach',
      amount: '$150.00', lockoutDate: 'October 14' },
    dunningDetailDeeplink: 'tgp://coach/clients/client-synthetic',
  };
}
function telemetry() {
  return { attemptFailed: jest.fn(), notifySent: jest.fn(), blockerShown: jest.fn(),
    coachNotified: jest.fn() };
}
function transportFixture(ticketError: boolean) {
  const fake = new FakePrisma();
  fake.seed('user', { id: 'coach-synthetic', expo_push_token: 'ExponentPushToken[synthetic]' });
  const notifications = new NotificationsService(fake.client());
  const expo = Reflect.get(notifications, 'expo');
  jest.spyOn(expo, 'chunkPushNotifications').mockImplementation((messages) => [messages]);
  jest.spyOn(expo, 'sendPushNotificationsAsync').mockResolvedValue(
    ticketError ? [{ status: 'error', message: 'Synthetic rejection', details: { error: 'MessageTooBig' } }]
      : [{ status: 'ok', id: 'synthetic-ticket' }],
  );
  jest.spyOn(expo, 'chunkPushNotificationReceiptIds').mockReturnValue([]);
  const t = telemetry();
  const d = new DunningV2Dispatcher(new DunningEscalationClassifier(), new DunningV2Renderer(),
    stub(t), notifications, undefined, new CoachAlertEmitter(notifications));
  return { fake, d, t, expo };
}
describe('AUD-SOL-D12-118 D1 transport and copy acceptance', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('control: an accepted coach Expo ticket produces a sent push receipt', async () => {
    const { d, expo } = transportFixture(false);
    const out = await d.dispatchStepDetailed(ctx(), undefined, { channels: ['coach_push'] });
    expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(out.results.coach_push?.status).toBe('sent');
  });
  it('a rejected coach Expo ticket must remain retryable, not sent', async () => {
    const { d, expo, t } = transportFixture(true);
    const out = await d.dispatchStepDetailed(ctx(), undefined, { channels: ['coach_push'] });
    expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(out.results.coach_push?.status).toBe('failed');
    expect(t.notifySent).not.toHaveBeenCalled();
  });
  it('a dispute email must not promise that saving a card pays the debt and preserves access', async () => {
    const email = { send: jest.fn(async () => ({ status: 'sent' })) };
    const d = new DunningV2Dispatcher(new DunningEscalationClassifier(), new DunningV2Renderer(),
      stub(telemetry()), undefined, stub(email));
    await d.dispatchStepDetailed(ctx(true), undefined, { channels: ['client_email'] });
    expect(email.send).toHaveBeenCalledTimes(1);
    const request = stub(email.send.mock.calls[0])[0];
    const template = readFileSync(join(__dirname, '..', 'src/email/templates/dunning-v2-client.hbs'), 'utf8');
    const html = Handlebars.compile(template)(request.data);
    // R-DISPUTE-PAUSE (B-DUNSPLIT-119) supersedes the card button on a dispute: billing is paused.
    expect(html).not.toContain('Update card in the app');
    expect(html).toContain('Access has ended and billing for the plan is paused');
    expect(html).not.toContain('the amount owed is paid with it and your access stays on');
  });
});
