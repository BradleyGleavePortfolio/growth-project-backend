/**
 * AUD-OPUS-L12-119 (lens Claude Opus 5.5, agent 119) probe for mobile #353 @ 05d84f27261f1f764214be5a379785ba8f690d3e.
 * Never merge. PROBE cases assert R-DISPUTE-PAUSE (owner 12:01 PDT 10-04): a dispute on a recurring plan pauses billing
 * and ends access at once (no lock date, no grace period), nothing restores automatically, the coach restarts access.
 * Dispute copy must say exactly: access has ended, billing is paused, the coach decides on restarting.
 * Expected to FAIL at this head. CONTROL cases must pass.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import type { ClientDunningStatus } from '../dunningApi';
import { bannerCopy } from '../DunningBanner';
import { DunningLockoutScreen, endPlanAlertBody, lockoutNextStep, lockoutSummary } from '../DunningLockoutScreen';
import { updateCardIntro } from '../UpdateCardScreen';

jest.mock('../../../theme/ThemeProvider', () => {
  const realTokens = jest.requireActual('../../../theme/tokens').default;
  return {
    useTheme: () => ({ semanticColors: realTokens.lightTokens, tokens: realTokens, colorScheme: 'light' }),
  };
});
jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../../services/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));

const NOW = Date.parse('2026-10-04T19:00:00.000Z');
const LOCKED: ClientDunningStatus = {
  enabled: true,
  state: 'locked',
  kind: 'payment',
  lock_waived: false,
  purchase_id: 'p1',
  amount_cents: 15000,
  currency: 'usd',
  failed_at: '2026-10-01T15:00:00.000Z',
  lockout_at: '2026-10-11T15:00:00.000Z',
  locked_at: '2026-10-11T15:07:00.000Z',
  day: 10,
  coach_name: 'Avery',
  card_last4: '4242',
  card_brand: 'visa',
} as ClientDunningStatus;
const DISPUTE_LOCKED: ClientDunningStatus = { ...LOCKED, kind: 'dispute' };
/** What today's #691 contract (old compressed dispute cycle) reports before the lock: past_due + a future lockout_at. */
const DISPUTE_PAST_DUE: ClientDunningStatus = { ...DISPUTE_LOCKED, state: 'past_due', locked_at: null, day: 1 } as ClientDunningStatus;
const PAYMENT_PAST_DUE: ClientDunningStatus = { ...LOCKED, state: 'past_due', locked_at: null, day: 3 } as ClientDunningStatus;

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as { children?: unknown }).children ?? null);
}

function lockoutProps(status: ClientDunningStatus | null) {
  return {
    status,
    loadError: null,
    refreshing: false,
    onRefresh: jest.fn(),
    onUpdateCard: jest.fn(),
    onEndPlan: jest.fn(),
    onMessageCoach: jest.fn(),
    onOpenDataExport: jest.fn(),
    onOpenDeleteAccount: jest.fn(),
    onSignOut: jest.fn(),
    supportReference: null,
  };
}

const COACH_RESTARTS = /coach[^.]*\b(restart|decides)/i;
const SUPPORT_SORTS_IT = /sort it out/i;

describe('B-353-6: a dispute never carries a lock date or a grace period (R-DISPUTE-PAUSE)', () => {
  it('CONTROL: a failed payment banner names its upcoming lock date', () => {
    expect(bannerCopy(PAYMENT_PAST_DUE, NOW).body).toMatch(/by Sunday, October 11/);
  });

  it('PROBE: the dispute banner names no lock date and no "unless it is sorted out" condition', () => {
    const body = bannerCopy(DISPUTE_PAST_DUE, NOW).body;
    expect(body).not.toMatch(/Access pauses on/);
    expect(body).not.toMatch(/unless/i);
    expect(body).not.toMatch(/Oct/);
  });

  it('PROBE: the dispute Update card intro (pre-lock) does not imply access continues', () => {
    expect(updateCardIntro(DISPUTE_PAST_DUE)).toMatch(/access[^.]*ended/i);
  });
});

describe('B-353-7: dispute copy says access has ended, billing is paused, the coach decides on restarting', () => {
  it('CONTROL: the failed-payment next step still names the card fix', () => {
    expect(lockoutNextStep(LOCKED)).toMatch(/Update card/);
  });

  it('PROBE: lockout summary + next step for a dispute state the ruling', () => {
    const text = `${lockoutSummary(DISPUTE_LOCKED)} ${lockoutNextStep(DISPUTE_LOCKED)}`;
    expect(text).toMatch(/access[^.]*ended/i);
    expect(text).toMatch(/billing[^.]*paused/i);
    expect(text).toMatch(COACH_RESTARTS);
    expect(text).not.toMatch(SUPPORT_SORTS_IT);
  });

  it('PROBE: the rendered dispute lockout invites no payment check ("Already paid? Pull down")', async () => {
    const { toJSON } = await render(<DunningLockoutScreen {...lockoutProps(DISPUTE_LOCKED)} />);
    expect(textOf(toJSON())).not.toMatch(/Already paid/);
  });

  it('PROBE: the dispute Update card intro names the coach restart rule, not a support fix', () => {
    const intro = updateCardIntro(DISPUTE_LOCKED);
    expect(intro).not.toMatch(SUPPORT_SORTS_IT);
    expect(intro).toMatch(COACH_RESTARTS);
  });

  it('PROBE: the dispute End my plan dialog names the coach restart rule, not a support fix', () => {
    const body = endPlanAlertBody(DISPUTE_LOCKED);
    expect(body).not.toMatch(SUPPORT_SORTS_IT);
    expect(body).toMatch(COACH_RESTARTS);
  });

  it('PROBE: the dispute banner (if the server ever reports one) names the coach restart rule', () => {
    const body = bannerCopy(DISPUTE_PAST_DUE, NOW).body;
    expect(body).not.toMatch(SUPPORT_SORTS_IT);
    expect(body).toMatch(COACH_RESTARTS);
  });
});
