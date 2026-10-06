// AUD-SOL-WM1-122, agent 122: sequential, ordinary editor taps only.
// The displayed offer must be saved before it can become purchasable.
import AsyncStorage from "@react-native-async-storage/async-storage";
import React from "react";
import { Alert } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("../theme/ThemeProvider", () => {
  const tokens = jest.requireActual("../theme/tokens").default;
  return {
    useTheme: () => ({
      tokens,
      semanticColors: tokens.lightTokens,
      colors: jest.requireActual("../constants/colors").default,
    }),
  };
});
jest.mock("expo-font", () => ({ isLoaded: () => true }));
jest.mock("../lib/analytics", () => ({ track: jest.fn() }));
jest.mock("../utils/haptics", () => ({
  mediumTap: jest.fn(), successTap: jest.fn(), warningTap: jest.fn(),
}));
jest.mock("../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ id: "coach_wm1", name: "Coach Lee" }),
}));

const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock("../services/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

import CoachPackageEditScreen from "../screens/coach/payments/CoachPackageEditScreen";
import type { CoachPackage } from "../api/packagesApi";

const T = "2026-10-01T12:00:00Z";
const saved: CoachPackage = {
  id: "pkg_wm1", coachUserId: "coach_wm1", title: "Coaching",
  description: "Weekly coaching", priceCents: 9900, currency: "usd",
  billingInterval: "monthly", intervalCount: 1, trialDays: null,
  features: [], status: "active", shareToken: null, subscriberCount: 0,
  monthlyRevenueCents: 0, createdAt: T, updatedAt: T,
  archivedAt: null, publishedAt: null,
};
let server: Record<string, unknown>;
let publicPrice: unknown;

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await AsyncStorage.clear();
  publicPrice = null;
  server = {
    id: saved.id, coach_id: saved.coachUserId, name: saved.title,
    description: saved.description, amount_cents: saved.priceCents,
    currency: "usd", billing_type: "recurring", interval: "month",
    interval_count: 1, is_active: true, published_at: null,
  };
  mockPatch.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
    server = { ...server, ...body };
    return { data: { ...server } };
  });
  // The backend publish handler changes publication state, not package terms.
  mockPost.mockImplementation(async (url: string) => {
    if (url !== "/v1/coach/packages/pkg_wm1/publish") throw new Error("Unexpected POST");
    server = { ...server, published_at: T };
    publicPrice = server.amount_cents;
    return { data: { ...server } };
  });
});

function screen() {
  return render(
    <CoachPackageEditScreen
      navigation={{ navigate: jest.fn(), goBack: jest.fn(), dispatch: jest.fn() } as never}
      route={{
        key: "wm1", name: "CoachPackageEdit",
        params: { packageId: saved.id, initialPackage: saved },
      } as never}
    />,
  );
}

it("control: Save changes, then Make Coaching live, sells the edited $199 price", async () => {
  const s = await screen();
  await fireEvent.changeText(s.getByPlaceholderText("199.00"), "199");
  await fireEvent.press(s.getByLabelText("Save changes"));
  await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((Alert.alert as jest.Mock).mock.calls.some(
    (c) => c[0] === "Package updated",
  )).toBe(true));
  await fireEvent.press(s.getByLabelText("Make Coaching live"));
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  expect(publicPrice).toBe(19900);
});

it("editing a draft to $199, then tapping Make Coaching live, cannot sell the older $99 offer", async () => {
  const s = await screen();
  await fireEvent.changeText(s.getByPlaceholderText("199.00"), "199");
  await fireEvent.press(s.getByLabelText("Make Coaching live"));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
  // Valid behavior: save the current displayed offer first, or stop and
  // require Save changes. Silently publishing the previous price is invalid.
  expect(mockPost.mock.calls.length === 0 || publicPrice === 19900).toBe(true);
});
