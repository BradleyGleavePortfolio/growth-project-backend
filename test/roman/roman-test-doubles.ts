// test/roman/roman-test-doubles.ts
//
// Typed escape hatches for the Roman unit specs. Each helper narrows a partial
// structural mock to the production type the service under test expects, via
// the R0-sanctioned `@ts-expect-error` + reason form (see
// src/regimes/__tests__/prisma-test-double.ts). The specs stub only the
// delegates the code under test reads, with no unchecked type assertions.

import type Anthropic from '@anthropic-ai/sdk';
import type { RomanSession } from '@prisma/client';
import type { Request, Response } from 'express';
import type { PrismaService } from '../../src/prisma.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { RomanModelHealthService } from '../../src/roman/model/roman-model-health.service';

export function asPrismaDouble<T extends object>(mock: T): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — the specs stub only the delegates the service reads.
  return mock;
}

export function asAnthropicDouble<T extends object>(mock: T): Anthropic {
  // @ts-expect-error partial structural mock of the Anthropic SDK client — only messages.stream / messages.create are stubbed.
  return mock;
}

export function asSessionDouble<T extends object>(mock: T): RomanSession {
  // @ts-expect-error partial structural mock of a RomanSession row.
  return mock;
}

export function asAuthedRequestDouble<T extends object>(mock: T): Request & AuthedRequest {
  // @ts-expect-error partial structural mock of an authenticated express Request (user + close listeners only).
  return mock;
}

export function asResponseDouble<T extends object>(mock: T): Response {
  // @ts-expect-error partial structural mock of an express Response (writeHead/write/end/status only).
  return mock;
}

export function asHealthDouble<T extends object>(mock: T): RomanModelHealthService {
  // @ts-expect-error partial structural mock of RomanModelHealthService.
  return mock;
}
