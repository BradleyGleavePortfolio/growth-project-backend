// B-TRIALS-2 (agent 114) — #656 x #641 composition seam.
//
// Backend #641 adds PackagesService.createIdempotent (Idempotency-Key create,
// which builds its own create data). Trial rules run inside
// assertValidPricing, so that path refuses an invalid trial too. This spec
// runs once both PRs are on main; until #641 lands the method is absent and
// the block is skipped, so either merge order is covered by the CI of the
// PR that merges second.
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';

function harness() {
  const tx = {
    workoutBuilderIdempotencyKey: {
      create: jest.fn(async () => ({ id: 'claim-1' })),
      update: jest.fn(async () => ({})),
    },
    coachPackage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pkg-1', ...data })),
    },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const svc = Reflect.construct(PackagesService, [prisma, {}]);
  const createIdempotent = Reflect.get(svc, 'createIdempotent');
  const call = (input: Record<string, unknown>, key: string) =>
    Reflect.apply(createIdempotent, svc, ['coach-1', input, key]);
  return { tx, call, present: typeof createIdempotent === 'function' };
}

const base = { name: 'Pro', amount_cents: 4900, billing_type: 'recurring', interval: 'month' };
const describeIfComposed = harness().present ? describe : describe.skip;

describeIfComposed('B-TRIALS x #641 — Idempotency-Key create applies the trial rules', () => {
  it('refuses 45 days and writes nothing', async () => {
    const h = harness();
    await expect(h.call({ ...base, trial_days: 45 }, 'key-trial-45')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.tx.coachPackage.create).not.toHaveBeenCalled();
    expect(h.tx.workoutBuilderIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it('refuses a trial on a one-time package', async () => {
    const h = harness();
    await expect(
      h.call({ ...base, billing_type: 'one_time', interval: null, trial_days: 7 }, 'key-trial-ot'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores the trial on the package it creates', async () => {
    const h = harness();
    await expect(h.call({ ...base, trial_days: 7 }, 'key-trial-07')).resolves.toMatchObject({
      pkg: { trial_days: 7 },
    });
  });
});

it('B-TRIALS create seam: plain create refuses 45 days', async () => {
  const h = harness();
  const svc = Reflect.construct(PackagesService, [
    { coachPackage: h.tx.coachPackage },
    {},
  ]);
  await expect(svc.create('coach-1', { ...base, billing_type: 'recurring', trial_days: 45 })).rejects.toBeInstanceOf(
    BadRequestException,
  );
});
