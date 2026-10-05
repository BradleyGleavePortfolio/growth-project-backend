/** AUD-OPUS-W12-119 probe on mobile #346 @ 2baea5b8 (never merge). Harness copied from w2FixRound118.test.tsx. */
import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";

jest.mock("../../../../services/sentry", () => ({
  captureError: jest.fn(),
  setSentryUser: jest.fn(),
}));

type Row = Record<string, unknown>;
const mockServer = {
  rows: new Map<string, Row>(),
  keys: new Map<string, string>(),
  creates: 0,
  patches: [] as Row[],
  publishFailOnce: false,
  publishHold: null as null | Promise<void>,
  binds: 0,
  inviteReads: 0,
};
function mockHttp(status: number, data: Row) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data, headers: {} },
  });
}
jest.mock("../../../../services/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (url: string) => {
      if (url === "/coaches/me/invite-link") {
        mockServer.inviteReads++;
        return { data: { code: "INV1", url: "https://example.test/j/INV1" } };
      }
      throw mockHttp(404, { code: "UNEXPECTED_ROUTE" });
    }),
    post: jest.fn(
      async (
        url: string,
        body: Row,
        cfg?: { headers?: Record<string, string> },
      ) => {
        if (url === "/v1/coach/packages") {
          const key = String(cfg?.headers?.["Idempotency-Key"] ?? "");
          let id = mockServer.keys.get(key);
          if (!id) {
            mockServer.creates++;
            id = `pkg_${mockServer.creates}`;
            mockServer.keys.set(key, id);
            mockServer.rows.set(id, {
              id,
              name: body.name,
              amount_cents: body.amount_cents,
              currency: "usd",
              billing_type: body.billing_type,
              interval: body.billing_interval ?? null,
              interval_count: body.billing_interval_count ?? 1,
              published_at: null,
              archived_at: null,
            });
          }
          return { data: { ...(mockServer.rows.get(id) as Row) } };
        }
        const m = /^\/v1\/coach\/packages\/([^/]+)\/publish$/.exec(url);
        if (m) {
          if (mockServer.publishHold) await mockServer.publishHold;
          if (mockServer.publishFailOnce) {
            mockServer.publishFailOnce = false;
            throw Object.assign(new Error("Network Error"), {
              code: "ERR_NETWORK",
              request: {},
            });
          }
          const row = mockServer.rows.get(decodeURIComponent(m[1]));
          if (!row) throw mockHttp(404, { code: "PACKAGE_NOT_FOUND" });
          if (row.archived_at)
            throw mockHttp(400, { code: "PACKAGE_ARCHIVED" });
          row.published_at = "2026-10-04T00:00:00.000Z";
          return { data: { ...row } };
        }
        throw mockHttp(404, { code: "UNEXPECTED_ROUTE" });
      },
    ),
    put: jest.fn(async () => {
      mockServer.binds++;
      return { data: {} };
    }),
    patch: jest.fn(async (url: string, body: Row) => {
      mockServer.patches.push({ ...body });
      const id = decodeURIComponent(url.split("/").pop() as string);
      const row = mockServer.rows.get(id);
      if (!row) throw mockHttp(404, { code: "PACKAGE_NOT_FOUND" });
      if (body.name !== undefined) row.name = body.name;
      if (body.amount_cents !== undefined) row.amount_cents = body.amount_cents;
      if (body.billing_type !== undefined) row.billing_type = body.billing_type;
      if ("billing_interval" in body) row.interval = body.billing_interval;
      if ("billing_interval_count" in body)
        row.interval_count = body.billing_interval_count ?? 1;
      return { data: { ...row } };
    }),
  },
}));

const mockStore = new Map<string, string>();
const mockHold = {
  writes: false,
  deletes: false,
  pending: [] as Array<() => void>,
};
jest.mock("../../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => mockStore.get(k),
    set: (k: string, v: string) => {
      if (!mockHold.writes) {
        mockStore.set(k, v);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) =>
        mockHold.pending.push(() => {
          mockStore.set(k, v);
          resolve();
        }),
      );
    },
    delete: (k: string) => {
      if (!mockHold.deletes) {
        mockStore.delete(k);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) =>
        mockHold.pending.push(() => {
          mockStore.delete(k);
          resolve();
        }),
      );
    },
  },
}));

let mockUser: { id: string } | null = { id: "coach_1" };
jest.mock("../../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => mockUser,
}));

const mockOpenAuth = jest.fn();
const mockDismiss = jest.fn();
jest.mock("expo-web-browser", () => ({
  __esModule: true,
  openAuthSessionAsync: (...a: unknown[]) => mockOpenAuth(...a),
  dismissAuthSession: () => mockDismiss(),
}));

import FirstPackageForm from "../FirstPackageForm";
import GetPaidPanel from "../GetPaidPanel";
import { buildChecklist } from "../CoachSetupChecklist";
import CoachSetupScreen from "../../../../screens/coach/setup/CoachSetupScreen";
import { coachSetupApi } from "../../../../api/coachSetupApi";
import api from "../../../../services/api";
import { authEvents } from "../../../../utils/authEvents";
import {
  intentStorageKey,
  newIntent,
} from "../../../../lib/coachSetup/packageCreateIntent";

jest.mock("../InviteShareCard", () => () => null);

const KEY = intentStorageKey("coach_1");
const flush = () => new Promise((r) => setTimeout(r, 30));
const deferred = <T,>() => {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const spies: Array<{ mockRestore: () => void }> = [];
function spyApi<K extends keyof typeof coachSetupApi>(name: K) {
  const sp = jest.spyOn(coachSetupApi, name);
  spies.push(sp);
  return sp;
}
const realGet = jest.mocked(api.get).getMockImplementation();
const realPost = jest.mocked(api.post).getMockImplementation();
afterEach(() => {
  spies.splice(0).forEach((sp) => sp.mockRestore());
  if (realGet) jest.mocked(api.get).mockImplementation(realGet);
  if (realPost) jest.mocked(api.post).mockImplementation(realPost);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockServer.rows.clear();
  mockServer.keys.clear();
  mockServer.creates = 0;
  mockServer.patches = [];
  mockServer.publishFailOnce = false;
  mockServer.publishHold = null;
  mockServer.binds = 0;
  mockServer.inviteReads = 0;
  mockStore.clear();
  mockHold.writes = false;
  mockHold.deletes = false;
  mockHold.pending = [];
  mockUser = { id: "coach_1" };
});

const form = (onCreated: jest.Mock = jest.fn()) => (
  <FirstPackageForm
    defaultTitle="North coaching"
    chargesEnabled
    onCreated={onCreated}
  />
);

const paid = {
  title: "North coaching",
  description: null,
  priceCents: 4900,
  currency: "usd",
  billingInterval: "monthly" as const,
  intervalCount: 1,
  trialDays: 0,
  features: [],
};
const remember = (packageId: string) => {
  mockStore.set(KEY, JSON.stringify({ ...newIntent(paid), packageId }));
};

describe("AUD-OPUS-W12-119 #346 probes", () => {
  it("P1 remembered package deleted since, coach changes cadence: PATCH 404 PACKAGE_NOT_FOUND -> one fresh live package", async () => {
    remember("pkg_gone");
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await s.findByTestId("first-package-resumed");
    await fireEvent.press(s.getByTestId("first-package-once"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mockServer.creates).toBe(1);
    expect(onCreated.mock.calls[0][0]).toMatchObject({ id: "pkg_1", billingInterval: "one_time" });
    expect(mockServer.rows.get("pkg_1")).toMatchObject({ billing_type: "one_time", published_at: expect.any(String) });
    expect(mockStore.has(KEY)).toBe(false);
  });

  it("P2 remembered paid monthly package, coach picks Free: one PATCH to one-time $0, published, bound once, no second create", async () => {
    remember("pkg_9");
    mockServer.rows.set("pkg_9", { id: "pkg_9", name: "North coaching", amount_cents: 4900, billing_type: "recurring", interval: "month", interval_count: 1, published_at: null, archived_at: null });
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await s.findByTestId("first-package-resumed");
    await fireEvent.press(s.getByTestId("first-package-free"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mockServer.creates).toBe(0);
    expect(mockServer.patches).toHaveLength(1);
    expect(mockServer.rows.get("pkg_9")).toMatchObject({ amount_cents: 0, billing_type: "one_time", interval: null, published_at: expect.any(String) });
    expect(mockServer.binds).toBe(1);
    expect(onCreated.mock.calls[0][0]).toMatchObject({ id: "pkg_9", priceCents: 0, freeOnJoin: true, billingInterval: "one_time" });
  });

  it("P3 server ignores the cadence: specific copy, nothing published, no callback, the made package stays remembered", async () => {
    remember("pkg_9");
    mockServer.rows.set("pkg_9", { id: "pkg_9", name: "North coaching", amount_cents: 4900, billing_type: "recurring", interval: "month", interval_count: 1, published_at: null, archived_at: null });
    jest.mocked(api.patch).mockImplementationOnce((async () => ({ data: { ...(mockServer.rows.get("pkg_9") as Row) } })) as never);
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await s.findByTestId("first-package-resumed");
    await fireEvent.press(s.getByTestId("first-package-once"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await s.findByTestId("first-package-error");
    expect(s.getByText("The new price or billing did not save")).toBeTruthy();
    expect(mockServer.rows.get("pkg_9")?.published_at).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    expect(JSON.parse(mockStore.get(KEY) as string).packageId).toBe("pkg_9");
  });

  it("P4 free package: binding fails on the network, retry binds without a second create", async () => {
    let failBind = true;
    jest.mocked(api.put).mockImplementation((async () => {
      if (failBind) {
        failBind = false;
        throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", request: {} });
      }
      mockServer.binds++;
      return { data: {} };
    }) as never);
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await fireEvent.press(s.getByTestId("first-package-free"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await s.findByTestId("first-package-error");
    expect(onCreated).not.toHaveBeenCalled();
    expect(JSON.parse(mockStore.get(KEY) as string).packageId).toBe("pkg_1");
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mockServer.creates).toBe(1);
    expect(mockServer.binds).toBe(1);
    expect(mockStore.has(KEY)).toBe(false);
  });

  it("P5 checklist copy (observe C): a paid charge reads 'You have been paid.'", () => {
    const items = buildChecklist({ connectActive: true, connectNeedsAttention: false, hasPackage: true, hasClient: true, sharedLink: true, paid: true });
    expect(items[3].detail).toBe("You have been paid.");
  });
});
