import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutLifecycleService } from '../../../src/scout/lifecycle/lifecycle.service';
import { parseEvidence, type ParsedEvidence } from '../../../src/scout/induction/parse';
import { ObservationService } from '../../../src/scout/induction/observation.service';
import {
  PLATFORM_A,
  PLATFORM_B,
  SCOPE_1,
  SCOPE_2,
  rawEvidence,
  syntheticRegistry,
  type EvidenceSpec,
} from '../../utils/g2-s10b-fixtures';

// S10-B unit coverage of ObservationService against Prisma doubles: the D-S10-4 route refusals
// (R29), exact replay, immutability, all-or-nothing (R32), and server binding of every
// server-owned field. The run lock, FKs, triggers and grants are proven on real PG in
// test/rls-g2-s10b.spec.ts.

const COACH = 'coach-s10b-unit';
const INTENT = '5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const CHALLENGE = Buffer.alloc(32, 9);
const NOW = new Date('2026-09-26T12:00:00.000Z');

interface LockRow {
  execution_epoch: number;
  terminal_status: string | null;
  fenced_at: Date | null;
  fence_reason: string | null;
  phase: string | null;
  open_before_deadline: boolean;
}

const openLock = (over: Partial<LockRow> = {}): LockRow => ({
  execution_epoch: 2,
  terminal_status: null,
  fenced_at: null,
  fence_reason: null,
  phase: 'discovering',
  open_before_deadline: true,
  ...over,
});

interface Doubles {
  queryRaw: jest.Mock;
  declFindMany: jest.Mock;
  declCreate: jest.Mock;
  entityFindFirst: jest.Mock;
  completionFindUnique: jest.Mock;
  obsFindMany: jest.Mock;
  obsCreate: jest.Mock;
  runFindUnique: jest.Mock;
  intentFindUnique: jest.Mock;
  classifyClosed: jest.Mock;
  transaction: jest.Mock;
  committed: { value: boolean };
}

function makeDoubles(): Doubles {
  const d: Doubles = {
    queryRaw: jest.fn().mockResolvedValue([openLock()]),
    declFindMany: jest.fn().mockResolvedValue([]),
    declCreate: jest.fn().mockResolvedValue({ source_platform: PLATFORM_A }),
    entityFindFirst: jest.fn().mockResolvedValue(null),
    completionFindUnique: jest.fn().mockResolvedValue(null),
    obsFindMany: jest.fn().mockResolvedValue([]),
    obsCreate: jest.fn().mockResolvedValue({ id: 'row' }),
    runFindUnique: jest.fn().mockResolvedValue(null),
    intentFindUnique: jest.fn().mockResolvedValue(null),
    classifyClosed: jest.fn(),
    transaction: jest.fn(),
    committed: { value: false },
  };
  d.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    d.committed.value = false;
    const out = await fn({
      $queryRaw: d.queryRaw,
      scoutRunDeclaration: { findMany: d.declFindMany, create: d.declCreate },
      scoutIngestEntity: { findFirst: d.entityFindFirst },
      scoutImportCompletion: { findUnique: d.completionFindUnique },
      scoutRunObservation: { findMany: d.obsFindMany, create: d.obsCreate },
    });
    d.committed.value = true;
    return out;
  });
  return d;
}

function makeService(d: Doubles): ObservationService {
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    $transaction: d.transaction,
    scoutImport: { findUnique: d.runFindUnique },
    importIntent: { findUnique: d.intentFindUnique },
  });
  const lifecycle = Object.assign(
    Object.create(ScoutLifecycleService.prototype) as ScoutLifecycleService,
    { classifyClosed: d.classifyClosed },
  );
  return new ObservationService(prisma, lifecycle, {
    registry: syntheticRegistry({
      [PLATFORM_A]: ['clients', 'programs', 'workouts'],
      [PLATFORM_B]: ['clients'],
    }),
    challenge: () => Buffer.from(CHALLENGE),
    now: () => NOW,
  });
}

const DECLARATION = [
  { source_platform: PLATFORM_B, account_scope_id_digests: [SCOPE_1] },
  { source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_2, SCOPE_1] },
];

const heldDeclaration = () => [
  {
    source_platform: PLATFORM_A,
    account_scope_id_digest: SCOPE_1,
    challenge: CHALLENGE,
    declared_at: NOW,
  },
  {
    source_platform: PLATFORM_A,
    account_scope_id_digest: SCOPE_2,
    challenge: CHALLENGE,
    declared_at: NOW,
  },
  {
    source_platform: PLATFORM_B,
    account_scope_id_digest: SCOPE_1,
    challenge: CHALLENGE,
    declared_at: NOW,
  },
];

function evidence(spec: EvidenceSpec = {}): ParsedEvidence {
  const parsed = parseEvidence(rawEvidence(spec));
  if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.reason}`);
  return parsed.value;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err: unknown = await p.then(
    () => new Error('resolved'),
    (e: unknown) => e,
  );
  if (!(err instanceof ConflictException)) throw err;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null ? String(Reflect.get(body, 'code')) : '';
}

describe('ObservationService.declare (D-S10-4 declaration route)', () => {
  it('records the whole normalised set in one transaction with ONE server challenge', async () => {
    const d = makeDoubles();
    const out = await makeService(d).declare(COACH, INTENT, DECLARATION);
    expect(out).toEqual({
      intent_id: INTENT,
      challenge_b64: CHALLENGE.toString('base64'),
      declared_at: NOW.toISOString(),
    });
    expect(d.transaction).toHaveBeenCalledTimes(1);
    expect(d.declCreate).toHaveBeenCalledTimes(3);
    const rows = d.declCreate.mock.calls.map((c: [{ data: Record<string, unknown> }]) => c[0].data);
    // Rows are written in the NORMALISED order (platform, then scope digest by byte), the order the
    // exact-replay comparison uses, not the request's input order.
    const [lo, hi] = [SCOPE_1, SCOPE_2].sort();
    expect(rows.map((r) => [r.source_platform, r.account_scope_id_digest])).toEqual([
      [PLATFORM_A, lo],
      [PLATFORM_A, hi],
      [PLATFORM_B, SCOPE_1],
    ]);
    for (const r of rows) {
      expect(r.coach_id).toBe(COACH);
      expect(r.intent_id).toBe(INTENT);
      expect(Buffer.from(r.challenge as Uint8Array).equals(CHALLENGE)).toBe(true);
      expect(r.declared_at).toBe(NOW);
    }
    // The lock statement is FOR NO KEY UPDATE on the open server run of the bearer's coach.
    const sql = (d.queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/FROM "ScoutImport"/);
    expect(sql).toMatch(/mode = 'server'/);
    expect(sql).toMatch(/FOR NO KEY UPDATE/);
    expect(d.queryRaw.mock.calls[0].slice(1)).toEqual([COACH, INTENT]);
  });

  it('an exact replay (any order) returns the ORIGINAL challenge and writes nothing', async () => {
    const d = makeDoubles();
    const original = Buffer.alloc(32, 3);
    d.declFindMany.mockResolvedValue(heldDeclaration().map((r) => ({ ...r, challenge: original })));
    const out = await makeService(d).declare(COACH, INTENT, [...DECLARATION].reverse());
    expect(out.challenge_b64).toBe(original.toString('base64'));
    expect(d.declCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a changed scope', [{ source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_1] }]],
    [
      'an appended platform',
      [...DECLARATION, { source_platform: 'synthetic-src-c', account_scope_id_digests: [SCOPE_1] }],
    ],
  ])('%s after a declaration → declaration_conflict, no row', async (_label, platforms) => {
    const d = makeDoubles();
    d.declFindMany.mockResolvedValue(heldDeclaration());
    expect(await codeOf(makeService(d).declare(COACH, INTENT, platforms))).toBe(
      'declaration_conflict',
    );
    expect(d.declCreate).not.toHaveBeenCalled();
  });

  it('a changed set is declaration_conflict even after ingest (immutability wins)', async () => {
    const d = makeDoubles();
    d.declFindMany.mockResolvedValue(heldDeclaration());
    d.entityFindFirst.mockResolvedValue({ id: 'staged' });
    const changed = [{ source_platform: PLATFORM_B, account_scope_id_digests: [SCOPE_2] }];
    expect(await codeOf(makeService(d).declare(COACH, INTENT, changed))).toBe(
      'declaration_conflict',
    );
  });

  it.each([
    ['a staged row', 'entity'],
    ['a claim', 'claim'],
  ])('a first declaration after %s → declaration_after_ingest', async (_label, which) => {
    const d = makeDoubles();
    if (which === 'entity') d.entityFindFirst.mockResolvedValue({ id: 'staged' });
    else d.completionFindUnique.mockResolvedValue({ id: 'claim' });
    expect(await codeOf(makeService(d).declare(COACH, INTENT, DECLARATION))).toBe(
      'declaration_after_ingest',
    );
    expect(d.declCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty list', []],
    [
      'a non-canonical slug',
      [{ source_platform: 'Synthetic', account_scope_id_digests: [SCOPE_1] }],
    ],
    [
      'a duplicate platform',
      [
        { source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_1] },
        { source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_2] },
      ],
    ],
    ['an empty scope list', [{ source_platform: PLATFORM_A, account_scope_id_digests: [] }]],
    [
      'a duplicate scope',
      [{ source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_1, SCOPE_1] }],
    ],
    [
      'a non-hex scope',
      [{ source_platform: PLATFORM_A, account_scope_id_digests: ['raw-account-id'] }],
    ],
  ])('%s → 400 before any transaction', async (_label, platforms) => {
    const d = makeDoubles();
    await expect(makeService(d).declare(COACH, INTENT, platforms)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(d.transaction).not.toHaveBeenCalled();
  });

  it('an injected mid-insert failure rolls the whole declaration back (never partial)', async () => {
    const d = makeDoubles();
    d.declCreate
      .mockResolvedValueOnce({ source_platform: PLATFORM_A })
      .mockRejectedValueOnce(new Error('injected insert failure'));
    await expect(makeService(d).declare(COACH, INTENT, DECLARATION)).rejects.toThrow(
      'injected insert failure',
    );
    expect(d.committed.value).toBe(false);
  });
});

describe('the shared run refusals (R29)', () => {
  it.each([
    [
      'fenced',
      openLock({ fenced_at: NOW, fence_reason: 'cancelled', terminal_status: 'cancelled' }),
      'run_fenced',
    ],
    ['terminal', openLock({ terminal_status: 'completed' }), 'run_terminal'],
  ])('%s run → %s (declaration and observation)', async (_label, lock, code) => {
    const d = makeDoubles();
    d.queryRaw.mockResolvedValue([lock]);
    const svc = makeService(d);
    expect(await codeOf(svc.declare(COACH, INTENT, DECLARATION))).toBe(code);
    expect(await codeOf(svc.observe(COACH, INTENT, [evidence()]))).toBe(code);
    expect(d.declCreate).not.toHaveBeenCalled();
    expect(d.obsCreate).not.toHaveBeenCalled();
  });

  it('fenced carries the fence reason', async () => {
    const d = makeDoubles();
    d.queryRaw.mockResolvedValue([openLock({ fenced_at: NOW, fence_reason: 'timed_out' })]);
    const err: unknown = await makeService(d)
      .declare(COACH, INTENT, DECLARATION)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    if (err instanceof ConflictException) {
      expect(err.getResponse()).toMatchObject({ code: 'run_fenced', fence_reason: 'timed_out' });
    }
  });

  it('past the deadline → rollback, then the lifecycle classification (run_fenced timed_out)', async () => {
    const d = makeDoubles();
    d.queryRaw.mockResolvedValue([openLock({ open_before_deadline: false })]);
    d.classifyClosed.mockResolvedValue({
      kind: 'fenced',
      fence_reason: 'timed_out',
      terminal_status: 'timed_out',
    });
    expect(await codeOf(makeService(d).declare(COACH, INTENT, DECLARATION))).toBe('run_fenced');
    expect(d.classifyClosed).toHaveBeenCalledWith(COACH, INTENT);
    expect(d.declCreate).not.toHaveBeenCalled();
  });

  it('a legacy row → legacy_run', async () => {
    const d = makeDoubles();
    d.queryRaw.mockResolvedValue([]);
    d.runFindUnique.mockResolvedValue({ mode: 'legacy' });
    expect(await codeOf(makeService(d).declare(COACH, INTENT, DECLARATION))).toBe('legacy_run');
  });

  it('an owned intent without a run → run_not_started', async () => {
    const d = makeDoubles();
    d.queryRaw.mockResolvedValue([]);
    d.intentFindUnique.mockResolvedValue({ id: INTENT });
    expect(await codeOf(makeService(d).observe(COACH, INTENT, [evidence()]))).toBe(
      'run_not_started',
    );
    expect(d.intentFindUnique).toHaveBeenCalledWith({
      where: { id_coach_id: { id: INTENT, coach_id: COACH } },
      select: { id: true },
    });
  });

  it('an intent unknown to this coach (foreign or absent) → uniform 404', async () => {
    const d = makeDoubles();
    d.queryRaw.mockResolvedValue([]);
    await expect(makeService(d).declare(COACH, INTENT, DECLARATION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(makeService(d).declare(COACH, 'not-a-uuid', DECLARATION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ObservationService.observe (D-S10-4 evidence route)', () => {
  function declared(d: Doubles): void {
    d.declFindMany.mockResolvedValue(
      heldDeclaration().map(({ source_platform, account_scope_id_digest }) => ({
        source_platform,
        account_scope_id_digest,
      })),
    );
  }

  it('without a declaration → declaration_missing', async () => {
    const d = makeDoubles();
    expect(await codeOf(makeService(d).observe(COACH, INTENT, [evidence()]))).toBe(
      'declaration_missing',
    );
  });

  it.each([
    ['a claim row', 'claim'],
    ['the reconciling phase', 'phase'],
  ])('after %s → observation_after_claim', async (_label, which) => {
    const d = makeDoubles();
    declared(d);
    if (which === 'claim') d.completionFindUnique.mockResolvedValue({ id: 'claim' });
    else d.queryRaw.mockResolvedValue([openLock({ phase: 'reconciling' })]);
    expect(await codeOf(makeService(d).observe(COACH, INTENT, [evidence()]))).toBe(
      'observation_after_claim',
    );
    expect(d.obsCreate).not.toHaveBeenCalled();
  });

  it('stores each unit bound to the locked epoch, the bearer coach and the server clock', async () => {
    const d = makeDoubles();
    declared(d);
    const items = [
      evidence(),
      evidence({ family: 'workouts' }),
      evidence({ platform: PLATFORM_B }),
    ];
    const out = await makeService(d).observe(COACH, INTENT, items);
    expect(out).toEqual({ intent_id: INTENT, execution_epoch: 2, stored: 3, replayed: 0 });
    for (const [call] of d.obsCreate.mock.calls as [{ data: Record<string, unknown> }][]) {
      expect(call.data).toMatchObject({
        coach_id: COACH,
        intent_id: INTENT,
        execution_epoch: 2,
        basis_kind: 'source_signed_enumeration',
        received_at: NOW,
      });
      expect(call.data.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(d.obsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { coach_id: COACH, intent_id: INTENT, execution_epoch: 2 },
      }),
    );
  });

  it('an identical re-upload is a replay (no row); a different one is observation_conflict', async () => {
    const d = makeDoubles();
    declared(d);
    const svc = makeService(d);
    await svc.observe(COACH, INTENT, [evidence()]);
    const [first] = d.obsCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
    d.obsCreate.mockClear();
    d.obsFindMany.mockResolvedValue([
      {
        source_platform: PLATFORM_A,
        account_scope_id_digest: SCOPE_1,
        family: 'clients',
        evidence_digest: first.data.evidence_digest,
      },
    ]);
    expect(await svc.observe(COACH, INTENT, [evidence()])).toMatchObject({
      stored: 0,
      replayed: 1,
    });
    expect(d.obsCreate).not.toHaveBeenCalled();
    expect(await codeOf(svc.observe(COACH, INTENT, [evidence({ observedUnique: 4 })]))).toBe(
      'observation_conflict',
    );
  });

  it('a conflicting unit refuses the whole batch (rows already written roll back)', async () => {
    const d = makeDoubles();
    declared(d);
    d.obsFindMany.mockResolvedValue([
      {
        source_platform: PLATFORM_A,
        account_scope_id_digest: SCOPE_1,
        family: 'workouts',
        evidence_digest: '0'.repeat(64),
      },
    ]);
    const batch = [evidence(), evidence({ family: 'workouts' })];
    expect(await codeOf(makeService(d).observe(COACH, INTENT, batch))).toBe('observation_conflict');
    expect(d.obsCreate).toHaveBeenCalledTimes(1);
    expect(d.committed.value).toBe(false);
  });

  it.each<[string, EvidenceSpec]>([
    ['an undeclared platform', { platform: 'synthetic-src-c' }],
    ['an undeclared scope', { platform: PLATFORM_B, scope: SCOPE_2 }],
    ['a family outside the manifest', { platform: PLATFORM_B, family: 'workouts' }],
    ['a family outside the manifest (client_history)', { family: 'client_history' }],
  ])('%s → observation_not_declared, nothing stored', async (_label, spec) => {
    const d = makeDoubles();
    declared(d);
    expect(await codeOf(makeService(d).observe(COACH, INTENT, [evidence(), evidence(spec)]))).toBe(
      'observation_not_declared',
    );
    expect(d.committed.value).toBe(false);
  });

  it('a declared platform without an induction manifest → observation_not_declared', async () => {
    const d = makeDoubles();
    d.declFindMany.mockResolvedValue([
      { source_platform: 'synthetic-src-c', account_scope_id_digest: SCOPE_1 },
    ]);
    expect(
      await codeOf(
        makeService(d).observe(COACH, INTENT, [evidence({ platform: 'synthetic-src-c' })]),
      ),
    ).toBe('observation_not_declared');
  });

  it('more than 4 families × the declared scopes → 400', async () => {
    const d = makeDoubles();
    d.declFindMany.mockResolvedValue([
      { source_platform: PLATFORM_A, account_scope_id_digest: SCOPE_1 },
    ]);
    const five = [
      evidence(),
      evidence({ family: 'workouts' }),
      evidence({ family: 'programs' }),
      evidence({ family: 'client_history' }),
      evidence({ scope: SCOPE_2 }),
    ];
    await expect(makeService(d).observe(COACH, INTENT, five)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(d.obsCreate).not.toHaveBeenCalled();
  });
});
