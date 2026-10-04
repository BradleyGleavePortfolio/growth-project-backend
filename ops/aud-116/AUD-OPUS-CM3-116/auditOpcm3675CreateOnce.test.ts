/**
 * AUD-OPUS-CM3-116 (lens Claude Opus 5.5) probe, never merged: mobile #345
 * createPackageOnce against the EXACT wire bodies backend #675 @ e45b06f9
 * sends for each idempotency outcome (shapes taken from the backend probe
 * audit-opcm3-675-wire.spec.ts: global envelope + package_id on the 422 only).
 * Asserts: one package per create, adopt-then-update on 422, same-tap fresh
 * start on 410, same key kept on 409, intent cleared on a definitive 400, and
 * (control) the pre-fix 422 without package_id still loops on the same key.
 */
import {
  createPackageOnce,
  loadIntent,
  newIntent,
  saveIntent,
  type PackageCreateIntent,
} from "../packageCreateIntent";
import type { PackageCreateInput } from "../../../api/packagesApi";
import { describeError } from "../errors";

jest.mock("../../../storage/mmkv", () => {
  const memory = new Map<string, string>();
  return {
    __memory: memory,
    prefsStorage: {
      getString: (k: string) => memory.get(k),
      getStringAsync: async (k: string) => memory.get(k),
      set: async (k: string, v: string | number | boolean) => {
        memory.set(k, String(v));
      },
      delete: async (k: string) => {
        memory.delete(k);
      },
      clearNamespace: async () => {
        memory.clear();
      },
    },
  };
});

jest.mock("../../../utils/idempotency", () => {
  let n = 0;
  return { generateIdempotencyKey: () => `probe-key-${String(++n).padStart(4, "0")}` };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __memory } = require("../../../storage/mmkv") as {
  __memory: Map<string, string>;
};

const COACH = "coach-1";
const P = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const A: PackageCreateInput = {
  title: "North coaching",
  description: "Coaching for strength.",
  priceCents: 4900,
  currency: "usd",
  billingInterval: "monthly",
  intervalCount: 1,
};
const B: PackageCreateInput = { ...A, priceCents: 5900 };

function envelope(status: number, code: string, message: string, error: string, extra: Record<string, unknown> = {}) {
  return {
    statusCode: status,
    code,
    message,
    error,
    timestamp: "2026-10-04T03:40:00.000Z",
    path: "/v1/coach/packages",
    request_id: "req-probe-1",
    ...extra,
  };
}
const httpError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data, headers: { "x-request-id": "req-probe-1" } },
  });

const WIRE = {
  reused: httpError(
    422,
    envelope(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key already created a package with different details. Update that package (package_id), or send a new key to create another.", "Unprocessable Entity", { package_id: P }),
  ),
  reusedPreFix: httpError(
    422,
    envelope(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key already created a package with different details.", "Unprocessable Entity"),
  ),
  archived: httpError(
    410,
    envelope(410, "IDEMPOTENT_PACKAGE_REMOVED", "The package this request created has since been archived. Send a new request to create it again.", "Gone"),
  ),
  inProgress: httpError(
    409,
    envelope(409, "IDEMPOTENCY_IN_PROGRESS", "This package is still being saved. Wait a few seconds, then send the same request again.", "Conflict"),
  ),
  keyInvalid: httpError(
    400,
    envelope(400, "IDEMPOTENCY_KEY_INVALID", "The Idempotency-Key header must be 8 to 128 letters, digits, dots, colons, dashes or underscores.", "Bad Request"),
  ),
};

type Answer = { data: { id: string } } | Error;
function server(answers: Answer[]) {
  const calls: Array<{ input: PackageCreateInput; key: string }> = [];
  const updates: Array<{ id: string; input: PackageCreateInput }> = [];
  return {
    calls,
    updates,
    deps: {
      create: async (input: PackageCreateInput, key: string) => {
        calls.push({ input, key });
        const a = answers.shift();
        if (!a) throw new Error("probe: unexpected create");
        if (a instanceof Error) throw a;
        return a;
      },
      update: async (id: string, input: PackageCreateInput) => {
        updates.push({ id, input });
        return {};
      },
    },
  };
}

async function earlierIntent(input: PackageCreateInput): Promise<PackageCreateIntent> {
  const it = newIntent(input, 1000);
  expect(await saveIntent(COACH, it, "editor")).toBe(true);
  return it;
}

async function stored(): Promise<PackageCreateIntent | null> {
  const r = await loadIntent(COACH, "editor");
  return r.kind === "found" ? r.intent : null;
}

beforeEach(() => __memory.clear());

describe("AUD-OPUS-CM3-116: mobile #345 createPackageOnce vs backend #675 @ e45b06f9 wire", () => {
  it("201 replay: the earlier key is re-sent once and its package is kept", async () => {
    const it0 = await earlierIntent(A);
    const s = server([{ data: { id: P } }]);
    const r = await createPackageOnce({ coachId: COACH, scope: "editor", input: A, earlier: it0, deps: s.deps, onIntent: () => {} });
    expect(r.packageId).toBe(P);
    expect(s.calls.map((c) => c.key)).toEqual([it0.key]);
    expect(s.updates).toEqual([]);
    expect((await stored())?.packageId).toBe(P);
  });

  it.each([
    ["same details", A],
    ["details edited since", B],
  ] as Array<[string, PackageCreateInput]>)("422 with package_id (%s): adopts that package, updates it with the current details, never loops", async (_l, now) => {
    const it0 = await earlierIntent(A);
    const s = server([WIRE.reused]);
    const r = await createPackageOnce({ coachId: COACH, scope: "editor", input: now, earlier: it0, deps: s.deps, onIntent: () => {} });
    expect(r.packageId).toBe(P);
    expect(s.calls).toHaveLength(1);
    expect(s.updates).toEqual([{ id: P, input: now }]);
    const after = await stored();
    expect(after).toMatchObject({ key: it0.key, packageId: P, input: now });
    // The next tap sends nothing: the intent is resolved and current.
    const again = await createPackageOnce({ coachId: COACH, scope: "editor", input: now, earlier: after, deps: s.deps, onIntent: () => {} });
    expect(again.packageId).toBe(P);
    expect(s.calls).toHaveLength(1);
    expect(s.updates).toHaveLength(1);
  });

  it("410 archived: same tap starts fresh with a NEW key and makes exactly one new package", async () => {
    const it0 = await earlierIntent(A);
    const s = server([WIRE.archived, { data: { id: P2 } }]);
    const r = await createPackageOnce({ coachId: COACH, scope: "editor", input: A, earlier: it0, deps: s.deps, onIntent: () => {} });
    expect(r.packageId).toBe(P2);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0].key).toBe(it0.key);
    expect(s.calls[1].key).not.toBe(it0.key);
    expect(s.updates).toEqual([]);
    expect(await stored()).toMatchObject({ key: s.calls[1].key, packageId: P2 });
  });

  it("409 in progress: rethrown, the same key stays on disk for the next tap, copy says wait", async () => {
    const it0 = await earlierIntent(A);
    const s = server([WIRE.inProgress]);
    await expect(
      createPackageOnce({ coachId: COACH, scope: "editor", input: A, earlier: it0, deps: s.deps, onIntent: () => {} }),
    ).rejects.toBe(WIRE.inProgress);
    expect(await stored()).toMatchObject({ key: it0.key, packageId: null });
    const copy = describeError(WIRE.inProgress, "save the package");
    expect(copy.title).toBe("Your package is still being saved");
    expect(copy.retryable).toBe(true);
  });

  it("400 IDEMPOTENCY_KEY_INVALID: definitive, the intent is cleared so the next tap uses a new key", async () => {
    const it0 = await earlierIntent(A);
    const s = server([WIRE.keyInvalid]);
    await expect(
      createPackageOnce({ coachId: COACH, scope: "editor", input: A, earlier: it0, deps: s.deps, onIntent: () => {} }),
    ).rejects.toBe(WIRE.keyInvalid);
    expect(await stored()).toBeNull();
  });

  it("control (pre-fix wire, 422 without package_id): rethrown, same key kept, copy asks for another tap -> the loop B-675-1 closed", async () => {
    const it0 = await earlierIntent(A);
    const s = server([WIRE.reusedPreFix, WIRE.reusedPreFix]);
    for (let i = 0; i < 2; i++) {
      const earlier = await stored();
      await expect(
        createPackageOnce({ coachId: COACH, scope: "editor", input: A, earlier, deps: s.deps, onIntent: () => {} }),
      ).rejects.toBe(WIRE.reusedPreFix);
    }
    expect(s.calls.map((c) => c.key)).toEqual([it0.key, it0.key]);
    expect(describeError(WIRE.reusedPreFix, "save the package").body).toMatch(/^Tap Create package again/);
  });
});
