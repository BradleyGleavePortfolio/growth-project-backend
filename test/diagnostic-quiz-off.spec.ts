import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';
import { INestApplication, Type } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { DiagnosticModule } from '../src/diagnostic/diagnostic.module';
import { DiagnosticController } from '../src/diagnostic/diagnostic.controller';
import { AiRoadmapService } from '../src/diagnostic/ai-roadmap.service';
import { buildOpenApiDocument } from '../src/common/openapi';

/**
 * B-QUIZ-OFF (owner 2026-10-01 15:25): the 40-point diagnostic quiz belongs
 * to TGP Finance, so it is switched off in this fitness backend. Its module
 * is not mounted, so none of its public routes (GET /diagnostic/questions,
 * POST /diagnostic/submit, GET /diagnostic/:id) exist and its AI roadmap
 * call cannot run. Its tables are kept (no drops).
 *
 * This spec compiles and boots the real AppModule (same path as
 * module-graph.spec.ts and openapi-spec.spec.ts) and proves:
 *   1. DiagnosticModule is not reachable from AppModule's import graph and is
 *      not in the live container;
 *   2. no registered controller serves a /diagnostic path, and the
 *      DiagnosticController / AiRoadmapService are not instantiated;
 *   3. over HTTP, every former diagnostic route answers 404 (positive
 *      control: GET /healthz on the same server answers 200);
 *   4. the OpenAPI document no longer publishes any /diagnostic path.
 */

type ModuleEntry = Type<unknown> | { module?: Type<unknown>; forwardRef?: () => unknown } | undefined;

function resolveImport(entry: ModuleEntry): Type<unknown> | null {
  if (!entry) return null;
  if (typeof (entry as { forwardRef?: unknown }).forwardRef === 'function') {
    return resolveImport((entry as { forwardRef: () => ModuleEntry }).forwardRef());
  }
  if (typeof entry === 'object' && 'module' in entry && entry.module) return entry.module;
  if (typeof entry === 'function') return entry;
  return null;
}

function authoredModules(root: Type<unknown>): Set<Type<unknown>> {
  const seen = new Set<Type<unknown>>();
  const queue: Type<unknown>[] = [root];
  while (queue.length > 0) {
    const mod = queue.shift() as Type<unknown>;
    if (seen.has(mod)) continue;
    seen.add(mod);
    const raw = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? []) as ModuleEntry[];
    for (const entry of raw) {
      const target = resolveImport(entry);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function controllerPaths(controller: Type<unknown>): string[] {
  const raw = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
  const list = Array.isArray(raw) ? raw : [raw ?? ''];
  return list.map((p) => p.replace(/^\/+/, ''));
}

describe('B-QUIZ-OFF: the TGP Finance diagnostic quiz is switched off in the fitness backend', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let container: ModulesContainer;
  let openApiPaths: string[] = [];
  let baseUrl = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    container = moduleRef.get(ModulesContainer);
    app = moduleRef.createNestApplication();
    await app.init();
    openApiPaths = Object.keys(buildOpenApiDocument(app).paths ?? {});
    // Real HTTP on an ephemeral loopback port, closed in afterAll.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  });

  it('DiagnosticModule is not in the authored import graph of AppModule', () => {
    const mods = authoredModules(AppModule);
    // Sanity: the walk really covers the app (cannot pass vacuously).
    expect(mods.size).toBeGreaterThan(20);
    expect([...mods].map((m) => m.name)).not.toContain('DiagnosticModule');
    expect(mods.has(DiagnosticModule)).toBe(false);
  });

  it('the live container holds no diagnostic module, controller or roadmap provider', () => {
    const modules = [...container.values()];
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.some((m) => m.metatype === DiagnosticModule)).toBe(false);
    const controllers = modules.flatMap((m) => [...m.controllers.keys()]);
    const providers = modules.flatMap((m) => [...m.providers.keys()]);
    expect(controllers.length).toBeGreaterThan(20);
    expect(controllers).not.toContain(DiagnosticController);
    expect(providers).not.toContain(AiRoadmapService);
    const servingDiagnostic = modules
      .flatMap((m) => [...m.controllers.values()])
      .map((wrapper) => wrapper.metatype as Type<unknown>)
      .filter((ctrl) => controllerPaths(ctrl).some((p) => p === 'diagnostic' || p.startsWith('diagnostic/')))
      .map((ctrl) => ctrl.name);
    expect(servingDiagnostic).toEqual([]);
  });

  it.each([
    ['GET', '/diagnostic/questions'],
    ['POST', '/diagnostic/submit'],
    ['GET', '/diagnostic/7f9c2a4e-1b3d-4c5e-8f6a-0b1c2d3e4f50'],
  ])('%s %s answers 404 (route not mounted)', async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ email: 'lead@example.com', answers: [] }) : undefined,
    });
    expect(res.status).toBe(404);
  });

  it('positive control: a mounted public route of the same app answers 200', async () => {
    // GET /healthz is @Public and needs no database, so the 404s above come
    // from the missing routes, not from a server that answers 404 to all.
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('the OpenAPI document publishes no /diagnostic path', () => {
    expect(openApiPaths.length).toBeGreaterThan(20);
    expect(openApiPaths.filter((p) => /^\/diagnostic(\/|$)/.test(p))).toEqual([]);
  });
});
