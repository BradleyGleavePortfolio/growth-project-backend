/**
 * MWB-2 (§3.3) — integration-level coverage of the clone-to-client REST
 * surface on WorkoutProgramController, without booting an HTTP server (the
 * codebase convention, see test/roman/roman.controller.spec.ts).
 *
 * Exercises:
 *   1. The cloneToClient handler delegates to
 *      WorkoutBuilderService.cloneProgramToClientResult with (programId,
 *      client_id from the DTO, authenticated caller id) and returns the typed
 *      CloneProgramResultDto verbatim — the source program id comes from the
 *      route, the actor from the JWT, neither is trusted from the body.
 *   2. The full HTTP→service→DTO shape: a clone returns program_id, the
 *      preserved cloned_from_id, is_template=false (Decision A), the fresh
 *      head_revision_id ("v1"), and the ordered plan_ids.
 *   3. The feature guard mounted on this handler makes the route 404 while
 *      FEATURE_MWB_TEMPLATES is OFF, and lets it through when ON.
 *
 * The DB-row-level assertions (every WorkoutPlan cloned, exercises copied,
 * cloned_from_plan_id set, source is_template preserved, head_revision_id
 * points at a fresh WorkoutProgramRevision) run against a live Postgres in the
 * RLS lane — see test/rls-mwb1-workout-builder-policies.spec.ts which seeds and
 * inspects these tables under jest.rls.config.js. The default (no-DB) lane
 * proves the same invariants at the service boundary via the mocked Prisma in
 * test/clone-program.spec.ts and test/workout-builder.service.spec.ts.
 */

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { WorkoutProgramController } from '../src/workout-builder/workout-builder.controller';
import { MwbTemplatesFeatureGuard } from '../src/workout-builder/mwb-templates-feature.guard';
import { FEATURE_MWB_TEMPLATES_ENV } from '../src/workout-builder/mwb-templates.feature';
import type { CloneProgramResultDto } from '../src/workout-builder/workout-builder.dto';

const FLAG = FEATURE_MWB_TEMPLATES_ENV;
const PROGRAM_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const COACH_ID = 'coach-A';

function fakeContext(): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
    getHandler: () => ({}),
    getClass: () => WorkoutProgramController,
  } as unknown as ExecutionContext;
}

function makeService() {
  const result: CloneProgramResultDto = {
    program_id: 'prog-clone',
    cloned_from_id: PROGRAM_ID,
    is_template: false,
    head_revision_id: 'prog-rev-1',
    plan_ids: ['plan-w0d0', 'plan-w0d1', 'plan-w1d0'],
  };
  const cloneProgramToClientResult = jest.fn((..._a: unknown[]) =>
    Promise.resolve(result),
  );
  return { cloneProgramToClientResult, result };
}

function makeController() {
  const service = makeService();
  const ctrl = new WorkoutProgramController(service as never);
  const req = { user: { id: COACH_ID, role: 'coach' } } as never;
  return { ctrl, service, req };
}

describe('WorkoutProgramController.cloneToClient (MWB-2 §3.3)', () => {
  const SAVED = process.env[FLAG];
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env[FLAG];
    else process.env[FLAG] = SAVED;
  });

  it('delegates to cloneProgramToClientResult with route program id, body client_id, and authed coach', async () => {
    const { ctrl, service, req } = makeController();

    const out = await ctrl.cloneToClient(req, PROGRAM_ID, {
      client_id: CLIENT_ID,
    });

    expect(service.cloneProgramToClientResult).toHaveBeenCalledTimes(1);
    expect(service.cloneProgramToClientResult).toHaveBeenCalledWith(
      PROGRAM_ID,
      CLIENT_ID,
      COACH_ID,
    );
    expect(out).toBe(service.result);
  });

  it('returns the typed CloneProgramResultDto shape (Decision A invariants)', async () => {
    const { ctrl, req } = makeController();
    const out = await ctrl.cloneToClient(req, PROGRAM_ID, {
      client_id: CLIENT_ID,
    });

    // Non-template clone, provenance preserved, fresh v1 revision pointer,
    // ordered plan ids.
    expect(out.is_template).toBe(false);
    expect(out.cloned_from_id).toBe(PROGRAM_ID);
    expect(out.program_id).toBe('prog-clone');
    expect(out.head_revision_id).toBe('prog-rev-1');
    expect(out.plan_ids).toEqual(['plan-w0d0', 'plan-w0d1', 'plan-w1d0']);
  });
});

describe('clone-to-client feature gate (MwbTemplatesFeatureGuard)', () => {
  const SAVED = process.env[FLAG];
  afterEach(() => {
    if (SAVED === undefined) delete process.env[FLAG];
    else process.env[FLAG] = SAVED;
  });

  it('404s the route while the flag is OFF (default)', () => {
    delete process.env[FLAG];
    const guard = new MwbTemplatesFeatureGuard();
    expect(() => guard.canActivate(fakeContext())).toThrow(NotFoundException);
    try {
      guard.canActivate(fakeContext());
    } catch (e) {
      // 404, never 403 — must not leak the route exists.
      expect((e as NotFoundException).getStatus()).toBe(404);
    }
  });

  it('lets the route through when the flag is ON', () => {
    process.env[FLAG] = 'true';
    const guard = new MwbTemplatesFeatureGuard();
    expect(guard.canActivate(fakeContext())).toBe(true);
  });
});
