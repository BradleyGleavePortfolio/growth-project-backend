/**
 * MWB-2 — FEATURE_MWB_TEMPLATES gating on the clone-to-client surface.
 *
 * Two layers must hold so the flag is a real server-side invariant, not a UI
 * hint (BUILDER_BRIEF §"Feature flag behavior"):
 *
 *   (1) Route guard: MwbTemplatesFeatureGuard throws 404 (NotFoundException)
 *       while the flag is OFF — never 403 — so the surface is indistinguishable
 *       from a non-existent route and its existence is not leaked. When the
 *       flag is exactly 'true' the guard returns true (lets the request
 *       through). Default (unset) is OFF.
 *
 *   (2) Wiring: the WorkoutProgramController's cloneToClient handler carries
 *       MwbTemplatesFeatureGuard at the handler level, while the existing
 *       MWB-1 fork / clone / assignProgram handlers do NOT (they stay live,
 *       pinned by workout-program-controller-entitlement.spec.ts). This static
 *       metadata assertion fails if a refactor strips the guard or
 *       accidentally widens it onto the whole class.
 *
 * The feature resolver itself (isMwbTemplatesEnabled) is also pinned to the
 * "exactly 'true'" rule, identical across environments — no dev/test
 * auto-enable, no silent environment-dependent behaviour.
 */

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  FEATURE_MWB_TEMPLATES_ENV,
  isMwbTemplatesEnabled,
} from '../src/workout-builder/mwb-templates.feature';
import { MwbTemplatesFeatureGuard } from '../src/workout-builder/mwb-templates-feature.guard';
import { WorkoutProgramController } from '../src/workout-builder/workout-builder.controller';

function ctx(): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({}) }),
    getHandler: () => () => undefined,
    getClass: () => WorkoutProgramController,
  } as unknown as ExecutionContext;
}

function handlerGuards(name: string): unknown[] {
  const proto = WorkoutProgramController.prototype as unknown as Record<
    string,
    unknown
  >;
  const handler = proto[name];
  return (
    (Reflect.getMetadata(GUARDS_METADATA, handler as object) as
      | unknown[]
      | undefined) ?? []
  );
}

function classGuards(): unknown[] {
  return (
    (Reflect.getMetadata(
      GUARDS_METADATA,
      WorkoutProgramController,
    ) as unknown[] | undefined) ?? []
  );
}

function includesGuard(list: unknown[], guard: { name: string }): boolean {
  return list.some(
    (g) =>
      g === guard ||
      (typeof g === 'function' && (g as { name?: string }).name === guard.name),
  );
}

describe('isMwbTemplatesEnabled (FEATURE_MWB_TEMPLATES resolver)', () => {
  it('is OFF when unset, empty, or any non-true value', () => {
    expect(isMwbTemplatesEnabled({})).toBe(false);
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: '' }),
    ).toBe(false);
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: '1' }),
    ).toBe(false);
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: 'yes' }),
    ).toBe(false);
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: 'false' }),
    ).toBe(false);
  });

  it("is ON only when the value is exactly 'true' (case-insensitive)", () => {
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: 'true' }),
    ).toBe(true);
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: 'TRUE' }),
    ).toBe(true);
    expect(
      isMwbTemplatesEnabled({ [FEATURE_MWB_TEMPLATES_ENV]: 'True' }),
    ).toBe(true);
  });
});

describe('MwbTemplatesFeatureGuard', () => {
  const guard = new MwbTemplatesFeatureGuard();
  const ORIGINAL = process.env[FEATURE_MWB_TEMPLATES_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FEATURE_MWB_TEMPLATES_ENV];
    else process.env[FEATURE_MWB_TEMPLATES_ENV] = ORIGINAL;
  });

  it('throws 404 (NotFound, not 403) when the flag is OFF by default', () => {
    delete process.env[FEATURE_MWB_TEMPLATES_ENV];
    expect(() => guard.canActivate(ctx())).toThrow(NotFoundException);
  });

  it('throws 404 when the flag is set to a non-true value', () => {
    process.env[FEATURE_MWB_TEMPLATES_ENV] = 'false';
    expect(() => guard.canActivate(ctx())).toThrow(NotFoundException);
  });

  it('returns true when the flag is exactly true', () => {
    process.env[FEATURE_MWB_TEMPLATES_ENV] = 'true';
    expect(guard.canActivate(ctx())).toBe(true);
  });
});

describe('WorkoutProgramController — clone-to-client guard wiring', () => {
  it('mounts MwbTemplatesFeatureGuard on the cloneToClient handler', () => {
    expect(
      includesGuard(handlerGuards('cloneToClient'), MwbTemplatesFeatureGuard),
    ).toBe(true);
  });

  it('does NOT mount the feature guard on the existing MWB-1 routes', () => {
    for (const handler of ['fork', 'clone', 'assignProgram']) {
      expect(
        includesGuard(handlerGuards(handler), MwbTemplatesFeatureGuard),
      ).toBe(false);
    }
  });

  it('does NOT widen the feature guard onto the whole class', () => {
    expect(includesGuard(classGuards(), MwbTemplatesFeatureGuard)).toBe(false);
  });
});
