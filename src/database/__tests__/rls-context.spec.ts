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
import { withRlsContext } from "../rls-context";
import {
  getRlsContext,
  RLS_GYM_IDS_KEY,
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

  it("invokes fn only AFTER both set_config calls", async () => {
    const { client, tx } = makeFakePrisma();
    const fn = jest.fn(() => Promise.resolve("done"));

    await withRlsContext(client as never, { userId: "u1", gymIds: ["g1"] }, fn);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
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

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
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

    // GUCs were still stamped; rollback is Prisma's job once the callback throws.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
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
