/**
 * AUD-OPUS-W12-119 probe on mobile #345 @ 97c9005e (never merge).
 * "verify" cases assert the fix-round claims; "observe" cases record current
 * behaviour behind a follow-up C (they pass when the C is real).
 */
jest.mock("../../../services/api", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() },
}));
jest.mock("../../../services/sentry", () => ({ captureError: jest.fn() }));

const mockStore = new Map<string, string>();
jest.mock("../../../storage/mmkv", () => ({
  prefsStorage: {
    getStringAsync: async (k: string) => mockStore.get(k),
    set: async (k: string, v: string) => {
      mockStore.set(k, v);
    },
    delete: async (k: string) => {
      mockStore.delete(k);
    },
  },
}));

import api from "../../../services/api";
import { captureError } from "../../../services/sentry";
import {
  coachPackagesApi,
  type PackageCreateInput,
} from "../../../api/packagesApi";
import { toConnectView } from "../../../api/coachSetupApi";
import { connectCopy } from "../connectCopy";
import { describeError } from "../errors";
import {
  createPackageOnce,
  intentStorageKey,
  newIntent,
  PackageCreateStoppedError,
  type PackageCreateIntent,
} from "../packageCreateIntent";

const KEY = intentStorageKey("coach_1");
const monthly: PackageCreateInput = {
  title: "North coaching",
  description: null,
  priceCents: 4900,
  currency: "usd",
  billingInterval: "monthly",
  intervalCount: 1,
  trialDays: 0,
  features: [],
};
const oneTime: PackageCreateInput = { ...monthly, billingInterval: "one_time" };

type Row = Record<string, unknown>;
let stored: Row = {};
let applies = true;
function applyPatch(body: Row): Row {
  if (!applies) return { ...stored };
  const next: Row = { ...stored };
  if (body.name !== undefined) next.name = body.name;
  if (body.amount_cents !== undefined) next.amount_cents = body.amount_cents;
  if (body.billing_type !== undefined) next.billing_type = body.billing_type;
  if ("billing_interval" in body) next.interval = body.billing_interval;
  if ("billing_interval_count" in body)
    next.interval_count = body.billing_interval_count ?? 1;
  if (next.billing_type === "one_time" && !("billing_interval" in body))
    next.interval = null;
  stored = next;
  return { ...next };
}
const patch = () => jest.mocked(api.patch);
const deps = {
  create: (b: PackageCreateInput, k: string) => coachPackagesApi.create(b, k),
  update: (id: string, b: PackageCreateInput) => coachPackagesApi.update(id, b),
};
const made = (input: PackageCreateInput): PackageCreateIntent => ({
  ...newIntent(input),
  packageId: "pkg_1",
});
const disk = (): PackageCreateIntent | null => {
  const raw = mockStore.get(KEY);
  return raw ? (JSON.parse(raw) as PackageCreateIntent) : null;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  applies = true;
  stored = {
    id: "pkg_1",
    name: "North coaching",
    amount_cents: 4900,
    currency: "usd",
    billing_type: "recurring",
    interval: "month",
    interval_count: 1,
    is_active: true,
    published_at: null,
  };
  patch().mockImplementation((async (_u: string, body: Row) => ({
    data: applyPatch(body),
  })) as never);
  jest.mocked(api.post).mockImplementation((async () => ({ data: { ...stored } })) as never);
});

describe("verify: fix-round claims hold against a raw-row server", () => {
  it("editor-shape quarterly save (intervalCount 1) sends month x3 and passes the read-back check", async () => {
    stored = { ...stored, interval: "month", interval_count: 3 };
    const res = await coachPackagesApi.update("pkg_1", {
      ...monthly,
      billingInterval: "quarterly",
      intervalCount: 1,
    });
    const body = patch().mock.calls[0][1] as Row;
    expect(body).toMatchObject({
      billing_type: "recurring",
      billing_interval: "month",
      billing_interval_count: 3,
    });
    expect(res.data.billingInterval).toBe("quarterly");
  });

  it("an update answered after the form retired leaves the old input on disk; the next live tap re-sends only the PATCH", async () => {
    const earlier = made(monthly);
    mockStore.set(KEY, JSON.stringify(earlier));
    let live = true;
    patch().mockImplementationOnce((async (_u: string, body: Row) => {
      live = false;
      return { data: applyPatch(body) };
    }) as never);
    await expect(
      createPackageOnce({
        coachId: "coach_1",
        scope: "wizard",
        input: oneTime,
        earlier,
        deps,
        onIntent: () => undefined,
        isLive: () => live,
      }),
    ).rejects.toBeInstanceOf(PackageCreateStoppedError);
    expect(disk()?.input.billingInterval).toBe("monthly");
    expect(disk()?.packageId).toBe("pkg_1");
    const second = await createPackageOnce({
      coachId: "coach_1",
      scope: "wizard",
      input: oneTime,
      earlier: disk(),
      deps,
      onIntent: () => undefined,
      isLive: () => true,
    });
    expect(second.packageId).toBe("pkg_1");
    expect(jest.mocked(api.post)).not.toHaveBeenCalled();
    expect(patch()).toHaveBeenCalledTimes(2);
    expect(disk()?.input.billingInterval).toBe("one_time");
  });

  it("a server that ignores the cadence fails closed with specific copy, no Sentry, intent unchanged; a later applying server finishes", async () => {
    const earlier = made(monthly);
    mockStore.set(KEY, JSON.stringify(earlier));
    applies = false;
    let caught: unknown = null;
    try {
      await createPackageOnce({
        coachId: "coach_1",
        scope: "wizard",
        input: oneTime,
        earlier,
        deps,
        onIntent: () => undefined,
      });
    } catch (e) {
      caught = e;
    }
    const fe = describeError(caught, "create your package");
    expect(fe.code).toBe("PACKAGE_UPDATE_NOT_APPLIED");
    expect(fe.title).toBe("The new price or billing did not save");
    expect(jest.mocked(captureError)).not.toHaveBeenCalled();
    expect(disk()?.input.billingInterval).toBe("monthly");
    applies = true;
    await createPackageOnce({
      coachId: "coach_1",
      scope: "wizard",
      input: oneTime,
      earlier: disk(),
      deps,
      onIntent: () => undefined,
    });
    expect(stored.billing_type).toBe("one_time");
    expect(disk()?.input.billingInterval).toBe("one_time");
  });
});

describe("observe: follow-up Cs", () => {
  it("C-345-A: a weekly row read through list() re-saves as month x1 (cadence rewritten on a name-only editor save)", async () => {
    jest.mocked(api.get).mockResolvedValueOnce({
      data: {
        packages: [
          { ...stored, interval: "week", interval_count: 1, billing_type: "recurring" },
        ],
      },
    } as never);
    const list = await coachPackagesApi.list();
    const original = list.data[0];
    stored = { ...stored, interval: "week" };
    await coachPackagesApi.update("pkg_1", {
      title: "Renamed",
      description: null,
      priceCents: original.priceCents,
      billingInterval: original.billingInterval,
      intervalCount: 1,
      trialDays: null,
      features: [],
    });
    const body = patch().mock.calls[0][1] as Row;
    expect(original.billingInterval).toBe("monthly");
    expect(body.billing_interval).toBe("month");
  });

  it("C-345-B: older status payload, not switched on, only eventually-due items: told to finish details now", () => {
    const view = toConnectView({
      configured: false,
      charges_enabled: false,
      payouts_enabled: false,
      account_id: "acct_1",
      requirements_due: ["individual.id_number"],
    });
    const copy = connectCopy(view);
    expect(view.state).toBe("details_needed");
    expect(copy.title).toBe("Finish your Stripe details");
    expect(copy.due).toContain("Social Security number");
  });

  it("C-345-C: PACKAGE_PRICING_LOCKED (409) falls to the unknown branch", () => {
    const fe = describeError(
      { response: { status: 409, data: { code: "PACKAGE_PRICING_LOCKED", message: "x" } } },
      "create your package",
    );
    expect(fe.title).toBe("TGP could not create your package");
    expect(jest.mocked(captureError)).toHaveBeenCalledTimes(1);
  });
});
