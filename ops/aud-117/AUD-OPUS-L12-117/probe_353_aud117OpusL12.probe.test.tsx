/**
 * AUD-OPUS-L12-117 (lens Claude Opus 5.5) probes for mobile #353 @ e22acc84b3ee99c94f3ec77793b38ca0c8157241.
 * Never merge. PROBE cases assert the correct behaviour and are expected to FAIL at this head;
 * CONTROL cases must pass (they show the harness is sound).
 */
import React from 'react';
import { Text } from 'react-native';
import { render, act, waitFor, isHiddenFromAccessibility } from '@testing-library/react-native';
import { dunningLockoutStore } from '../dunningLockoutStore';
import type { ClientDunningStatus } from '../dunningApi';
import { DunningLockoutProvider } from '../DunningLockoutProvider';
import { bannerCopy } from '../DunningBanner';
import { DunningLockoutScreen } from '../DunningLockoutScreen';
import { UpdateCardScreen, endPlanAlertBody, updateCardIntro } from '../UpdateCardScreen';

jest.mock('../../../theme/ThemeProvider', () => {
  const realTokens = jest.requireActual('../../../theme/tokens').default;
  return {
    useTheme: () => ({ semanticColors: realTokens.lightTokens, tokens: realTokens, colorScheme: 'light' }),
  };
});

const mockCaptureError = jest.fn();
jest.mock('../../../services/sentry', () => ({
  captureError: (...args: unknown[]) => mockCaptureError(...args),
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../../services/api', () => ({
  __esModule: true,
  default: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

jest.mock('../../../services/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn() },
}));

/** Same rule as main's src/lib/ai/__tests__/aiClientCopy.guard.test.ts. */
const FIRST_PERSON = /\b(we|we're|we've|we'll|us|our|ours)\b/i;

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
};
/** Backend getClientStatus for a dispute cycle (B-628-8): state locked, kind dispute. */
const DISPUTE_LOCKED: ClientDunningStatus = { ...LOCKED, kind: 'dispute' };
const DISPUTE_PAST_DUE: ClientDunningStatus = { ...DISPUTE_LOCKED, state: 'past_due', locked_at: null, day: 3 };

function networkError() {
  return Object.assign(new Error('Network Error'), { response: undefined });
}

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const n = node as { children?: unknown };
  return textOf(n.children ?? null);
}

const nav = {
  route: 'HomeMain' as string | undefined,
  listeners: new Set<() => void>(),
};

async function renderProvider(child: React.ReactNode = <Text>app content</Text>) {
  return render(
    <DunningLockoutProvider
      enabled
      onMessageCoach={jest.fn()}
      onOpenDataExport={jest.fn()}
      onOpenDeleteAccount={jest.fn()}
      onSignOut={jest.fn()}
      onOpenUpdateCard={jest.fn()}
      getCurrentRouteName={() => nav.route}
      subscribeToRouteChanges={(fn) => {
        nav.listeners.add(fn);
        return () => nav.listeners.delete(fn);
      }}
    >
      {child}
    </DunningLockoutProvider>,
  );
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

beforeEach(() => {
  dunningLockoutStore.__resetForTests();
  mockGet.mockReset();
  mockPost.mockReset();
  mockCaptureError.mockReset();
  nav.route = 'HomeMain';
  nav.listeners.clear();
});

describe('B-353-1: the lockout store is not bound to the signed-in account', () => {
  it('CONTROL: account A sees its own lockout', async () => {
    mockGet.mockResolvedValue({ data: LOCKED });
    const a = await renderProvider();
    await act(async () => {
      dunningLockoutStore.reportLocked({ requestId: 'req-account-a' });
    });
    await a.findByTestId('dunning-lockout-screen');
  });

  it('PROBE: after A signs out, account B does not see A\'s lockout while B\'s status read is still pending', async () => {
    mockGet.mockResolvedValue({ data: LOCKED });
    const a = await renderProvider();
    await act(async () => {
      dunningLockoutStore.reportLocked({ requestId: 'req-account-a' });
    });
    await a.findByTestId('dunning-lockout-screen');
    // Sign out: RootNavigator renders AuthNavigator, so the client tree (and the provider) unmounts.
    await a.unmount();
    // Account B signs in on the same phone; its status read has not answered yet.
    mockGet.mockReset();
    mockGet.mockImplementation(() => new Promise(() => undefined));
    const b = await renderProvider();
    expect(b.queryByTestId('dunning-lockout-overlay')).toBeNull();
  });

  it('PROBE: after A signs out, account B is not left on A\'s lockout when B\'s status read fails (offline)', async () => {
    mockGet.mockResolvedValue({ data: LOCKED });
    const a = await renderProvider();
    await act(async () => {
      dunningLockoutStore.reportLocked({ requestId: 'req-account-a' });
    });
    await a.findByTestId('dunning-lockout-screen');
    await a.unmount();
    mockGet.mockReset();
    mockGet.mockRejectedValue(networkError());
    const b = await renderProvider();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/v1/checkout/dunning'));
    await act(async () => undefined);
    expect(b.queryByTestId('dunning-lockout-overlay')).toBeNull();
    expect(dunningLockoutStore.lastSignal()?.requestId ?? null).not.toBe('req-account-a');
  });
});

describe('B-353-2: a dispute lock (kind dispute) is described as a declined payment that a card update fixes', () => {
  it('PROBE: lockout screen for a dispute lock does not say the payment did not go through, the card was declined, or that a card charge restores access', async () => {
    const { toJSON } = await render(<DunningLockoutScreen {...lockoutProps(DISPUTE_LOCKED)} />);
    const text = textOf(toJSON());
    expect(text).not.toMatch(/has not gone through/);
    expect(text).not.toMatch(/was declined/);
    expect(text).not.toMatch(/charge it right away/);
  });

  it('PROBE: Update card intro for a dispute lock does not promise a charge or restored access', () => {
    expect(updateCardIntro(DISPUTE_LOCKED)).not.toMatch(/charged to it right away|comes back/);
  });

  it('PROBE: Days 0-9 banner for a dispute cycle does not say a card update keeps access', () => {
    expect(bannerCopy(DISPUTE_PAST_DUE).body).not.toMatch(/Update your card by .* to keep access|did not go through/);
  });

  it('PROBE: End-plan dialog for a dispute matches the backend (disputed cancel is 2A, access ends now; backend 67096788)', () => {
    const body = endPlanAlertBody(DISPUTE_LOCKED);
    expect(body).not.toMatch(/end of the period you already paid for/);
    expect(body).toMatch(/ends now|ends today/);
  });

  it('CONTROL: End-plan dialog for a payment lock says access ends now', () => {
    expect(endPlanAlertBody(LOCKED)).toMatch(/Your access ends now/);
  });
});

describe('B-353-3: client copy without first person (owner copy rule)', () => {
  it('PROBE: lockout screen copy has no first person', async () => {
    const { toJSON } = await render(<DunningLockoutScreen {...lockoutProps(LOCKED)} />);
    expect(textOf(toJSON())).not.toMatch(FIRST_PERSON);
  });

  it('PROBE: Update card screen copy has no first person', async () => {
    const { toJSON } = await render(<UpdateCardScreen />);
    expect(textOf(toJSON())).not.toMatch(FIRST_PERSON);
  });
});

describe('B-353-4: the lockout overlay hides the locked app from assistive technology', () => {
  it('CONTROL: without a lock the app content is accessible', async () => {
    mockGet.mockResolvedValue({ data: { ...LOCKED, state: 'none', purchase_id: null } });
    const r = await renderProvider();
    const el = await r.findByText('app content');
    expect(isHiddenFromAccessibility(el)).toBe(false);
  });

  it('PROBE: while the lockout shows, the app underneath is hidden from screen readers (modal overlay)', async () => {
    mockGet.mockResolvedValue({ data: LOCKED });
    const r = await renderProvider();
    await act(async () => {
      dunningLockoutStore.reportLocked({ requestId: 'req-lock' });
    });
    await r.findByTestId('dunning-lockout-screen');
    const el = r.getByText('app content', { includeHiddenElements: true });
    expect(isHiddenFromAccessibility(el)).toBe(true);
  });
});
