/**
 * AUD-OPUS-S12-117 (agent 117, Claude Opus 5.5 lens) — audit probe, never merge.
 *
 * Drives the REAL FirstPackageForm, the REAL packageCreateIntent helper, the
 * REAL coachPackagesApi / coachSetupApi request builders, over a mocked axios
 * instance that behaves like backend main's PackagesService (one package per
 * Idempotency-Key; PATCH merges only the fields it receives; a free package
 * must be one-time; an archived package cannot be published).
 *
 *   B-345-1  details changed after the package was made: the PATCH drops the
 *            billing cadence, so the live package keeps the old cadence
 *   B-329-5  (Sol, retained) the write-ahead admits a create after unmount /
 *            account change
 *   C-346-x  a remembered package that was archived is re-published forever
 *   controls the normal paid and free paths
 */
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
  createCalls: 0,
  patchBodies: [] as Row[],
  publishFailOnce: false,
  bindCalls: 0,
};

function mockHttpError(status: number, data: Row) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data, headers: {} },
  });
}

async function mockPost(
  url: string,
  body: Row,
  config?: { headers?: Record<string, string> },
) {
  if (url === "/v1/coach/packages") {
    mockServer.createCalls++;
    const key = config?.headers?.["Idempotency-Key"] ?? "";
    let id = mockServer.keys.get(key);
    if (!id) {
      id = `pkg_${mockServer.rows.size + 1}`;
      mockServer.keys.set(key, id);
      mockServer.rows.set(id, {
        id,
        ...body,
        is_active: true,
        published_at: null,
        archived_at: null,
      });
    }
    return { data: { ...(mockServer.rows.get(id) as Row) } };
  }
  const m = /^\/v1\/coach\/packages\/([^/]+)\/publish$/.exec(url);
  if (m) {
    if (mockServer.publishFailOnce) {
      mockServer.publishFailOnce = false;
      throw Object.assign(new Error("Network Error"), {
        code: "ERR_NETWORK",
        request: {},
      });
    }
    const row = mockServer.rows.get(decodeURIComponent(m[1]));
    if (!row) throw mockHttpError(404, { code: "PACKAGE_NOT_FOUND" });
    if (row.archived_at)
      throw mockHttpError(400, {
        code: "PACKAGE_ARCHIVED",
        error: "PACKAGE_ARCHIVED",
        message: "Cannot publish an archived package",
      });
    row.published_at = "2026-10-04T00:00:00.000Z";
    return { data: { ...row } };
  }
  throw mockHttpError(404, { code: "UNEXPECTED_ROUTE" });
}

async function mockPatch(url: string, body: Row) {
  mockServer.patchBodies.push({ ...body });
  const m = /^\/v1\/coach\/packages\/([^/]+)$/.exec(url);
  const id = m ? decodeURIComponent(m[1]) : "";
  const row = mockServer.rows.get(id);
  if (!row) throw mockHttpError(404, { code: "PACKAGE_NOT_FOUND" });
  const next: Row = { ...row };
  for (const k of [
    "name",
    "description",
    "amount_cents",
    "currency",
    "billing_type",
    "billing_interval",
    "billing_interval_count",
  ]) {
    if (k in body) next[k] = body[k];
  }
  if (next.billing_type === "one_time") next.billing_interval = null;
  // PackagesService.assertValidPricing: a $0 package must be one-time.
  if (next.amount_cents === 0 && next.billing_type !== "one_time")
    throw mockHttpError(400, {
      code: "PACKAGE_FREE_MUST_BE_ONE_TIME",
      error: "PACKAGE_FREE_MUST_BE_ONE_TIME",
      message: "A free package must be one-time.",
    });
  mockServer.rows.set(id, next);
  return { data: { ...next } };
}

jest.mock("../../../../services/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (url: string) => {
      if (url === "/coaches/me/invite-link")
        return {
          data: { code: "INV1", url: "https://example.test/join/INV1" },
        };
      throw Object.assign(new Error("HTTP 404"), {
        response: { status: 404, data: { code: "UNEXPECTED_ROUTE" } },
      });
    }),
    post: jest.fn(
      (url: string, body: Row, config?: { headers?: Record<string, string> }) =>
        mockPost(url, body, config),
    ),
    put: jest.fn(async () => {
      mockServer.bindCalls++;
      return { data: {} };
    }),
    patch: jest.fn((url: string, body: Row) => mockPatch(url, body)),
    delete: jest.fn(),
  },
}));

const mockStore = new Map<string, string>();
const mockHold = { writes: false, pending: [] as Array<() => void> };
jest.mock("../../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => mockStore.get(k),
    set: (k: string, v: string) => {
      if (mockHold.writes) {
        return new Promise<void>((resolve) => {
          mockHold.pending.push(() => {
            mockStore.set(k, v);
            resolve();
          });
        });
      }
      mockStore.set(k, v);
      return Promise.resolve();
    },
    delete: async (k: string) => {
      mockStore.delete(k);
    },
  },
}));

let mockUser: { id: string } | null = { id: "coach_1" };
jest.mock("../../../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => mockUser,
}));

import FirstPackageForm from "../FirstPackageForm";
import {
  intentStorageKey,
  newIntent,
} from "../../../../lib/coachSetup/packageCreateIntent";

const KEY = intentStorageKey("coach_1");

beforeEach(() => {
  mockServer.rows.clear();
  mockServer.keys.clear();
  mockServer.createCalls = 0;
  mockServer.patchBodies = [];
  mockServer.publishFailOnce = false;
  mockServer.bindCalls = 0;
  mockStore.clear();
  mockHold.writes = false;
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

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("controls (must pass at the PR head)", () => {
  it("paid monthly: one create, no PATCH, live recurring package", async () => {
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mockServer.createCalls).toBe(1);
    expect(mockServer.patchBodies).toEqual([]);
    const row = mockServer.rows.get("pkg_1") as Row;
    expect(row.billing_type).toBe("recurring");
    expect(row.published_at).toBeTruthy();
  });

  it("free from the start: one-time $0, live, bound to the invite link", async () => {
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await fireEvent.press(s.getByTestId("first-package-free"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const row = mockServer.rows.get("pkg_1") as Row;
    expect(row.billing_type).toBe("one_time");
    expect(row.amount_cents).toBe(0);
    expect(row.published_at).toBeTruthy();
    expect(mockServer.bindCalls).toBe(1);
  });
});

describe("B-345-1 — a cadence change after the package was made reaches the server", () => {
  it("monthly made, publish lost, coach picks One time: the live package is one-time", async () => {
    mockServer.publishFailOnce = true;
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await s.findByTestId("first-package-error");
    expect(mockServer.rows.size).toBe(1);
    await fireEvent.press(s.getByTestId("first-package-once"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // The app tells the coach the package is one-time ...
    expect(onCreated.mock.calls[0][0].billingInterval).toBe("one_time");
    const row = mockServer.rows.get("pkg_1") as Row;
    expect(row.published_at).toBeTruthy();
    // ... so the live package must be one-time too.
    expect({ patch: mockServer.patchBodies[0], billing_type: row.billing_type })
      .toMatchObject({ billing_type: "one_time" });
  });

  it("monthly made, publish lost, coach picks Free: the PATCH makes it one-time $0 and setup finishes", async () => {
    mockServer.publishFailOnce = true;
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await s.findByTestId("first-package-error");
    await fireEvent.press(s.getByTestId("first-package-free"));
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(mockServer.patchBodies.length).toBe(1));
    expect(mockServer.patchBodies[0]).toMatchObject({
      amount_cents: 0,
      billing_type: "one_time",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
  });
});

describe("B-329-5 (retained) — no create is admitted after the owner or mount changed", () => {
  it("leaving the form while the write-ahead is still saving sends no create", async () => {
    mockHold.writes = true;
    const s = await render(form());
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(mockHold.pending.length).toBe(1));
    await s.unmount();
    mockHold.writes = false;
    mockHold.pending.splice(0).forEach((release) => release());
    await flush();
    expect(mockServer.createCalls).toBe(0);
  });

  it("an account change while the write-ahead is still saving sends no create", async () => {
    mockHold.writes = true;
    const s = await render(form());
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(mockHold.pending.length).toBe(1));
    mockUser = { id: "coach_2" };
    await s.rerender(form());
    mockHold.writes = false;
    mockHold.pending.splice(0).forEach((release) => release());
    await flush();
    expect(mockServer.createCalls).toBe(0);
  });
});

describe("C-346-2 — a remembered package that was archived since does not trap the form", () => {
  it("publish says PACKAGE_ARCHIVED for the remembered package: a fresh package is made in the same tap", async () => {
    const made = {
      ...newIntent({
        title: "North coaching",
        description: null,
        priceCents: 4900,
        currency: "usd",
        billingInterval: "monthly",
        intervalCount: 1,
        trialDays: 0,
        features: [],
      }),
      packageId: "pkg_1",
    };
    mockStore.set(KEY, JSON.stringify(made));
    mockServer.rows.set("pkg_1", {
      id: "pkg_1",
      name: "North coaching",
      amount_cents: 4900,
      billing_type: "recurring",
      billing_interval: "month",
      published_at: null,
      archived_at: "2026-10-03T00:00:00.000Z",
    });
    const onCreated = jest.fn();
    const s = await render(form(onCreated));
    await s.findByTestId("first-package-resumed");
    await fireEvent.press(s.getByTestId("first-package-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
    expect(mockServer.createCalls).toBe(1);
  });
});
