/** Test-only: B-346-3's fresh-action requirement at W2 head 26cf23b7. */
import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("../../../../services/sentry", () => ({ captureError: jest.fn() }));
jest.mock("../../../../services/api", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
const mockCreate = jest.fn(async (..._a: unknown[]) => ({
  data: { id: "pkg_new" },
}));
const mockUpdate = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("../../../../api/packagesApi", () => ({
  coachPackagesApi: {
    create: (...a: unknown[]) => mockCreate(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
const mockPublish = jest.fn(async (..._a: unknown[]) => ({}));
const mockInvite = jest.fn(async () => ({ code: "SYNTHETIC", url: "x" }));
const mockBind = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("../../../../api/coachSetupApi", () => ({
  coachSetupApi: {
    publishPackage: (...a: unknown[]) => mockPublish(...a),
    inviteLink: () => mockInvite(),
    bindFreePackage: (...a: unknown[]) => mockBind(...a),
  },
}));
jest.mock("../../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ id: "coach_1" }),
}));
const mockStore = new Map<string, string>();
const mockRead: { hold: Promise<void> | null } = { hold: null };
jest.mock("../../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => {
      if (mockRead.hold) await mockRead.hold;
      return mockStore.get(k);
    },
    set: async (k: string, v: string) => {
      mockStore.set(k, v);
    },
    delete: async (k: string) => {
      mockStore.delete(k);
    },
  },
}));

import FirstPackageForm from "../FirstPackageForm";
import {
  intentStorageKey,
  newIntent,
} from "../../../../lib/coachSetup/packageCreateIntent";
import type { PackageCreateInput } from "../../../../api/packagesApi";

const savedInput: PackageCreateInput = {
  title: "Saved high-price recurring plan",
  priceCents: 99000,
  currency: "usd",
  billingInterval: "monthly",
  intervalCount: 1,
};
const form = (done = jest.fn()) => (
  <FirstPackageForm
    defaultTitle="Synthetic coaching"
    chargesEnabled
    onCreated={done}
  />
);
function holdRead(): () => Promise<void> {
  let release: () => void = () => undefined;
  mockRead.hold = new Promise<void>((r) => (release = r));
  return async () => {
    await act(async () => {
      mockRead.hold = null;
      release();
      // Flush the hydration -> helper -> publish -> clear continuations.
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    });
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockRead.hold = null;
});

it("B-346-3: an early tap on $49 defaults cannot publish a saved $990 plan without a fresh post-hydration tap", async () => {
  mockStore.set(
    intentStorageKey("coach_1"),
    JSON.stringify({ ...newIntent(savedInput), packageId: "pkg_saved" }),
  );
  const release = holdRead();
  const done = jest.fn();
  const screen = await render(form(done));
  expect(screen.getByTestId("first-package-title").props.value).toBe(
    "Synthetic coaching",
  );
  expect(screen.getByTestId("first-package-price").props.value).toBe("49.00");
  await fireEvent.press(screen.getByTestId("first-package-create"));
  expect(mockPublish).not.toHaveBeenCalled();
  await release();
  expect(screen.getByTestId("first-package-price").props.value).toBe("990.00");
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  // Hydration is not a user action authorizing publication of this offer.
  expect({
    published: mockPublish.mock.calls,
    completed: done.mock.calls.length,
  }).toEqual({ published: [], completed: 0 });
});

it("B-346-3: an early tap on Paid defaults cannot automatically bind an unseen saved Free package to the invite", async () => {
  const savedFree = { ...savedInput, title: "Saved free plan", priceCents: 0,
    billingInterval: "one_time" as const };
  mockStore.set(
    intentStorageKey("coach_1"),
    JSON.stringify({ ...newIntent(savedFree), packageId: "pkg_free" }),
  );
  const release = holdRead();
  const done = jest.fn();
  const screen = await render(form(done));
  expect(screen.getByTestId("first-package-paid").props.accessibilityState.checked).toBe(true);
  await fireEvent.press(screen.getByTestId("first-package-create"));
  await release();
  expect(screen.getByTestId("first-package-free").props.accessibilityState.checked).toBe(true);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect({
    published: mockPublish.mock.calls,
    bound: mockBind.mock.calls,
    completed: done.mock.calls.length,
  }).toEqual({ published: [], bound: [], completed: 0 });
});

it("control: a deliberate fresh tap after hydration publishes precisely the displayed saved plan", async () => {
  mockStore.set(
    intentStorageKey("coach_1"),
    JSON.stringify({ ...newIntent(savedInput), packageId: "pkg_saved" }),
  );
  const release = holdRead();
  const done = jest.fn();
  const screen = await render(form(done));
  await release();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(screen.getByTestId("first-package-price").props.value).toBe("990.00");
  await fireEvent.press(screen.getByTestId("first-package-create"));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(mockPublish.mock.calls).toEqual([["pkg_saved"]]);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(done.mock.calls[0][0]).toMatchObject({
    id: "pkg_saved", title: savedInput.title, priceCents: 99000,
    billingInterval: "monthly",
  });
});
