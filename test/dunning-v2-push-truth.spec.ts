import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import {
  DispatchContext,
  DunningV2Dispatcher,
} from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import type { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { PushDeliveryResult } from '../src/notifications/push-delivery.types';
import { partialDouble } from './support/typed-double';

/**
 * MONEY-DUNNING-COPY-130 (AUD-FIN-MONEY-129 B-2 and U-3).
 *
 * B-2: the Day 0, 1 and 3 failed-payment pushes promised a retry ("I will try
 * again tomorrow. You need do nothing") and reported attempts ("I attempted it
 * again today", "Three attempts"). Stripe does not run a retry for a hard
 * decline (lost or stolen card, wrong number, 3-D Secure) until a new card
 * exists, so that client waited for charges that never came and was locked
 * out on Day 10. The pushes also spoke as an unnamed "I" under the title
 * "Payment". Both variants are checked: the dry one goes to about 1 in 8.
 *
 * U-3: the push carried no data, so a tap opened nothing.
 */

const TOKENS = {
  firstName: 'Avery',
  coachName: 'Morgan Coach',
  clientName: 'Avery Lane',
  amount: '$120.00',
  cardLast4: '4242',
  lockoutDate: 'Saturday, October 17',
};

const renderer = new DunningV2Renderer();

// A retry is Stripe's to run, and Stripe does not run it for a hard decline.
const RETRY_CLAIM = /try again|tried|attempt|another word|three times|tomorrow|do nothing|need do/i;
// The push title is "Payment", not Roman's chat: no first person at all.
const FIRST_PERSON = /\b(I|me|my|mine|we|our|ours|us)\b/i;

describe('B-2: the Day 0/1/3 failed-payment pushes are true for every decline', () => {
  describe.each(['day0', 'day1', 'day3'])('%s', (copyKey) => {
    it.each([
      ['straight', false],
      ['dry', true],
    ])('%s variant: no retry claim, no first person, says how to settle it', (_variant, quip) => {
      const text = renderer.clientPush(copyKey, TOKENS, quip);
      expect(text).not.toMatch(RETRY_CLAIM);
      expect(text).not.toMatch(FIRST_PERSON);
      // The one thing that settles every decline: a card update in the app.
      expect(text).toMatch(/card/i);
      expect(text).toMatch(/in the app/);
      expect(text).not.toMatch(/[{}!]/);
    });
  });
});

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    dunningStateId: 'ds_1',
    cycleKey: '1791331200000',
    stepIndex: 0,
    isLateReversalCycle: false,
    clientUserId: 'client_1',
    coachUserId: 'coach_1',
    clientEmail: null,
    coachEmail: null,
    tokens: TOKENS,
    dunningDetailDeeplink: 'tgp://coach/clients/client_1',
    ...over,
  };
}

function pushWorld() {
  const pushToUser = jest.fn(
    async (..._args: Parameters<NotificationsService['pushToUser']>): Promise<PushDeliveryResult> => ({
      delivered: true,
      code: 'delivered',
    }),
  );
  const notifications = partialDouble<NotificationsService>({ pushToUser });
  const telemetry = partialDouble<DunningV2Telemetry>({
    attemptFailed: jest.fn(),
    notifySent: jest.fn(),
    blockerShown: jest.fn(),
  });
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    renderer,
    telemetry,
    notifications,
  );
  return { dispatcher, pushToUser };
}

describe('U-3: a failed-payment push opens the in-app card update', () => {
  it.each([0, 1, 2, 3])(
    'payment cycle step %i: the push carries { kind, actionScreen: UpdateCard }',
    async (stepIndex) => {
      const { dispatcher, pushToUser } = pushWorld();
      const out = await dispatcher.dispatchStepDetailed(ctx({ stepIndex }), undefined, {
        channels: ['client_push'],
      });
      expect(out.results.client_push).toEqual({ status: 'sent' });
      expect(pushToUser).toHaveBeenCalledTimes(1);
      const [userId, title, , data] = pushToUser.mock.calls[0];
      expect(userId).toBe('client_1');
      expect(title).toBe('Payment');
      expect(data).toEqual({ kind: 'dunning_payment', actionScreen: 'UpdateCard' });
    },
  );

  it('a dispute-cycle push carries no card route: a card update does not end a dispute', async () => {
    const { dispatcher, pushToUser } = pushWorld();
    await dispatcher.dispatchStepDetailed(
      ctx({ stepIndex: 2, isLateReversalCycle: true }),
      undefined,
      { channels: ['client_push'] },
    );
    expect(pushToUser).toHaveBeenCalledTimes(1);
    expect(pushToUser.mock.calls[0][3]).toBeUndefined();
  });
});
