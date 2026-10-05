import AsyncStorage from "@react-native-async-storage/async-storage";
import React from "react";
import { Alert, Text } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("../theme/ThemeProvider", () => {
  const module = jest.requireActual("../theme/tokens");
  const tokens = module.default;
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
  mediumTap: jest.fn(),
  successTap: jest.fn(),
  warningTap: jest.fn(),
}));
jest.mock("../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ id: "coach_normal", name: "Coach Lee" }),
}));
jest.mock("../screens/client/packageDetail/PackageDetailSurface", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return ({ package: pkg }: { package: { trialDays: number | null } }) =>
    React.createElement(Text, { testID: "normal-buyer-preview" }, String(pkg.trialDays));
});

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock("../services/api", () => ({
  __esModule: true,
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
  },
}));

import CoachPackageEditScreen from "../screens/coach/payments/CoachPackageEditScreen";
import type { CoachPackage } from "../api/packagesApi";

const mobileRow = (free = false): CoachPackage => ({
  id: "pkg_normal",
  coachUserId: "coach_normal",
  title: "Coaching",
  description: "Weekly coaching",
  priceCents: free ? 0 : 9900,
  currency: "usd",
  billingInterval: free ? "one_time" : "monthly",
  intervalCount: 1,
  trialDays: null,
  features: [],
  status: "active",
  shareToken: null,
  subscriberCount: 0,
  monthlyRevenueCents: 0,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  archivedAt: null,
  publishedAt: "2026-10-01T12:00:00Z",
});
const backendRow = (published = true) => ({
  id: "pkg_normal",
  name: "Coaching",
  description: "Weekly coaching",
  amount_cents: 9900,
  currency: "usd",
  billing_type: "recurring",
  interval: "month",
  interval_count: 1,
  is_active: true,
  published_at: published ? "2026-10-01T12:00:00Z" : null,
});
const navigation = () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  dispatch: jest.fn(),
});
const editRoute = (pkg: CoachPackage) => ({
  key: "normal-edit",
  name: "CoachPackageEdit",
  params: { packageId: pkg.id, initialPackage: pkg },
});

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await AsyncStorage.clear();
  mockPatch.mockResolvedValue({ data: backendRow() });
});

describe("W3 ordinary one-person package flows", () => {
  it("a coach can rename the free first package without changing its zero price", async () => {
    const pkg = mobileRow(true);
    const s = await render(
      <CoachPackageEditScreen
        navigation={navigation() as never}
        route={editRoute(pkg) as never}
      />,
    );
    await fireEvent.changeText(
      s.getByPlaceholderText("e.g. 12-week transformation"),
      "Free coaching renamed",
    );
    await fireEvent.press(s.getByLabelText("Save changes"));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        "/v1/coach/packages/pkg_normal",
        expect.objectContaining({ name: "Free coaching renamed", amount_cents: 0 }),
        expect.any(Object),
      ),
    );
  });

  it("a saved fourteen-day trial is not silently discarded from the actual request", async () => {
    const s = await render(
      <CoachPackageEditScreen
        navigation={navigation() as never}
        route={editRoute(mobileRow()) as never}
      />,
    );
    await fireEvent.changeText(s.getByPlaceholderText("0"), "14");
    await fireEvent.press(s.getByLabelText("Save changes"));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch.mock.calls[0][1]).toEqual(
      expect.objectContaining({ trial_days: 14 }),
    );
  });

  it("a completed coach can make a newly-created paid package live from the editor", async () => {
    const nav = navigation();
    mockPost.mockResolvedValue({ data: backendRow(false) });
    const s = await render(
      <CoachPackageEditScreen
        navigation={nav as never}
        route={{
          key: "normal-create",
          name: "CoachPackageEdit",
          params: { packageId: null },
        } as never}
      />,
    );
    await fireEvent.changeText(s.getByPlaceholderText("e.g. 12-week transformation"), "Coaching");
    await fireEvent.changeText(s.getByPlaceholderText("199.00"), "99");
    await fireEvent.press(s.getByLabelText("Create package"));
    await waitFor(() => expect(nav.dispatch).toHaveBeenCalledTimes(1));
    const created = nav.dispatch.mock.calls[0][0].payload.params.initialPackage;
    await s.rerender(
      <CoachPackageEditScreen
        navigation={nav as never}
        route={editRoute(created) as never}
      />,
    );
    const published = mockPost.mock.calls.some(
      ([url]) => url === "/v1/coach/packages/pkg_normal/publish",
    );
    const publishControl = s.queryAllByRole("button").some((node) =>
      /publish|make .*live/i.test(node.props.accessibilityLabel ?? ""),
    );
    expect(published || publishControl).toBe(true);
  });
});
