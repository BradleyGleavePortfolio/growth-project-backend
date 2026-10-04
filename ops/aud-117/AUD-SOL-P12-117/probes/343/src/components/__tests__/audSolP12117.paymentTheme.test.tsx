import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../theme/ThemeProvider', () => {
  const t = jest.requireActual('../../theme/tokens');
  return { useTheme: () => ({ tokens: t.default, semanticColors: t.darkTokens, colorScheme: 'dark' }) };
});
jest.mock('../../storage/mmkv', () => ({
  prefsStorage: { getStringAsync: jest.fn(async () => null), set: jest.fn(async () => undefined) },
}));
jest.mock('../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'synthetic-client', role: 'student' }),
}));
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => ({ data: { packages: [{
    id: '11111111-2222-4333-8444-555555555555', name: 'Synthetic recurring',
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring', interval: 'month',
  }] } })) },
}));
jest.mock('../../hooks/usePackagePurchase', () => ({
  usePackagePurchase: () => ({
    busy: false, state: { phase: 'idle' }, clearNotice: jest.fn(), start: jest.fn(),
  }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const Sheet: typeof import('../PackageSelectionSheet').default = require('../PackageSelectionSheet').default;

function luminance(hex: string) {
  const channels = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

it('AUD-SOL-P12-117: actual selected card must keep the newly added payment terms AA-readable in dark mode', async () => {
  const r = await render(<Sheet visible onDismiss={jest.fn()} onPaymentSuccess={jest.fn()} />);
  const id = 'package-card-11111111-2222-4333-8444-555555555555';
  await waitFor(() => expect(r.getByTestId(id)).toBeTruthy());
  await fireEvent.press(r.getByTestId(id));
  const background = StyleSheet.flatten(r.getByTestId(id).props.style).backgroundColor;
  const foreground = StyleSheet.flatten(r.getByTestId('plan-terms-first-charge').props.style).color;
  const a = luminance(background);
  const b = luminance(foreground);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // Body-sized first-charge / renewal consent text must be >= 4.5:1.
  expect({ foreground, background, ratio }).toEqual(expect.objectContaining({
    ratio: expect.any(Number),
  }));
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
