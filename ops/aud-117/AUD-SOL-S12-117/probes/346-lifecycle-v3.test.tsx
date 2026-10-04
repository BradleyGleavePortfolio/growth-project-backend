// Test-only adversarial evidence for AUD-SOL-S12-117 at mobile #346.
import React from "react";
import { act, render, fireEvent, waitFor } from "@testing-library/react-native";
import { TouchableOpacity } from "react-native";

jest.mock("../../../../services/sentry", () => ({ captureError: jest.fn() }));
jest.mock("../../../../services/api", () => ({
  __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
const mockCreate = jest.fn(async (..._args: unknown[]) => ({ data: { id: "pkg_1" } }));
const mockUpdate = jest.fn(async (..._args: unknown[]) => ({}));
jest.mock("../../../../api/packagesApi", () => ({
  coachPackagesApi: {
    create: (...a: unknown[]) => mockCreate(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
const mockPublish = jest.fn(async (..._args: unknown[]) => ({}));
const mockInvite = jest.fn(async (..._args: unknown[]) => ({ code: "SYNTHETIC", url: "https://example.invalid/join/SYNTHETIC" }));
const mockBind = jest.fn(async (..._args: unknown[]) => ({}));
const mockStatus = jest.fn();
const mockMint = jest.fn();
const mockRefresh = jest.fn();
jest.mock("../../../../api/coachSetupApi", () => ({
  coachSetupApi: {
    publishPackage: (...a: unknown[]) => mockPublish(...a),
    inviteLink: (...a: unknown[]) => mockInvite(...a),
    bindFreePackage: (...a: unknown[]) => mockBind(...a),
    connectStatus: (...a: unknown[]) => mockStatus(...a),
    createOnboardingLink: (...a: unknown[]) => mockMint(...a),
    refreshConnectStatus: (...a: unknown[]) => mockRefresh(...a),
  },
}));
const mockBrowser = jest.fn(async (..._args: unknown[]) => ({ type: "cancel" }));
jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (...a: unknown[]) => mockBrowser(...a),
}));
let mockUser: { id: string } | null = { id: "coach_1" };
jest.mock("../../../../hooks/useCurrentUser", () => ({ useCurrentUser: () => mockUser }));
const mockStore = new Map<string, string>();
const mockSet = jest.fn(async (k: string, v: string) => { mockStore.set(k, v); });
const mockDelete = jest.fn(async (k: string) => { mockStore.delete(k); });
jest.mock("../../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => mockStore.get(k),
    set: (...a: [string, string]) => mockSet(...a),
    delete: (...a: [string]) => mockDelete(...a),
  },
}));
import FirstPackageForm from "../FirstPackageForm";
import GetPaidPanel from "../GetPaidPanel";

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const form = (done = jest.fn()) => (
  <FirstPackageForm defaultTitle="Synthetic coaching" chargesEnabled onCreated={done} />
);
const status = {
  state: "not_started", accountId: null, chargesEnabled: false, payoutsEnabled: false,
  detailsSubmitted: false, actionRequired: true, currentlyDue: [], pastDue: [],
  eventuallyDue: [], pendingVerification: [], deadline: null, disabledReason: null,
  refreshed: false,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: "coach_1" };
  mockStore.clear();
  mockSet.mockImplementation(async (k, v) => { mockStore.set(k, v); });
  mockDelete.mockImplementation(async (k) => { mockStore.delete(k); });
  mockPublish.mockImplementation(async () => ({}));
  mockStatus.mockResolvedValue(status);
  mockRefresh.mockResolvedValue(status);
});

it("control: same-owner create publishes and completes", async () => {
  const done = jest.fn();
  const screen = await render(form(done));
  await fireEvent.press(screen.getByTestId("first-package-create"));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockPublish).toHaveBeenCalledTimes(1);
});

it("inherited B-329-5: held write-ahead completion after unmount admits no create", async () => {
  const hold = deferred<void>();
  mockSet.mockImplementationOnce(async (k, v) => {
    await hold.promise;
    mockStore.set(k, v);
  });
  const screen = await render(form());
  await fireEvent.press(screen.getByTestId("first-package-create"));
  await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
  await screen.unmount();
  await act(async () => { hold.resolve(); await hold.promise; });
  expect(mockCreate).not.toHaveBeenCalled();
});

it("free-package publish completion after unmount does not dispatch invite or binding", async () => {
  const hold = deferred<object>();
  mockPublish.mockImplementationOnce(() => hold.promise);
  const done = jest.fn();
  const screen = await render(form(done));
  await fireEvent.press(screen.getByTestId("first-package-free"));
  await fireEvent.press(screen.getByTestId("first-package-create"));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
  await screen.unmount();
  await act(async () => { hold.resolve({}); await hold.promise; });
  expect(mockInvite).not.toHaveBeenCalled();
  expect(mockBind).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});

it("held final intent deletion after unmount invokes no stale completion callback", async () => {
  const hold = deferred<void>();
  mockDelete.mockImplementationOnce(async (k) => {
    await hold.promise;
    mockStore.delete(k);
  });
  const done = jest.fn();
  const screen = await render(form(done));
  await fireEvent.press(screen.getByTestId("first-package-create"));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
  await screen.unmount();
  await act(async () => { hold.resolve(); await hold.promise; });
  expect(done).not.toHaveBeenCalled();
});

it("held onboarding-link mint after unmount never opens the old Stripe session", async () => {
  const hold = deferred<{ url: string; expiresAt: null }>();
  mockMint.mockImplementationOnce(() => hold.promise);
  const changed = jest.fn();
  const screen = await render(<GetPaidPanel onChange={changed} />);
  await screen.findByTestId("get-paid-open");
  changed.mockClear();
  // Do not await the async handler itself: the mint is deliberately held.
  const openStripe = screen.UNSAFE_getByType(TouchableOpacity).props.onPress;
  await act(async () => { void openStripe(); });
  await waitFor(() => expect(mockMint).toHaveBeenCalledTimes(1));
  await screen.unmount();
  await act(async () => {
    hold.resolve({ url: "https://connect.stripe.com/setup/s/synthetic", expiresAt: null });
    await hold.promise;
  });
  expect(mockBrowser).not.toHaveBeenCalled();
  expect(mockRefresh).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("control: same-owner Stripe session opens and refreshes with a live callback", async () => {
  mockMint.mockResolvedValue({ url: "https://connect.stripe.com/setup/s/synthetic", expiresAt: null });
  const changed = jest.fn();
  const screen = await render(<GetPaidPanel onChange={changed} />);
  await screen.findByTestId("get-paid-open");
  changed.mockClear();
  const openStripe = screen.UNSAFE_getByType(TouchableOpacity).props.onPress;
  await act(async () => { await openStripe(); });
  expect(mockBrowser).toHaveBeenCalledTimes(1);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
});
