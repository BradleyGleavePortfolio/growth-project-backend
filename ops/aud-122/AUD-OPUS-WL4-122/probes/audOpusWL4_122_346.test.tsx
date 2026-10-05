/**
 * AUD-OPUS-WL4-122 probe on mobile #346 @ 5f8378ff (run at #347 08c7416e; never merge).
 * Delta since Opus APPROVE @ 26cf23b7: Create off until hydration ends, early taps dropped
 * (B-346-3 / C-346-7). "verify" cases must PASS: no dead end (Create comes back on in every
 * hydration outcome), nothing sent from an early tap, a fresh tap sends the shown package once.
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

const createBtn = (s: { getByTestId: (id: string) => { props: Record<string, any> } }) =>
  s.getByTestId("first-package-create");

describe("AUD-OPUS-WL4-122 #346 delta: Create off until hydration, early taps dropped", () => {
  it("verify C-346-7 (no saved package): Create is off while reading, on once the read returns, one tap makes one live package", async () => {
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(createBtn(s));
    await release();
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(createBtn(s));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("verify B-346-3: an early tap with an unsent saved package sends nothing; the fresh tap re-sends it once with its own key", async () => {
    const saved = newIntent(savedOneTime);
    mockStore.set(intentStorageKey("coach_1"), JSON.stringify(saved));
    const release = holdRead();
    const done = jest.fn();
    const s = await render(form(done));
    await fireEvent.press(createBtn(s));
    await release();
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(s.getByTestId("first-package-title").props.value).toBe("Saved one-time plan");
    expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(createBtn(s));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][1]).toBe(saved.key);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ priceCents: 9900, billingInterval: "one_time" });
  });

  it("verify no dead end: unreadable storage still turns Create on", async () => {
    mockRead.fail = 1;
    const s = await render(form());
    await waitFor(() =>
      expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false }),
    );
  });

  it("verify: an account switch turns Create off again until the new account's read returns", async () => {
    const done = jest.fn();
    const s = await render(form(done));
    await waitFor(() =>
      expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false }),
    );
    const release = holdRead();
    mockUser = { id: "coach_2" };
    await s.rerender(form(done));
    expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(createBtn(s));
    await release();
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("verify no dead end: a network failure leaves Create usable and the retry re-sends the same key once", async () => {
    mockCreate.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Network Error"), { request: {} });
    });
    const done = jest.fn();
    const s = await render(form(done));
    await waitFor(() =>
      expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false }),
    );
    await fireEvent.press(createBtn(s));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    await flush();
    expect(done).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(createBtn(s).props.accessibilityState).toMatchObject({ disabled: false }),
    );
    await fireEvent.press(createBtn(s));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][1]).toBe(mockCreate.mock.calls[0][1]);
  });
});
