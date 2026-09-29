import 'reflect-metadata';
import { Global, Module, type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { JwtAuthGuard } from '../../../src/auth/auth.guard';
import { JwksVerifierService } from '../../../src/auth/jwks.service';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { NotificationsModule } from '../../../src/notifications/notifications.module';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PrismaService } from '../../../src/prisma.service';
import { PtmService } from '../../../src/ptm/ptm.service';
import { ObservationModule } from '../../../src/scout/induction/observation.module';
import { ObservationService } from '../../../src/scout/induction/observation.service';
import { ScoutLifecycleService } from '../../../src/scout/lifecycle/lifecycle.service';
import { ReconciliationFactsService } from '../../../src/scout/reconciliation/facts.service';
import { ReconciliationModule } from '../../../src/scout/reconciliation/reconciliation.module';
import { buildFamilyRegistry } from '../../../src/scout/reconstruct/families';
import { SourceRegistryModule } from '../../../src/scout/reconstruct/source-registry.module';
import {
  defaultSourceRegistryProvider,
  NO_RUN_PACKAGE,
  RUN_PACKAGE_SOURCE,
  SourceRegistryProvider,
  type RegistryDb,
} from '../../../src/scout/reconstruct/source-registry.provider';
import { RECONSTRUCT_ENTITY_TYPES } from '../../../src/scout/scout-reconstruct.dto';
import { ScoutEntitiesService } from '../../../src/scout/scout-entities.service';
import { ScoutIngestService } from '../../../src/scout/scout-ingest.service';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import { ScoutRosterService } from '../../../src/scout/scout-roster.service';
import { ScoutModule } from '../../../src/scout/scout.module';
import { ScoutService } from '../../../src/scout/scout.service';
import {
  COACH,
  LEARNED,
  PINNED,
  UNPINNED,
  recordingSource,
  type RecordingSource,
} from './l06-learned-package.fixture';

/**
 * L2a r2 — R588-A-B1 / R588-B-2: the production Nest graph fails CLOSED.
 *
 *  1. `RUN_PACKAGE_SOURCE` is provided inside `SourceRegistryModule` (explicitly
 *     `NO_RUN_PACKAGE`), so overriding that ONE token at the root reaches the one provider — and
 *     through it EVERY consumer in the ScoutModule graph: the engine, the roster and entities
 *     readers, the facts collector and its coverage evaluator, the observation service, and both
 *     lifecycles (ScoutModule's and ObservationModule's), including the engine and facts service
 *     each lifecycle settles through. No consumer holds the process-wide file-only provider.
 *  2. Removing a binding fails boot: the provider without `RUN_PACKAGE_SOURCE`, a consumer
 *     without the provider, a lifecycle without its interpreters. Nothing falls back silently.
 *
 * On f4c469c (L2a r1) every assertion of (1) about the pin fails (the token is not provided, so
 * the override is a no-op and the provider reads `NO_RUN_PACKAGE`; ObservationModule's lifecycle
 * holds the process singleton) and the negative cases of (2) compile (every seam is @Optional).
 */

const NO_DB = {} as RegistryDb;

/** No database: nothing here reads one (the pin sources ignore the handle). */
const stubPrisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
  $disconnect: () => Promise.resolve(),
  onModuleDestroy: () => Promise.resolve(),
  onModuleInit: () => Promise.resolve(),
});

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: stubPrisma },
    {
      provide: AnalyticsService,
      useValue: Object.assign(Object.create(AnalyticsService.prototype), { capture: jest.fn() }),
    },
    // The route guards' own dependency (auth is not under test here).
    { provide: PtmService, useValue: {} },
  ],
  exports: [PrismaService, AnalyticsService, PtmService],
})
class StubGlobals {}

@Module({
  providers: [{ provide: NotificationsService, useValue: {} }],
  exports: [NotificationsService],
})
class StubNotifications {}

async function scoutGraph(source?: RecordingSource): Promise<INestApplicationContext> {
  let builder = Test.createTestingModule({ imports: [StubGlobals, ScoutModule] })
    .overrideModule(NotificationsModule)
    .useModule(StubNotifications)
    // ScoutModule provides its own PrismaService: the same stub, never a client.
    .overrideProvider(PrismaService)
    .useValue(stubPrisma)
    .overrideProvider(JwksVerifierService)
    .useValue({})
    .overrideProvider(JwtAuthGuard)
    .useValue({})
    .overrideProvider(RolesGuard)
    .useValue({})
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true });
  if (source !== undefined) builder = builder.overrideProvider(RUN_PACKAGE_SOURCE).useValue(source);
  return builder.compile();
}

/** Private seams read for identity only (the same fields the R588-B P3 probe read). */
const field = <T>(instance: object, name: string): T => (instance as Record<string, T>)[name];

describe('L2a r2 — one SourceRegistryProvider across the Nest graph (R588-A-B1, R588-B-2)', () => {
  it('SourceRegistryModule itself provides RUN_PACKAGE_SOURCE, explicitly NO_RUN_PACKAGE', async () => {
    const mod = await Test.createTestingModule({ imports: [SourceRegistryModule] }).compile();
    const provider = mod.get(SourceRegistryProvider);
    expect(field(provider, 'runPackages')).toBe(NO_RUN_PACKAGE);
    expect(provider).not.toBe(defaultSourceRegistryProvider());
    const run = await provider.forRun(NO_DB, COACH, PINNED);
    expect(run.pinned).toBeNull();
    expect(run.pinDigest).toBeNull();
    // Byte-identical for an unpinned run: the same file registries the file-only provider holds.
    expect(run.sourceMappers).toBe(defaultSourceRegistryProvider().files.sourceMappers);
  });

  it('an overridden RUN_PACKAGE_SOURCE reaches the provider through the module (the probe P2 wiring)', async () => {
    const source = recordingSource();
    const mod = await Test.createTestingModule({ imports: [SourceRegistryModule] })
      .overrideProvider(RUN_PACKAGE_SOURCE)
      .useValue(source)
      .compile();
    const run = await mod.get(SourceRegistryProvider).forRun(NO_DB, COACH, PINNED);
    expect(run.pinned).not.toBeNull();
    expect(run.sourceMappers.has(LEARNED)).toBe(true);
    expect(source.lookups.map((l) => l.key)).toEqual([`${COACH}/${PINNED}`]);
  });

  it('the override reaches EVERY consumer in the ScoutModule graph, and each resolves the pin', async () => {
    const source = recordingSource();
    const mod = await scoutGraph(source);
    const shared = mod.get(SourceRegistryProvider, { strict: false });
    expect(shared).not.toBe(defaultSourceRegistryProvider());

    const scout = mod.select(ScoutModule);
    const observation = mod.select(ObservationModule);
    const reconstruct = scout.get(ScoutReconstructService, { strict: true });
    const roster = scout.get(ScoutRosterService, { strict: true });
    const entities = scout.get(ScoutEntitiesService, { strict: true });
    const lifecycle = scout.get(ScoutLifecycleService, { strict: true });
    const facts = mod
      .select(ReconciliationModule)
      .get(ReconciliationFactsService, { strict: true });
    const observe = observation.get(ObservationService, { strict: true });
    const obsLifecycle = observation.get(ScoutLifecycleService, { strict: true });

    // (a) identity: one provider instance everywhere, including inside both lifecycles.
    const holders: [string, object][] = [
      ['engine', reconstruct],
      ['roster', roster],
      ['entities', entities],
      ['facts', facts],
      ['observation', observe],
      ['ScoutModule lifecycle', lifecycle],
      ['ScoutModule lifecycle engine', field(lifecycle, 'reconstruct')],
      ['ScoutModule lifecycle facts', field(lifecycle, 'facts')],
      ['ObservationModule lifecycle', obsLifecycle],
      ['ObservationModule lifecycle engine', field(obsLifecycle, 'reconstruct')],
      ['ObservationModule lifecycle facts', field(obsLifecycle, 'facts')],
    ];
    for (const [name, holder] of holders) {
      expect([name, field(holder, 'registries')]).toEqual([name, shared]);
    }
    // Both lifecycles settle through the module-provided interpreters, never self-built ones.
    expect(field(lifecycle, 'reconstruct')).toBe(reconstruct);
    expect(field(lifecycle, 'facts')).toBe(facts);
    expect(field(obsLifecycle, 'facts')).toBe(facts);
    expect(field(observe, 'lifecycle')).toBe(obsLifecycle);
    expect(field(scout.get(ScoutService, { strict: true }), 'lifecycle')).toBe(lifecycle);
    expect(field(scout.get(ScoutIngestService, { strict: true }), 'lifecycle')).toBe(lifecycle);

    // (b) behaviour: each consumer's own per-run resolver sees the learned slug for the pinned
    // run and not for the unpinned one.
    type Mappers = ReadonlyMap<string, unknown>;
    const engineFamilies = async (svc: object, intent: string) =>
      (
        await field<(c: string, i: string) => Promise<{ sourceMappers: Mappers }>>(
          svc,
          'familiesFor',
        ).call(svc, COACH, intent)
      ).sourceMappers;
    const readerMappers = (svc: object, intent: string) =>
      field<(d: RegistryDb, c: string, i: string) => Promise<Mappers>>(svc, 'mappersFor').call(
        svc,
        NO_DB,
        COACH,
        intent,
      );
    const factsRegistries = (svc: object, intent: string) =>
      field<
        (
          d: RegistryDb,
          c: string,
          i: string,
          r: undefined,
        ) => Promise<{ sourceMappers: Mappers; registry: { packages: Mappers } }>
      >(svc, 'registriesFor').call(svc, NO_DB, COACH, intent, undefined);
    const observationRegistry = (svc: object, intent: string) =>
      field<(d: RegistryDb, c: string, i: string) => Promise<{ packages: Mappers }>>(
        svc,
        'registryFor',
      ).call(svc, NO_DB, COACH, intent);

    for (const svc of [reconstruct, field<object>(obsLifecycle, 'reconstruct')]) {
      expect((await engineFamilies(svc, PINNED)).has(LEARNED)).toBe(true);
      expect((await engineFamilies(svc, UNPINNED)).has(LEARNED)).toBe(false);
    }
    for (const svc of [roster, entities]) {
      expect((await readerMappers(svc, PINNED)).has(LEARNED)).toBe(true);
      expect((await readerMappers(svc, UNPINNED)).has(LEARNED)).toBe(false);
    }
    const pinnedFacts = await factsRegistries(facts, PINNED);
    expect(pinnedFacts.sourceMappers.has(LEARNED)).toBe(true);
    // The coverage evaluator's registry (evaluateRunCoverage reads `registry`) carries the pin.
    expect(pinnedFacts.registry.packages.has(LEARNED)).toBe(true);
    expect((await factsRegistries(facts, UNPINNED)).registry.packages.has(LEARNED)).toBe(false);
    expect((await observationRegistry(observe, PINNED)).packages.has(LEARNED)).toBe(true);
    expect((await observationRegistry(observe, UNPINNED)).packages.has(LEARNED)).toBe(false);
    for (const lc of [lifecycle, obsLifecycle]) {
      const run = await field<SourceRegistryProvider>(lc, 'registries').forRun(
        NO_DB,
        COACH,
        PINNED,
      );
      expect(run.sourceMappers.has(LEARNED)).toBe(true);
    }
    // Every lookup went to the ONE overridden source.
    expect(source.lookups.length).toBeGreaterThanOrEqual(14);
    await mod.close();
  });

  it('without an override the graph boots on the explicit NO_RUN_PACKAGE: unpinned, byte-identical', async () => {
    const mod = await scoutGraph();
    const shared = mod.get(SourceRegistryProvider, { strict: false });
    expect(field(shared, 'runPackages')).toBe(NO_RUN_PACKAGE);
    const reconstruct = mod.select(ScoutModule).get(ScoutReconstructService, { strict: true });
    expect(field(reconstruct, 'registries')).toBe(shared);
    expect(field(reconstruct, 'sourceMappers')).toBe(
      defaultSourceRegistryProvider().files.sourceMappers,
    );
    await mod.close();
  });
});

describe('L2a r2 — a missing binding fails Nest boot (no silent fallback)', () => {
  it('SourceRegistryProvider without RUN_PACKAGE_SOURCE does not compile', async () => {
    await expect(
      Test.createTestingModule({ providers: [SourceRegistryProvider] }).compile(),
    ).rejects.toThrow(/SourceRegistryProvider/);
  });

  it.each([
    ['ScoutReconstructService', ScoutReconstructService],
    ['ScoutRosterService', ScoutRosterService],
    ['ScoutEntitiesService', ScoutEntitiesService],
    ['ReconciliationFactsService', ReconciliationFactsService],
  ])('%s without SourceRegistryProvider does not compile', async (name, consumer) => {
    await expect(
      Test.createTestingModule({ imports: [StubGlobals], providers: [consumer] }).compile(),
    ).rejects.toThrow(new RegExp(name));
  });

  it('ScoutLifecycleService without its engine and facts service does not compile', async () => {
    await expect(
      Test.createTestingModule({
        imports: [StubGlobals, SourceRegistryModule],
        providers: [ScoutLifecycleService],
      }).compile(),
    ).rejects.toThrow(/ScoutLifecycleService/);
  });

  it('ObservationService without SourceRegistryProvider does not compile', async () => {
    await expect(
      Test.createTestingModule({
        imports: [StubGlobals],
        providers: [ObservationService, { provide: ScoutLifecycleService, useValue: {} }],
      }).compile(),
    ).rejects.toThrow(/ObservationService/);
  });
});

describe('L2a r2 — lifecycle family keys are a constant set (R588-B-C3)', () => {
  it('equal the keys buildFamilyRegistry() registers', () => {
    expect([...buildFamilyRegistry().keys()].sort()).toEqual([...RECONSTRUCT_ENTITY_TYPES].sort());
    expect([...field<ReadonlySet<string>>(ScoutLifecycleService, 'FAMILY_KEYS')].sort()).toEqual(
      [...buildFamilyRegistry().keys()].sort(),
    );
  });
});
