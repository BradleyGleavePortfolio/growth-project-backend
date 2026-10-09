/**
 * B31 (agent 133): Roman ran every grounded client turn in degraded mode in
 * production ("cannot see your details") because RomanService never received
 * its context builder.
 *
 * Root cause: `@Optional() private readonly clientContext:
 * RomanClientContextService | null = null` has no explicit token. With
 * strictNullChecks, TypeScript emits a `T | null` parameter as `Object` in
 * design:paramtypes (checked in the tsc build output, dist/roman/roman.service.js),
 * so Nest looked up a provider named Object, found none, and the optional
 * parameter fell back to its null default. Unit tests construct RomanService
 * by hand, so they never saw it.
 *
 * These specs build RomanService through Nest DI, exactly as RomanModule does.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { PrismaService } from '../../src/prisma.service';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { AuditService } from '../../src/audit/audit.service';
import { RomanService, type RomanCaller } from '../../src/roman/roman.service';
import { RomanModule } from '../../src/roman/roman.module';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { resolveRomanCoachScope } from '../../src/roman/context/roman-coach-scope';

const CALLER: RomanCaller = { id: 'b31-client', role: 'student', tier: 'free' };

type Ctor = abstract new (...args: never[]) => unknown;

/**
 * Optional constructor params that still resolve to `Object` with no explicit
 * token. Each is a known gap reported to the operator, not silently accepted:
 * B31-D1 (agent 133 report): the coach AI credit pool (B-668-1) is never wired
 * in production; wiring it starts refusing coached turns when a pool is empty,
 * so it needs an operator decision first.
 */
const KNOWN_UNWIRED: ReadonlyArray<string> = [
  'RomanService#5',
  'RomanBackgroundSpendService#1',
  'RomanCoachMethodAugmenter#1',
];

function unwiredOptionalParams(cls: Ctor): number[] {
  const types: unknown[] = Reflect.getMetadata('design:paramtypes', cls) ?? [];
  const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) ?? [];
  const declared: { index: number }[] = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? [];
  const tokened = new Set(declared.map((d) => d.index));
  return types
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => t === Object && optional.includes(i) && !tokened.has(i))
    .map(({ i }) => i);
}

describe('B31: RomanService receives its context builder through Nest DI', () => {
  async function build(ctx: unknown, audit: unknown): Promise<RomanService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RomanService,
        { provide: PrismaService, useValue: {} },
        { provide: AiEgressService, useValue: {} },
        { provide: RomanClientContextService, useValue: ctx },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    return moduleRef.get(RomanService);
  }

  it('injects RomanClientContextService and AuditService (not the null default)', async () => {
    const ctx = { getBundle: jest.fn() };
    const audit = { write: jest.fn() };
    const svc = await build(ctx, audit);
    const fields = svc as unknown as { clientContext: unknown; audit: unknown };
    expect(fields.clientContext).toBe(ctx);
    expect(fields.audit).toBe(audit);
  });

  it('a grounded turn loads its bundle from the injected builder', async () => {
    const bundle = { context: {}, rendered: '<client_data>Avery</client_data>', hash: 'h' };
    const ctx = { getBundle: jest.fn().mockResolvedValue(bundle) };
    const svc = await build(ctx, { write: jest.fn() });
    const load = (
      svc as unknown as {
        loadTurnBundle: (c: RomanCaller) => Promise<unknown>;
      }
    ).loadTurnBundle.bind(svc);
    await expect(load(CALLER)).resolves.toBe(bundle);
    expect(ctx.getBundle).toHaveBeenCalledWith({ id: CALLER.id, role: CALLER.role });
  });

  it('no RomanModule provider has an optional param that DI silently drops (besides the reported pool gap)', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    const found: string[] = [];
    for (const p of providers) {
      const cls =
        typeof p === 'function'
          ? (p as Ctor)
          : p &&
              typeof p === 'object' &&
              typeof (p as { useClass?: unknown }).useClass === 'function'
            ? (p as { useClass: Ctor }).useClass
            : null;
      if (!cls) continue;
      for (const i of unwiredOptionalParams(cls)) found.push(`${cls.name}#${i}`);
    }
    expect(found.sort()).toEqual([...KNOWN_UNWIRED].sort());
  });
});

describe('B31: plan side for coached and coachless students', () => {
  const coach = { id: 'coach-1', role: 'coach', deleted_at: null };

  it('a coachless student reads plan rows from their own tenant only', () => {
    const s = resolveRomanCoachScope({
      userRole: 'student',
      callerRole: 'student',
      coach: null,
      overlay: null,
      userId: 'client-1',
    });
    expect(s.coachId).toBeNull();
    expect(s.coachSide).toEqual([]);
    expect(s.planSide).toEqual(['client-1']);
  });

  it('a coached student keeps the coach side (never their own tenant)', () => {
    const s = resolveRomanCoachScope({
      userRole: 'student',
      callerRole: 'student',
      coach,
      overlay: { head_coach_id: 'coach-1', sub_coach_id: 'sub-1' },
      userId: 'client-1',
    });
    expect(s.planSide).toEqual(['coach-1', 'sub-1']);
  });

  it('a non-student caller or role mismatch gets no plan side', () => {
    for (const [userRole, callerRole] of [
      ['coach', 'coach'],
      ['student', 'coach'],
      ['coach', 'student'],
    ]) {
      const s = resolveRomanCoachScope({
        userRole,
        callerRole,
        coach: null,
        overlay: null,
        userId: 'u',
      });
      expect(s.planSide).toEqual([]);
    }
  });

  it('without a user id a coachless student has no plan side (old callers unchanged)', () => {
    const s = resolveRomanCoachScope({
      userRole: 'student',
      callerRole: 'student',
      coach: null,
      overlay: null,
    });
    expect(s.planSide).toEqual([]);
  });
});
