/**
 * AUD-OPUS-L3-121 (lens Claude Opus 5.5, agent 121) probes for mobile #353 @ 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85.
 * Run at #354 68c7f080 (#354 adds only nativeCardUpdate.test.tsx on top of #353). Never merge.
 * PROBE  = asserts the correct behaviour; expected to FAIL at this head (it proves a finding).
 * VERIFY = checks a fixed B (B-353-2 / B-353-3 / B-353-6 / B-353-7); must PASS.
 * Owner ruling 6 (09:43 PDT 10-05): a dispute INQUIRY also pauses the plan; inquiries move no money
 * (https://docs.stripe.com/disputes/withdrawing), so copy shown for `kind: 'dispute'` must be true for both.
 */
import React from 'react';
import { Alert, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { ClientDunningStatus } from '../dunningApi';
import { bannerCopy } from '../DunningBanner';
import { DunningLockoutScreen, endPlanAlertBody, lockoutNextStep, lockoutSummary } from '../DunningLockoutScreen';
import { updateCardIntro } from '../UpdateCardScreen';
import { dunningLockoutStore } from '../dunningLockoutStore';

jest.mock('../../../theme/ThemeProvider', () => {
  const realTokens = jest.requireActual('../../../theme/tokens').default;
  return {
    useTheme: () => ({ semanticColors: realTokens.lightTokens, tokens: realTokens, colorScheme: 'light' }),
  };
});
jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../../services/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));

const FIRST_PERSON = /\b(we|we're|we've|we'll|us|our|ours)\b/i;
const MONEY_MOVED = /\b(revers\w*|took back|taken back|refund\w*|charged back|chargeback)\b/i;
const FORBIDDEN = /settle|sort it out/i;
const NOW = Date.parse('2026-10-05T19:00:00.000Z');

const LOCKED: ClientDunningStatus = {
  enabled: true,
  state: 'locked',
  kind: 'payment',
  reason: 'payment_failed',
  lock_waived: false,
  purchase_id: 'p1',
  amount_cents: 15000,
  currency: 'usd',
  failed_at: '2026-09-25T15:00:00.000Z',
  lockout_at: '2026-10-05T15:00:00.000Z',
  locked_at: '2026-10-05T15:07:00.000Z',
  day: 10,
  coach_name: 'Avery',
  card_last4: '4242',
  card_brand: 'visa',
} as ClientDunningStatus;
/** Backend D2c getClientStatus for a dispute or inquiry pause: locked, kind dispute, reason dispute_paused, no amount. */
const D2C_LOCKED: ClientDunningStatus = {
  ...LOCKED,
  kind: 'dispute',
  reason: 'dispute_paused',
  amount_cents: null,
  lockout_at: null,
  day: null,
  card_last4: null,
  card_brand: null,
} as ClientDunningStatus;
/** Another live plan keeps access: past_due + lock_waived (banner, not the lockout). */
const D2C_WAIVED: ClientDunningStatus = { ...D2C_LOCKED, state: 'past_due', lock_waived: true } as ClientDunningStatus;
/** Surfaces that say what the bank did (the inquiry probe); SURFACES adds the rest for the copy-rule checks. */
const WHAT_SURFACES: Array<[string, () => string]> = [
  ['banner title + body', () => `${bannerCopy(D2C_WAIVED, NOW).title} ${bannerCopy(D2C_WAIVED, NOW).body}`],
  ['lockout summary', () => lockoutSummary(D2C_LOCKED)],
  ['Update card intro (locked)', () => updateCardIntro(D2C_LOCKED)],
  ['Update card intro (waived)', () => updateCardIntro(D2C_WAIVED)],
];
const SURFACES: Array<[string, () => string]> = [
  ['banner title + body', () => `${bannerCopy(D2C_WAIVED, NOW).title} ${bannerCopy(D2C_WAIVED, NOW).body}`],
  ['lockout summary', () => lockoutSummary(D2C_LOCKED)],
  ['lockout next step', () => lockoutNextStep(D2C_LOCKED)],
  ['Update card intro (locked)', () => updateCardIntro(D2C_LOCKED)],
  ['Update card intro (waived)', () => updateCardIntro(D2C_WAIVED)],
  ['End my plan dialog', () => endPlanAlertBody(D2C_LOCKED)],
];

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as { children?: unknown }).children ?? null);
}

function lockoutProps(status: ClientDunningStatus | null, over: Record<string, unknown> = {}) {
  return {
    status,
    loadError: null,
    refreshing: false,
    onRefresh: jest.fn(),
    onUpdateCard: jest.fn(),
    onEndPlan: jest.fn(async () => ({ ok: false as const, retired: true as const, error: null })),
    onMessageCoach: jest.fn(),
    onOpenDataExport: jest.fn(),
    onOpenDeleteAccount: jest.fn(),
    onSignOut: jest.fn(),
    supportReference: null,
    ...over,
  };
}

beforeEach(() => {
  dunningLockoutStore.__resetForTests();
  jest.restoreAllMocks();
});

describe('B-353-9 (Opus 121): every dispute surface is true for an inquiry (no claim that money moved)', () => {
  it('CONTROL: the failed-payment lockout copy is untouched', () => {
    expect(lockoutSummary(LOCKED)).toMatch(/has not gone through/);
  });

  it.each(WHAT_SURFACES)('PROBE: %s does not claim the bank reversed or took back a payment', (_name, text) => {
    expect(text()).not.toMatch(MONEY_MOVED);
  });
});

describe('VERIFY B-353-3 / B-353-6 / B-353-7: R-DISPUTE-PAUSE on every dispute surface', () => {
  it.each(SURFACES)('%s: no settle / sort it out, no first person, no "!"', (_name, text) => {
    const t = text();
    expect(t).not.toMatch(FORBIDDEN);
    expect(t).not.toMatch(FIRST_PERSON);
    expect(t).not.toContain('!');
  });

  it('banner, lockout summary and Update card intro state the three facts and no date', () => {
    for (const t of [bannerCopy(D2C_WAIVED, NOW).body, lockoutSummary(D2C_LOCKED), updateCardIntro(D2C_LOCKED)]) {
      expect(t).toMatch(/access has ended/i);
      expect(t).toMatch(/billing is paused/i);
      expect(t).toMatch(/Avery, decides whether to restart/);
      expect(t).not.toMatch(/Oct|unless|future payment/i);
    }
  });

  it('an older envelope (past_due dispute with a grace date) shows no lock date on the banner', () => {
    const legacy = { ...D2C_WAIVED, reason: null, lock_waived: false, lockout_at: '2026-10-11T15:00:00.000Z' } as ClientDunningStatus;
    expect(bannerCopy(legacy, NOW).body).not.toMatch(/Oct|Access pauses on/);
  });

  it('the rendered dispute lockout: title "Your access has ended", Message coach first, no Update card, no End my plan, no "Already paid"', async () => {
    const { toJSON, queryByTestId } = await render(<DunningLockoutScreen {...lockoutProps(D2C_LOCKED)} />);
    const text = textOf(toJSON());
    expect(text).toMatch(/Your access has ended/);
    expect(text).not.toMatch(/Already paid/);
    expect(queryByTestId('dunning-lockout-update-card')).toBeNull();
    expect(queryByTestId('dunning-lockout-end-plan')).toBeNull();
    expect(queryByTestId('dunning-lockout-message-coach')).not.toBeNull();
    expect(text).toMatch(/Message Avery to talk about restarting/);
  });

  it('CONTROL: the failed-payment lockout keeps Update card and End my plan', async () => {
    const { queryByTestId } = await render(<DunningLockoutScreen {...lockoutProps(LOCKED)} />);
    expect(queryByTestId('dunning-lockout-update-card')).not.toBeNull();
    expect(queryByTestId('dunning-lockout-end-plan')).not.toBeNull();
  });
});

describe('VERIFY B-353-2: the End my plan confirmation is owned from the moment it opens', () => {
  type AlertButton = { text?: string; onPress?: () => void };
  function captureAlert() {
    const calls: AlertButton[][] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      calls.push((buttons ?? []) as AlertButton[]);
    });
    return calls;
  }

  it('accepted after the lockout unmounted: no cancel is sent', async () => {
    const calls = captureAlert();
    const props = lockoutProps(LOCKED);
    const screen = await render(<DunningLockoutScreen {...props} />);
    await fireEvent.press(screen.getByTestId('dunning-lockout-end-plan'));
    expect(calls).toHaveLength(1);
    // unmount the lockout itself (RNTL 14: a manual root unmount breaks later renders in this file)
    await screen.rerender(<View />);
    expect(screen.queryByTestId('dunning-lockout-screen')).toBeNull();
    calls[0].find((b) => b.text === 'End my plan')?.onPress?.();
    expect(props.onEndPlan).not.toHaveBeenCalled();
  });

  it('accepted after the account changed (generation bump): no cancel is sent', async () => {
    const calls = captureAlert();
    const props = lockoutProps(LOCKED);
    const screen = await render(<DunningLockoutScreen {...props} />);
    await fireEvent.press(screen.getByTestId('dunning-lockout-end-plan'));
    expect(calls).toHaveLength(1);
    // the sign-out / sign-in identity boundary (authEvents 'logout' calls retire())
    dunningLockoutStore.retire();
    calls[0].find((b) => b.text === 'End my plan')?.onPress?.();
    expect(props.onEndPlan).not.toHaveBeenCalled();
  });

  it('the plan sent is the plan the confirmation showed, not one that loaded since', async () => {
    const calls = captureAlert();
    const props = lockoutProps(LOCKED);
    const screen = await render(<DunningLockoutScreen {...props} />);
    await fireEvent.press(screen.getByTestId('dunning-lockout-end-plan'));
    await screen.rerender(<DunningLockoutScreen {...props} status={{ ...LOCKED, purchase_id: 'p2' }} />);
    calls[0].find((b) => b.text === 'End my plan')?.onPress?.();
    expect(props.onEndPlan).toHaveBeenCalledTimes(1);
    const [, owner] = (props.onEndPlan as jest.Mock).mock.calls[0];
    expect(owner.purchaseId).toBe('p1');
  });
});
