// HK-6a R2 (P1-1) test helpers for the wearable-insights controller suite.
//
// These typed factories replace the type-laundering casts the R1 builder used
// (the R0-banned escape hatches). Each double is a narrowly-typed `Pick<X, ...>`
// that names EXACTLY the methods/fields the controller exercises, so a reviewer
// can see what is and is not stubbed. The boundary widening to the concrete
// service type is done once, here, via explicit structural `Pick<X, ...> -> X`
// assertions. That is the documented Pattern B fallback: each assertion is
// explicit about which narrow shape is being widened and is not a laundering
// cast that hides every assumption. (`@golevelup/ts-jest` is not a dependency
// of this repo, so the `DeepMocked` Pattern A path is unavailable.)

import type { WearableInsightsService } from './wearable-insights.service';
import type { AiApprovalService } from '../../ai/gateway/ai-approval.service';
import type { PrismaService } from '../../prisma.service';
import type { AuthedRequest } from '../../auth/auth-request';
import { WearableInsightsController } from './wearable-insights.controller';

// The exact slice of WearableInsightsService the controller calls. Assignable
// to WearableInsightsService via a single `as` because it is a Pick of it.
export type WearableInsightsServiceDouble = jest.Mocked<
  Pick<
    WearableInsightsService,
    'assertCoachOwnsClient' | 'generateForCoach' | 'generateForClient'
  >
>;

export interface ApprovalDeps {
  approvals: AiApprovalService;
  decide: jest.Mock;
  prisma: PrismaService;
  create: jest.Mock;
}

// Builds a typed WearableInsightsService double with the three methods the
// controller calls pre-stubbed to sensible defaults the caller can override.
export function makeServiceDouble(
  defaults: {
    coachInsight: Awaited<ReturnType<WearableInsightsService['generateForCoach']>>;
    clientInsight: Awaited<ReturnType<WearableInsightsService['generateForClient']>>;
  },
): WearableInsightsServiceDouble {
  return {
    assertCoachOwnsClient: jest.fn().mockResolvedValue(undefined),
    generateForCoach: jest.fn().mockResolvedValue(defaults.coachInsight),
    generateForClient: jest.fn().mockResolvedValue(defaults.clientInsight),
  };
}

// Builds a fully-typed approve dependency bundle. `decide` resolves the given
// row (the draft decide() reads back); `create` resolves a draft with a fixed
// id so the test owns the wire `draft_id`.
export function makeApprovalDeps(
  draftId: string,
  decideResult: Record<string, unknown>,
): ApprovalDeps {
  const create = jest.fn().mockResolvedValue({ id: draftId });
  const decide = jest.fn().mockResolvedValue(decideResult);

  // Narrow doubles. `aiActionDraft` is narrowed to the one method the
  // controller calls (`create`) and widened to the full delegate type with an
  // explicit assertion; the whole object is then a `Pick` of PrismaService.
  const prismaDouble: Pick<PrismaService, 'aiActionDraft'> = {
    aiActionDraft: { create } as Pick<
      PrismaService['aiActionDraft'],
      'create'
    > as PrismaService['aiActionDraft'],
  };
  const approvalsDouble: Pick<AiApprovalService, 'decide'> = { decide };

  return {
    create,
    decide,
    prisma: prismaDouble as PrismaService,
    approvals: approvalsDouble as AiApprovalService,
  };
}

// Centralised controller construction. The three constructor parameters are
// widened from their narrow test doubles here, in one place, so the rest of
// the suite never casts. When `approvals`/`prisma` are not exercised by a test
// (the GET paths), an explicit empty typed Pick double is passed.
export function makeController(overrides: {
  svc: WearableInsightsServiceDouble;
  approvals?: AiApprovalService;
  prisma?: PrismaService;
}): WearableInsightsController {
  const approvalsDouble: Pick<AiApprovalService, 'decide'> = {
    decide: jest.fn(),
  };
  const prismaDouble: Pick<PrismaService, 'aiActionDraft'> = {
    aiActionDraft: { create: jest.fn() } as Pick<
      PrismaService['aiActionDraft'],
      'create'
    > as PrismaService['aiActionDraft'],
  };
  // Widen the jest.Mocked Pick double to the concrete service via its
  // underlying Pick shape (the mock wrappers make a direct widening ambiguous,
  // so we route through the structural Pick first).
  const svcWide = overrides.svc as Pick<
    WearableInsightsService,
    'assertCoachOwnsClient' | 'generateForCoach' | 'generateForClient'
  > as WearableInsightsService;
  return new WearableInsightsController(
    svcWide,
    overrides.approvals ?? (approvalsDouble as AiApprovalService),
    overrides.prisma ?? (prismaDouble as PrismaService),
  );
}

// Minimal authed request the controller reads (`user.id`, `user.role`). The
// AuthedRequest type carries the full Express request surface, but the
// controller only touches `user` and the header/ip extractors; we name the
// fields we set and widen once via a Pick.
export function makeAuthedRequest(role: string, id: string): AuthedRequest {
  const partial: Pick<AuthedRequest, 'user'> = {
    user: { id, role } as AuthedRequest['user'],
  };
  return partial as AuthedRequest;
}
