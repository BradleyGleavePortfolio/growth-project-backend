/** Independent audit-only inquiry surfaces; never merge. */
import React from 'react';
import { render } from '@testing-library/react-native';
import { normalizeDunningStatus } from '../dunningApi';
import { DunningBanner, bannerCopy } from '../DunningBanner';
import { DunningLockoutProvider } from '../DunningLockoutProvider';
import { dunningLockoutStore } from '../dunningLockoutStore';
import { DunningLockoutScreen, lockoutSummary } from '../DunningLockoutScreen';
import { UpdateCardScreen, updateCardIntro } from '../UpdateCardScreen';

jest.mock('../../../theme/ThemeProvider', () => {
  const t = jest.requireActual('../../../theme/tokens').default;
  return { useTheme: () => ({ semanticColors: t.lightTokens, tokens: t, colorScheme: 'light' }) };
});
const mockGet = jest.fn();
jest.mock('../../../services/api', () => ({
  __esModule: true, default: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));
jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../services/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
const RAW_INQUIRY = {
  enabled: true, state: 'locked', kind: 'dispute', reason: 'dispute_paused',
  purchase_id: 'p_inquiry', amount_cents: null, currency: null, coach_name: 'Avery',
  failed_at: null, lockout_at: null, locked_at: '2026-10-05T18:00:00Z',
  access_ended: true, billing_paused: true, restart_by: 'coach',
  update_payment_route: null, update_card_url: null, cancel_route: null,
};
const INQUIRY = normalizeDunningStatus(RAW_INQUIRY);
const MONEY_WITHDRAWAL = /revers(?:ed|al)|took back|withdrawn|taken back/i;
const pauseFacts = (body: string) => {
  expect(body).toMatch(/access has ended/i);
  expect(body).toMatch(/billing is paused/i);
  expect(body).toMatch(/coach.*restart/i);
};
function Provider({ children, card = false }: { children: React.ReactNode; card?: boolean }) {
  return <DunningLockoutProvider
    enabled onMessageCoach={jest.fn()} onOpenDataExport={jest.fn()}
    onOpenDeleteAccount={jest.fn()} onSignOut={jest.fn()} onOpenUpdateCard={jest.fn()}
    getCurrentRouteName={() => card ? 'UpdateCard' : 'HomeMain'}
    subscribeToRouteChanges={() => () => undefined}
  >{children}</DunningLockoutProvider>;
}
beforeEach(() => {
  dunningLockoutStore.__resetForTests();
  mockGet.mockReset();
  mockGet.mockResolvedValue({ data: RAW_INQUIRY });
});

it.each([
  ['banner', () => { const c = bannerCopy({ ...INQUIRY, state: 'past_due', lock_waived: true }); return `${c.title} ${c.body}`; }],
  ['lockout', () => lockoutSummary(INQUIRY)],
  ['UpdateCard intro', () => updateCardIntro(INQUIRY)],
])('B-353-8: %s must not claim a bank reversal for the accepted inquiry envelope', (_name, text) => {
  const body = (text as () => string)();
  pauseFacts(body);
  expect(body).not.toMatch(MONEY_WITHDRAWAL);
});

it('B-353-8: mounted inquiry lockout has coach-only recovery without a false money claim', async () => {
  const screen = await render(<DunningLockoutScreen
    status={INQUIRY} loadError={null} refreshing={false} onRefresh={jest.fn()}
    onUpdateCard={jest.fn()} onEndPlan={jest.fn()} onMessageCoach={jest.fn()}
    onOpenDataExport={jest.fn()} onOpenDeleteAccount={jest.fn()} onSignOut={jest.fn()}
    supportReference={null}
  />);
  expect(screen.getByTestId('dunning-lockout-message-coach')).toBeTruthy();
  expect(screen.queryByTestId('dunning-lockout-update-card')).toBeNull();
  expect(screen.queryByTestId('dunning-lockout-end-plan')).toBeNull();
  expect(screen.queryAllByText(MONEY_WITHDRAWAL)).toHaveLength(0);
});

it('B-353-8: mounted inquiry UpdateCard keeps the coach path but no false bank-withdrawal claim', async () => {
  const screen = await render(<Provider card><UpdateCardScreen /></Provider>);
  await screen.findByTestId('update-card-message-coach');
  expect(screen.queryByTestId('update-card-end-plan')).toBeNull();
  expect(screen.queryAllByText(MONEY_WITHDRAWAL)).toHaveLength(0);
});

it('B-353-8: mounted waived inquiry banner keeps Message coach without a reversal headline', async () => {
  mockGet.mockResolvedValue({ data: { ...RAW_INQUIRY, state: 'past_due', lock_waived: true } });
  const screen = await render(<Provider><DunningBanner surface="audit" /></Provider>);
  await screen.findByTestId('dunning-banner');
  expect(screen.getByTestId('dunning-banner-message-coach')).toBeTruthy();
  expect(screen.queryByTestId('dunning-banner-update-card')).toBeNull();
  expect(screen.queryAllByText(MONEY_WITHDRAWAL)).toHaveLength(0);
});

it('CONTROL: a failed-payment banner still names a card update and never invents a dispute', () => {
  const body = bannerCopy(normalizeDunningStatus({
    ...RAW_INQUIRY, state: 'past_due', kind: 'payment', reason: 'payment_failed',
    amount_cents: 15000, currency: 'usd', failed_at: '2026-10-05T18:00:00Z',
  })).body;
  expect(body).toMatch(/Update your card/);
  expect(body).not.toMatch(/billing is paused|coach.*restart|reversed/i);
});
