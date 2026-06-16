/**
 * Unit tests for `PrismaService.withRls` (A2).
 *
 * No database. A real `PrismaService` is constructed (its `$connect` is skipped
 * under NODE_ENV=test) and its `$transaction` is replaced with a fake mirroring
 * Prisma's interactive-transaction contract so the two paths can be asserted:
 *   - no context  → fn is called with `this` (admin escape hatch), no $transaction
 *   - context     → delegates to withRlsContext, fn receives a tx handle, GUCs stamped
 */
import { PrismaService } from "../../prisma.service";
import { runWithRlsContext } from "../prisma.context";

type ExecuteRawCall = { strings: readonly string[]; values: unknown[] };

function makeTx(): {
  calls: ExecuteRawCall[];
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
} {
  const calls: ExecuteRawCall[] = [];
  return {
    calls,
    $executeRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
        calls.push({ strings: [...strings], values });
        return Promise.resolve(1);
      },
    ),
    // A3.1 parity read; return an agreeing (NULL/NULL) pair so no mismatch logs.
    $queryRaw: jest.fn(
      (): Promise<unknown[]> =>
        Promise.resolve([{ legacy_user_id: null, new_user_id: null }]),
    ),
  };
}

describe("PrismaService.withRls", () => {
  let prisma: PrismaService;
  let tx: ReturnType<typeof makeTx>;
  let transactionSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = new PrismaService();
    tx = makeTx();
    // Replace $transaction with the interactive-transaction fake: it invokes
    // the callback with our fake tx and resolves to the callback's result.
    transactionSpy = jest
      .spyOn(
        prisma as unknown as { $transaction: (cb: (t: unknown) => unknown) => unknown },
        "$transaction",
      )
      .mockImplementation((cb: (t: unknown) => unknown) => cb(tx));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("with no context: calls fn with `this` (admin path), no $transaction", async () => {
    const fn = jest.fn((client: unknown) => Promise.resolve(client));

    const result = await prisma.withRls(fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe(prisma);
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(result).toBe(prisma);
  });

  it("with a context: delegates to withRlsContext, fn receives the tx handle", async () => {
    const fn = jest.fn((client: unknown) => Promise.resolve(client));

    const result = await runWithRlsContext(
      { userId: "u1", gymIds: ["g1"] },
      () => prisma.withRls(fn),
    );

    // Delegated to withRlsContext, which opened the (faked) interactive tx.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
    // fn received the tx handle, NOT the base client.
    expect(fn.mock.calls[0][0]).toBe(tx);
    expect(result).toBe(tx);
    // All 4 GUCs (new + legacy namespaces) were stamped on the tx before fn ran.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
  });
});
