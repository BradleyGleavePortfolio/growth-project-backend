/**
 * B-CRON-126 — every timed job registers ONCE.
 *
 * Production bug (deploy 16, 2026-10-06): ScheduleModule.forRoot() was
 * imported by AppModule AND by DataExportModule. On Nest 11 dynamic modules
 * are keyed by object reference, so the two forRoot() results became two
 * ScheduleModule instances. Each instance owns its own ScheduleExplorer,
 * SchedulerOrchestrator and SchedulerRegistry, and each explorer walks EVERY
 * provider in the app, so every @Cron / @Interval was mounted twice and fired
 * twice per schedule, at the same moment.
 *
 * Runtime proof: a testing module wired the way AppModule is (one root
 * ScheduleModule.forRoot() plus the real DataExportModule) and a probe
 * provider with one @Cron and one @Interval. The probe must be registered
 * exactly once across every SchedulerRegistry in the container. On the old
 * DataExportModule this counted 2; with the fix it counts 1.
 *
 * Static guard: ScheduleModule.forRoot( / forRootAsync( appears only in
 * src/app.module.ts, exactly once.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { DynamicModule, Injectable, Type } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { Cron, Interval, ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { DataExportModule } from '../src/data-export/data-export.module';
import { DATA_EXPORT_ARCHIVE_STORE } from '../src/data-export/data-export-archive.store';
import { PrismaService } from '../src/prisma.service';

const PROBE_CRON = 'b-cron-126-probe-cron';
const PROBE_INTERVAL = 'b-cron-126-probe-interval';
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
class ScheduleProbe {
  ticks = 0;

  // 00:00 on 1 January: never fires while the test runs.
  @Cron('0 0 1 1 *', { name: PROBE_CRON, timeZone: 'UTC' })
  cronTick(): void {
    this.ticks += 1;
  }

  @Interval(PROBE_INTERVAL, DAY_MS)
  intervalTick(): void {
    this.ticks += 1;
  }
}

interface Booted {
  moduleRef: TestingModule;
  registries: SchedulerRegistry[];
  addCronJob: jest.SpyInstance;
  addInterval: jest.SpyInstance;
}

async function boot(imports: Array<Type<unknown> | DynamicModule>): Promise<Booted> {
  const addCronJob = jest.spyOn(SchedulerRegistry.prototype, 'addCronJob');
  const addInterval = jest.spyOn(SchedulerRegistry.prototype, 'addInterval');
  const moduleRef = await Test.createTestingModule({
    imports,
    providers: [ScheduleProbe],
  })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(DATA_EXPORT_ARCHIVE_STORE)
    .useValue({ kind: 'local' })
    .compile();
  // init() runs onModuleInit (explorers) and onApplicationBootstrap
  // (orchestrators mount the jobs into their registries).
  await moduleRef.init();
  const registries: SchedulerRegistry[] = [];
  for (const mod of moduleRef.get(ModulesContainer).values()) {
    if (mod.metatype !== ScheduleModule) continue;
    const wrapper = mod.getProviderByKey<SchedulerRegistry>(SchedulerRegistry);
    registries.push(wrapper.instance);
  }
  return { moduleRef, registries, addCronJob, addInterval };
}

function cronCount(b: Booted, name: string): number {
  return b.registries.filter((r) => r.getCronJobs().has(name)).length;
}

function intervalCount(b: Booted, name: string): number {
  return b.registries.filter((r) => r.getIntervals().includes(name)).length;
}

function callsFor(spy: jest.SpyInstance, name: string): number {
  return spy.mock.calls.filter((args) => args[0] === name).length;
}

describe('ScheduleModule single instance (B-CRON-126)', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // close() runs beforeApplicationShutdown: every mounted job is stopped.
    if (booted) await booted.moduleRef.close();
    booted = undefined;
    jest.restoreAllMocks();
  });

  it('wired like AppModule (root forRoot + real DataExportModule), each timed job registers once', async () => {
    booted = await boot([ScheduleModule.forRoot(), DataExportModule]);

    // On the old DataExportModule each of these counted 2.
    expect(cronCount(booted, PROBE_CRON)).toBe(1);
    expect(callsFor(booted.addCronJob, PROBE_CRON)).toBe(1);
    expect(intervalCount(booted, PROBE_INTERVAL)).toBe(1);
    expect(callsFor(booted.addInterval, PROBE_INTERVAL)).toBe(1);
    expect(booted.registries.length).toBe(1);
    // DataExportModule's own nightly job is registered once as well.
    expect(cronCount(booted, 'data-export-cleanup')).toBe(1);
    expect(callsFor(booted.addCronJob, 'data-export-cleanup')).toBe(1);
  });

  it('control: two root imports (the 10-06 production wiring) register every timed job twice', async () => {
    // Proves the counter above detects the bug: the same probe under two
    // root imports, as AppModule + the old DataExportModule produced.
    booted = await boot([ScheduleModule.forRoot(), ScheduleModule.forRoot()]);

    expect(booted.registries.length).toBe(2);
    expect(cronCount(booted, PROBE_CRON)).toBe(2);
    expect(intervalCount(booted, PROBE_INTERVAL)).toBe(2);
    expect(callsFor(booted.addCronJob, PROBE_CRON)).toBe(2);
  });

  it('DataExportModule does not import ScheduleModule itself', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', DataExportModule) ?? [];
    const scheduleImports = imports.filter(
      (entry) =>
        entry === ScheduleModule ||
        (typeof entry === 'object' &&
          entry !== null &&
          (entry as DynamicModule).module === ScheduleModule),
    );
    expect(scheduleImports.length).toBe(0);
  });
});

describe('ScheduleModule root import static guard (B-CRON-126)', () => {
  const root = join(__dirname, '..');
  const srcDir = join(root, 'src');
  const pattern = /ScheduleModule\s*\.\s*forRoot(?:Async)?\s*\(/g;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        out.push(...sourceFiles(full));
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('ScheduleModule.forRoot( appears exactly once in src, in src/app.module.ts', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const matches = readFileSync(file, 'utf8').match(pattern) ?? [];
      for (let i = 0; i < matches.length; i += 1) {
        hits.push(relative(root, file).split(sep).join('/'));
      }
    }
    expect(hits).toEqual(['src/app.module.ts']);
  });
});
