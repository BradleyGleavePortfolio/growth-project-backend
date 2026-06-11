import { DunningV2Dispatcher } from '../../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../../src/checkout/dunning-v2/dunning-v2.renderer';
import { VoicePolicyService } from '../../src/roman/voice/voice-policy.service';
import {
  LEGACY,
  ROMAN_V2,
} from '../../src/roman/voice/voice-policy.constants';
import { FEATURE_DUNNING_V2_ENV } from '../../src/checkout/dunning-v2/dunning-v2.feature';
import { FEATURE_ROMAN_COPY_V2_ENV } from '../../src/roman/voice/voice-policy.feature';

/**
 * Roman Phase 2 — integration: the dunning dispatcher's in-app client push for
 * Day 0/1/3/7 routes through VoicePolicyService.
 *
 *   - FEATURE_ROMAN_COPY_V2 OFF → the pushed body is the LEGACY (pre-PR)
 *     string (token-substituted). [byte-for-byte unchanged behaviour]
 *   - FEATURE_ROMAN_COPY_V2 ON  → the pushed body is the ROMAN_V2 string.
 *
 * The dispatcher is built with a thin fake NotificationsService that captures
 * the body so we can assert the exact string for each flag state.
 */

class TelemetryStub {
  attemptFailed(): void {}
  notifySent(): void {}
  blockerShown(): void {}
}

interface CapturedPush {
  userId: string;
  title: string;
  body: string;
}

class FakeNotifications {
  pushes: CapturedPush[] = [];
  async pushToUser(userId: string, title: string, body: string): Promise<void> {
    this.pushes.push({ userId, title, body });
  }
  async createNotification(): Promise<void> {}
  async pushToCoach(): Promise<void> {}
}

function buildDispatcher(notifications: FakeNotifications) {
  const classifier = new DunningEscalationClassifier();
  const renderer = new DunningV2Renderer();
  const telemetry = new TelemetryStub();
  const voice = new VoicePolicyService();
  return new DunningV2Dispatcher(
    classifier,
    renderer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    telemetry as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notifications as any,
    undefined,
    undefined,
    voice,
  );
}

const DAY0_CTX = {
  dunningStateId: 'ds_1',
  stepIndex: 0,
  isLateReversalCycle: false,
  clientUserId: 'user_1',
  coachUserId: 'coach_1',
  clientEmail: null,
  coachEmail: null,
  tokens: { firstName: 'Sam', amount: '$49' },
  dunningDetailDeeplink: 'tgp://dunning/ds_1',
};

describe('Dunning dispatcher → VoicePolicyService (Phase 2 in-app copy)', () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    prev[FEATURE_DUNNING_V2_ENV] = process.env[FEATURE_DUNNING_V2_ENV];
    prev[FEATURE_ROMAN_COPY_V2_ENV] = process.env[FEATURE_ROMAN_COPY_V2_ENV];
    process.env[FEATURE_DUNNING_V2_ENV] = 'true';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('flag OFF → Day 0 push body is the legacy string (token-substituted)', async () => {
    delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
    const notifications = new FakeNotifications();
    const dispatcher = buildDispatcher(notifications);
    await dispatcher.dispatchStep(DAY0_CTX);
    expect(notifications.pushes).toHaveLength(1);
    const expected = LEGACY.dunning_day0.replace('{firstName}', 'Sam');
    expect(notifications.pushes[0].body).toBe(expected);
  });

  it('flag ON → Day 0 push body is the Roman variant (token-substituted)', async () => {
    process.env[FEATURE_ROMAN_COPY_V2_ENV] = 'true';
    const notifications = new FakeNotifications();
    const dispatcher = buildDispatcher(notifications);
    await dispatcher.dispatchStep(DAY0_CTX);
    expect(notifications.pushes).toHaveLength(1);
    const expected = ROMAN_V2.dunning_day0.replace('{firstName}', 'Sam');
    expect(notifications.pushes[0].body).toBe(expected);
  });

  it('flag ON → Day 1 push body is the Roman variant', async () => {
    process.env[FEATURE_ROMAN_COPY_V2_ENV] = 'true';
    const notifications = new FakeNotifications();
    const dispatcher = buildDispatcher(notifications);
    await dispatcher.dispatchStep({ ...DAY0_CTX, stepIndex: 1 });
    const expected = ROMAN_V2.dunning_day1.replace('{firstName}', 'Sam');
    expect(notifications.pushes[0].body).toBe(expected);
  });
});
