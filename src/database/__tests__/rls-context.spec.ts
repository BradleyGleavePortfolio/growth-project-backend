/**
 * Unit tests for the A1 RLS primitive `withRlsContext`.
 *
 * These run with NO database. The Prisma client is replaced by a tiny fake whose
 * `$transaction` mirrors Prisma's interactive-transaction semantics: it invokes
 * the supplied callback with a transaction client (`tx`) and resolves to the
 * callback's return value. The `tx` records every `$executeRaw` template literal
 * so assertions can read back the `set_config(..., true)` calls.
 *
 * They pin the helper's contract for Supabase pgbouncer transaction-pool mode:
 *   - work runs inside an interactive `$transaction`
 *   - both GUCs are stamped on the `tx` handle (is_local := true) before `fn`
 *   - `fn` receives `tx`, runs after both stamps, and its result is returned
 *   - fail-closed: a failed stamp (or a throwing `fn`) skips/rolls back the rest
 *   - empty gymIds serialize to '' (A3 owns the deny semantics)
 */
import { Logger } from "@nestjs/common";
import { withRlsContext } from "../rls-context";
import {
  getRlsContext,
  RLS_GYM_IDS_KEY,
  RLS_LEGACY_USER_ID_KEY,
  RLS_LEGACY_USER_ROLE_KEY,
  RLS_USER_ID_KEY,
} from "../prisma.context";

type ExecuteRawCall = { sql: string; values: unknown[] };

/**
 * Duck-types a `Prisma.Sql` (what `Prisma.raw(...)` returns): an object with a
 * string `.sql` fragment. `Prisma.Sql` is not exported as a constructor by the
 * generated (minified) client, so an `instanceof` check is unavailable.
 */
function isPrismaSql(v: unknown): v is { sql: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { sql?: unknown }).sql === "string"
  );
}

/**
 * Reconstructs the SQL string a `$executeRaw` tagged template would send. The
 * helper inlines GUC *names* via `Prisma.raw` (rendered here as their literal
 * SQL text, exactly as Prisma's engine would compose them) and binds the
 * *values* as `$1`, `$2`, … placeholders — matching Prisma's parameterized form
 * so tests can assert literals like `set_config('app.user_id', $1, true)`.
 * `values` collects only the bound (non-`Prisma.raw`) interpolations.
 */
function renderSql(
  strings: readonly string[],
  interpolations: unknown[],
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  let sql = "";
  strings.forEach((part, i) => {
    sql += part;
    if (i < interpolations.length) {
      const v = interpolations[i];
      if (isPrismaSql(v)) {
        // Prisma.raw — composed into the SQL text, not a bound parameter.
        sql += v.sql;
      } else {
        values.push(v);
        sql += `$${values.length}`;
      }
    }
  });
  return { sql, values };
}

/**
 * A fake transaction client capturing `$executeRaw` calls.
 */
function makeTx() {
  const calls: ExecuteRawCall[] = [];
  return {
    calls,
    $executeRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
        calls.push(renderSql([...strings], values));
        return Promise.resolve(1);
      },
    ),
    // The A3.1 parity check reads both GUC namespaces back off the tx handle.
    // These bare fakes don't model GUC storage, so return an agreeing pair
    // (no mismatch) — the dual-context-expand + mismatch behaviour is pinned by
    // the stateful-fake suite below.
    $queryRaw: jest.fn(
      (): Promise<unknown[]> =>
        Promise.resolve([{ legacy_user_id: null, new_user_id: null }]),
    ),
  };
}

/**
 * A fake Prisma client whose `$transaction` runs its callback with `tx` and
 * resolves to the callback result — Prisma's interactive-transaction contract.
 */
function makeFakePrisma(tx = makeTx()) {
  const $transaction = jest.fn(
    (cb: (t: typeof tx) => Promise<unknown>): Promise<unknown> => cb(tx),
  );
  return { tx, $transaction, client: { $transaction } } as const;
}

describe("withRlsContext", () => {
  it("opens an interactive transaction", async () => {
    const { client, $transaction } = makeFakePrisma();
    const fn = jest.fn(() => Promise.resolve("ok"));

    await withRlsContext(client as never, { userId: "u1", gymIds: [] }, fn);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(typeof $transaction.mock.calls[0][0]).toBe("function");
  });

  it("stamps set_config('app.user_id', $1, true) on the tx handle", async () => {
    const { client, tx } = makeFakePrisma();

    await withRlsContext(
      client as never,
      { userId: "u1", gymIds: ["g1"] },
      () => Promise.resolve(null),
    );

    const userCall = tx.calls.find((c) => c.sql.includes(RLS_USER_ID_KEY));
    expect(userCall).toBeDefined();
    expect(userCall!.sql).toMatch(/set_config\('app\.user_id',\s*\$1,\s*true\)/);
    expect(userCall!.values).toEqual(["u1"]);
  });

  it("stamps set_config('app.gym_ids', 'g1,g2', true) on the tx handle", async () => {
    const { client, tx } = makeFakePrisma();

    await withRlsContext(
      client as never,
      { userId: "u1", gymIds: ["g1", "g2"] },
      () => Promise.resolve(null),
    );

    const gymCall = tx.calls.find((c) => c.sql.includes(RLS_GYM_IDS_KEY));
    expect(gymCall).toBeDefined();
    expect(gymCall!.sql).toMatch(/set_config\('app\.gym_ids',\s*\$1,\s*true\)/);
    expect(gymCall!.values).toEqual(["g1,g2"]);
  });

  it("invokes fn only AFTER all set_config stamps (new + legacy namespaces)", async () => {
    const { client, tx } = makeFakePrisma();
    const fn = jest.fn(() => Promise.resolve("done"));

    await withRlsContext(client as never, { userId: "u1", gymIds: ["g1"] }, fn);

    // A3.1 stamps 4 GUCs: app.user_id, app.gym_ids, app.current_user_id,
    // app.current_user_role.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
    expect(fn).toHaveBeenCalledTimes(1);
    const lastStampOrder = Math.max(
      ...tx.$executeRaw.mock.invocationCallOrder,
    );
    expect(lastStampOrder).toBeLessThan(fn.mock.invocationCallOrder[0]);
  });

  it("returns whatever fn returns", async () => {
    const { client } = makeFakePrisma();
    const sentinel = [{ id: "a" }, { id: "b" }];

    const result = await withRlsContext(
      client as never,
      { userId: "u1", gymIds: ["g1"] },
      () => Promise.resolve(sentinel),
    );

    expect(result).toBe(sentinel);
  });

  it("stamps GUCs and resolves to undefined when fn is empty", async () => {
    const { client, tx, $transaction } = makeFakePrisma();

    const result = await withRlsContext(
      client as never,
      { userId: "u1", gymIds: ["g1"] },
      async () => {},
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
    expect(result).toBeUndefined();
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("propagates fn errors so the transaction rolls back", async () => {
    const { client, tx } = makeFakePrisma();
    const boom = new Error("fn failed");

    await expect(
      withRlsContext(client as never, { userId: "u1", gymIds: ["g1"] }, () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom);

    // All 4 GUCs were still stamped; rollback is Prisma's job once fn throws.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it("fails closed: if set_config fails, fn is NOT invoked", async () => {
    const tx = makeTx();
    tx.$executeRaw.mockRejectedValueOnce(new Error("set_config failed"));
    const { client } = makeFakePrisma(tx);
    const fn = jest.fn(() => Promise.resolve("should-not-run"));

    await expect(
      withRlsContext(client as never, { userId: "u1", gymIds: ["g1"] }, fn),
    ).rejects.toThrow("set_config failed");

    expect(fn).not.toHaveBeenCalled();
  });

  it("serializes an empty gymIds list to '' (A3 policy MUST treat empty-string GUC as deny; see prisma.context.ts contract)", async () => {
    const { client, tx } = makeFakePrisma();

    await withRlsContext(
      client as never,
      { userId: "u1", gymIds: [] },
      () => Promise.resolve(null),
    );

    const gymCall = tx.calls.find((c) => c.sql.includes(RLS_GYM_IDS_KEY));
    expect(gymCall).toBeDefined();
    expect(gymCall!.values).toEqual([""]);
  });
});

/**
 * A stateful fake tx that actually STORES the GUC values written by
 * `set_config(name, value, true)` and lets `$queryRaw` read them back via
 * `current_setting(name, true)`. This simulates the real Postgres behaviour the
 * parity check depends on (legacy + new GUC resolving on the SAME connection),
 * so the dual-context-expand assertions exercise the real helper logic — not a
 * mock of it. Both `set_config` and `current_setting` are matched against the
 * EXACT bound-parameter form the helper emits.
 */
function makeStatefulPrisma() {
  const gucs = new Map<string, string>();
  const setConfigCalls: { name: string; value: string }[] = [];
  const tx = {
    $executeRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
        const { sql, values: bound } = renderSql([...strings], values);
        // set_config('<name>', $1, true) — name inlined via Prisma.raw, value bound.
        const m = /set_config\('([^']+)',\s*\$1,\s*true\)/.exec(sql);
        if (m) {
          const name = m[1];
          const value = String(bound[0] ?? "");
          gucs.set(name, value);
          setConfigCalls.push({ name, value });
        }
        return Promise.resolve(1);
      },
    ),
    $queryRaw: jest.fn(
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<unknown[]> => {
        // The parity read binds the two GUC names as $1/$2 to current_setting.
        const legacy = gucs.get(String(values[0])) ?? "";
        const next = gucs.get(String(values[1])) ?? "";
        return Promise.resolve([
          {
            legacy_user_id: legacy === "" ? null : legacy,
            new_user_id: next === "" ? null : next,
          },
        ]);
      },
    ),
  };
  const $transaction = jest.fn(
    (cb: (t: typeof tx) => Promise<unknown>): Promise<unknown> => cb(tx),
  );
  return { tx, gucs, setConfigCalls, client: { $transaction } } as const;
}

describe("withRlsContext — W1.5-A3.1 dual-context expand + parity", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("stamps BOTH namespaces with the SAME user id on the tx handle", async () => {
    const { client, gucs } = makeStatefulPrisma();

    await withRlsContext(
      client as never,
      { userId: "u-parity", gymIds: ["g1"], role: "coach" },
      () => Promise.resolve(null),
    );

    expect(gucs.get(RLS_USER_ID_KEY)).toBe("u-parity");
    expect(gucs.get(RLS_LEGACY_USER_ID_KEY)).toBe("u-parity");
    // The expand invariant: legacy and new acting-user GUCs are identical.
    expect(gucs.get(RLS_LEGACY_USER_ID_KEY)).toBe(gucs.get(RLS_USER_ID_KEY));
    expect(gucs.get(RLS_LEGACY_USER_ROLE_KEY)).toBe("coach");
  });

  it("does NOT deny-log when the two namespaces agree (parity holds)", async () => {
    const { client } = makeStatefulPrisma();

    await withRlsContext(
      client as never,
      { userId: "u-ok", gymIds: [], role: "student" },
      () => Promise.resolve(null),
    );

    const mismatchLogged = warnSpy.mock.calls.some((c) =>
      String(c[0]).includes("RLS_PARITY_MISMATCH"),
    );
    expect(mismatchLogged).toBe(false);
  });

  it("deny-logs RLS_PARITY_MISMATCH (shadow mode, no throw) when the namespaces diverge", async () => {
    // Build a prisma whose set_config writes the legacy user id to a DIFFERENT
    // value than the new one, so the parity read observes a real divergence.
    const gucs = new Map<string, string>();
    const tx = {
      $executeRaw: jest.fn(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          const { sql, values: bound } = renderSql([...strings], values);
          const m = /set_config\('([^']+)',\s*\$1,\s*true\)/.exec(sql);
          if (m) {
            const name = m[1];
            let value = String(bound[0] ?? "");
            // Corrupt ONLY the legacy id stamp to force a mismatch.
            if (name === RLS_LEGACY_USER_ID_KEY) value = "tampered-legacy-id";
            gucs.set(name, value);
          }
          return Promise.resolve(1);
        },
      ),
      $queryRaw: jest.fn((_s: TemplateStringsArray, ...values: unknown[]) => {
        const legacy = gucs.get(String(values[0])) ?? "";
        const next = gucs.get(String(values[1])) ?? "";
        return Promise.resolve([
          {
            legacy_user_id: legacy === "" ? null : legacy,
            new_user_id: next === "" ? null : next,
          },
        ]);
      }),
    };
    const client = {
      $transaction: jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    await withRlsContext(
      client as never,
      { userId: "u-new", gymIds: ["g1"], role: "coach" },
      () => Promise.resolve(null),
    );

    const mismatch = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes("RLS_PARITY_MISMATCH"),
    );
    expect(mismatch).toBeDefined();
    expect(String(mismatch![0])).toContain("tampered-legacy-id");
    expect(String(mismatch![0])).toContain("u-new");
  });

  it("reads parity off the tx handle (not the base client) — pgbouncer-safe", async () => {
    const { client, tx } = makeStatefulPrisma();

    await withRlsContext(
      client as never,
      { userId: "u1", gymIds: ["g1"], role: "coach" },
      () => Promise.resolve(null),
    );

    // The parity read MUST be issued on the same tx that stamped the GUCs.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("RLS GUC name constants", () => {
  it("pin the exact GUC names the policies depend on", () => {
    expect(RLS_USER_ID_KEY).toBe("app.user_id");
    expect(RLS_GYM_IDS_KEY).toBe("app.gym_ids");
  });
});

describe("getRlsContext (A1 stub)", () => {
  it("returns null until A2 wires AsyncLocalStorage", () => {
    expect(getRlsContext()).toBeNull();
  });
});
