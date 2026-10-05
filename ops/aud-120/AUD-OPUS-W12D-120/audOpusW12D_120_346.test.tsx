/**
 * AUD-OPUS-W12D-120 probe on mobile #346 @ 26cf23b7 (never merge).
 * Delta since Opus APPROVE @ 2baea5b8: B-346-3 hydration readiness and the
 * shown snapshot in FirstPackageForm. "verify" cases assert the fix-round
 * claims; the "observe" case records the behaviour behind follow-up C-346-7
 * (it passes when the C is real).
 */
import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("../../../../services/sentry", () => ({ captureError: jest.fn() }));
jest.mock("../../../../services/api", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
const mockCreate = jest.fn(async (_b: unknown, key: unknown) => ({
  data: { id: `pkg_${String(key).slice(-4)}` },
}));
const mockUpdate = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("../../../../api/packagesApi", () => ({
  coachPackagesApi: {
    create: (b: unknown, k: unknown) => mockCreate(b, k),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
const mockPublish = jest.fn(async (..._a: unknown[]) => ({}));
const mockInvite = jest.fn(async () => ({ code: "SYNTH", url: "x" }));
const mockBind = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("../../../../api/coachSetupApi", () => ({
  coachSetupApi: {
    publishPackage: (...a: unknown[]) => mockPublish(...a),
    inviteLink: () => mockInvite(),
    bindFreePackage: (...a: unknown[]) => mockBind(...a),
  },
}));
let mockUser: { id: string } | null = { id: "coach_1" };
jest.mock("../../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => mockUser,
}));
const mockStore = new Map<string, string>();
const mockRead: { hold: Promise<void> | null; fail: number } = {
  hold: null,
  fail: 0,
};
jest.mock("../../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => {
      if (mockRead.hold) await mockRead.hold;
      if (mockRead.fail > 0) {
        mockRead.fail -= 1;
        throw new Error("storage unavailable");
      }
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

const savedOneTime: PackageCreateInput = {
  title: "Saved one-time plan",
  priceCents: 9900,
  currency: "usd",
  billingInterval: "one_time",
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
    });
  };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockRead.hold = null;
  mockRead.fail = 0;
  mockUser = { id: "coach_1" };
});

describe("AUD-OPUS-W12D-120 #346 B-346-3 delta", () => {
  it("verify: account switch during hydration with a queued tap: the old account sends nothing and the new form never shows its package", async () => {
    const saved1 = { ...newIntent(savedOneTime), packageId: "pkg_saved_1" };
    mockStore.set(intentStorageKey("coach_1"), JSON.stringify(saved1));
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    await fireEvent.press(s.getByTestId("first-package-create"));
    mockUser = { id: "coach_2" };
    await s.rerender(form(done));
    await release();
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(s.getByTestId("first-package-title").props.value).toBe(
      "Synthetic coaching",
    );
    expect(s.queryByTestId("first-package-resumed")).toBeNull();
    // coach_1's saved package is left for coach_1.
    expect(mockStore.get(intentStorageKey("coach_1"))).toBe(
      JSON.stringify(saved1),
    );
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      title: "Synthetic coaching",
      priceCents: 4900,
      billingInterval: "monthly",
    });
    expect(mockPublish.mock.calls[0][0]).not.toBe("pkg_saved_1");
  });

  it("verify: edits and toggles before hydration ends change nothing; the saved package is what is shown and published", async () => {
    mockStore.set(
      intentStorageKey("coach_1"),
      JSON.stringify({ ...newIntent(savedOneTime), packageId: "pkg_saved" }),
    );
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    expect(
      s.getByTestId("first-package-free").props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(s.getByTestId("first-package-price").props.editable).toBe(false);
    await fireEvent.changeText(s.getByTestId("first-package-title"), "Typed early");
    await fireEvent.press(s.getByTestId("first-package-free"));
    await release();
    expect(s.getByTestId("first-package-title").props.value).toBe(
      "Saved one-time plan",
    );
    expect(s.getByTestId("first-package-price").props.value).toBe("99.00");
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls).toEqual([["pkg_saved"]]);
    expect(done.mock.calls[0][0]).toMatchObject({
      title: "Saved one-time plan",
      priceCents: 9900,
      billingInterval: "one_time",
      freeOnJoin: false,
    });
  });

  it("verify: two taps during hydration publish once and report once", async () => {
    mockStore.set(
      intentStorageKey("coach_1"),
      JSON.stringify({ ...newIntent(savedOneTime), packageId: "pkg_saved" }),
    );
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await release();
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("verify: the form closes during hydration with a queued tap: nothing sent, no callback", async () => {
    mockStore.set(intentStorageKey("coach_1"), JSON.stringify(newIntent(savedOneTime)));
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await s.unmount();
    await release();
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("verify: unreadable storage ends hydration, the tap stops with specific copy and sends nothing; once storage reads again, Try again makes one package", async () => {
    mockRead.fail = 2; // the mount read and the submit re-read
    const done = jest.fn();
    const s = await render(form(done));
    await waitFor(() =>
      expect(s.queryByTestId("first-package-hydrating")).toBeNull(),
    );
    expect(s.getByTestId("first-package-title").props.editable).toBe(true);
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() =>
      expect(
        s.getByText("Your earlier package details could not be read"),
      ).toBeTruthy(),
    );
    expect(mockCreate).not.toHaveBeenCalled();
    await fireEvent.press(s.getByTestId("first-package-error-retry"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("observe C-346-7: Create stays enabled while hydrating, so a queued tap finishes a resumed package the coach has not seen yet", async () => {
    mockStore.set(
      intentStorageKey("coach_1"),
      JSON.stringify({ ...newIntent(savedOneTime), packageId: "pkg_saved" }),
    );
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    expect(s.getByTestId("first-package-hydrating")).toBeTruthy();
    expect(
      s.getByTestId("first-package-create").props.accessibilityState,
    ).toMatchObject({ disabled: false });
    await fireEvent.press(s.getByTestId("first-package-create"));
    await release();
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockPublish.mock.calls).toEqual([["pkg_saved"]]);
  });
});
