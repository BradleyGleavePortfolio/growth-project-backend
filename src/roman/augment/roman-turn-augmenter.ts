/**
 * Roman v1.1 turn-augmenter seam (R11-00).
 *
 * Later slices add per-turn system blocks (client memory, coach method)
 * through this seam instead of editing the turn core again. Each block sits
 * NEXT TO `<client_data>`, never inside it, in a fixed order: client_memory,
 * then coach_method.
 *
 * Contract:
 *  - Augmenters run only on grounded turns (client surface + student caller)
 *    that have a grounding bundle. The coach surface never calls them.
 *  - An augmenter reads data; it never calls a model and never spends.
 *  - A throw, a timeout or an empty block leaves that block out; the turn
 *    always continues. Failures are logged by class/code only, never content.
 *  - Zero augmenters (the default) = the turn and its prompt are exactly the
 *    pre-v1.1 ones.
 *
 * Registration: a slice provides its augmenter under its own kind token
 * (ROMAN_CLIENT_MEMORY_AUGMENTER or ROMAN_COACH_METHOD_AUGMENTER) in
 * RomanModule; `romanTurnAugmentersProvider` collects whichever are present
 * into ROMAN_TURN_AUGMENTERS. No token is provided on main, so the list is
 * empty.
 */

import type { FactoryProvider } from '@nestjs/common';
import type { RomanClientContextBundle } from '../context/roman-client-context.types';

export type RomanTurnAugmentKind = 'client_memory' | 'coach_method';

/** Fixed order of the blocks in the system prompt. */
export const ROMAN_TURN_AUGMENT_ORDER: readonly RomanTurnAugmentKind[] = [
  'client_memory',
  'coach_method',
];

/** Who the turn is for (the authenticated caller; structural, no import cycle). */
export interface RomanAugmentCaller {
  readonly id: string;
  readonly role: string;
}

/**
 * Deterministic reply checks a block asks for (consumed by the red-line
 * post-check slice). Phrases only, never client content.
 */
export interface RomanTurnAugmentPostCheck {
  readonly red_lines?: readonly string[];
  readonly avoid?: readonly string[];
}

export interface RomanTurnAugment {
  /** The rendered system block (its own delimited section). */
  readonly block: string;
  /** Content hash of the block; only this goes to the ledger, never the block. */
  readonly hash: string;
  readonly estimated_tokens: number;
  readonly post_check?: RomanTurnAugmentPostCheck;
}

export interface RomanTurnAugmenter {
  readonly kind: RomanTurnAugmentKind;
  augment(
    caller: RomanAugmentCaller,
    bundle: RomanClientContextBundle,
    userMessage: string,
  ): Promise<RomanTurnAugment | null>;
}

/** The collected augmenters (array; empty on main). */
export const ROMAN_TURN_AUGMENTERS = 'ROMAN_TURN_AUGMENTERS';
/** Provided by the client-memory slice (R11-M5). */
export const ROMAN_CLIENT_MEMORY_AUGMENTER = 'ROMAN_CLIENT_MEMORY_AUGMENTER';
/** Provided by the coach-method slice (R11-P4). */
export const ROMAN_COACH_METHOD_AUGMENTER = 'ROMAN_COACH_METHOD_AUGMENTER';

export const romanTurnAugmentersProvider: FactoryProvider<RomanTurnAugmenter[]> = {
  provide: ROMAN_TURN_AUGMENTERS,
  useFactory: (...found: Array<RomanTurnAugmenter | undefined | null>): RomanTurnAugmenter[] =>
    found.filter((a): a is RomanTurnAugmenter => !!a),
  inject: [
    { token: ROMAN_CLIENT_MEMORY_AUGMENTER, optional: true },
    { token: ROMAN_COACH_METHOD_AUGMENTER, optional: true },
  ],
};

/** One applied block, as the turn uses it. */
export interface RomanAppliedAugment {
  readonly kind: RomanTurnAugmentKind;
  readonly block: string;
  readonly hash: string;
  readonly estimated_tokens: number;
  readonly post_check?: RomanTurnAugmentPostCheck;
}

export interface RomanAugmentRun {
  /** Applied blocks in ROMAN_TURN_AUGMENT_ORDER. */
  readonly applied: readonly RomanAppliedAugment[];
  /** Kinds whose block was left out (threw, timed out, or empty). */
  readonly omitted: readonly RomanTurnAugmentKind[];
}

export type RomanAugmentFailure = {
  kind: RomanTurnAugmentKind;
  reason: 'timeout' | 'error';
  err?: unknown;
};

class AugmentTimeout extends Error {
  constructor() {
    super('augment_timeout');
    this.name = 'AugmentTimeout';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AugmentTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run every augmenter in parallel. Never throws: a failing, slow or empty
 * augmenter is reported through `onFailure` (no content) and left out.
 */
export async function runRomanTurnAugmenters(
  augmenters: readonly RomanTurnAugmenter[],
  caller: RomanAugmentCaller,
  bundle: RomanClientContextBundle,
  userMessage: string,
  opts: { timeoutMs: number; onFailure?: (f: RomanAugmentFailure) => void },
): Promise<RomanAugmentRun> {
  const results = await Promise.all(
    augmenters.map(async (a) => {
      try {
        const out = await withTimeout(
          Promise.resolve().then(() => a.augment(caller, bundle, userMessage)),
          opts.timeoutMs,
        );
        if (!out || typeof out.block !== 'string' || out.block.trim().length === 0) {
          return { kind: a.kind, out: null };
        }
        return { kind: a.kind, out };
      } catch (err) {
        opts.onFailure?.({
          kind: a.kind,
          reason: err instanceof AugmentTimeout ? 'timeout' : 'error',
          err: err instanceof AugmentTimeout ? undefined : err,
        });
        return { kind: a.kind, out: null };
      }
    }),
  );
  const applied: RomanAppliedAugment[] = [];
  const omitted: RomanTurnAugmentKind[] = [];
  for (const kind of ROMAN_TURN_AUGMENT_ORDER) {
    for (const r of results) {
      if (r.kind !== kind) continue;
      if (!r.out) {
        omitted.push(kind);
        continue;
      }
      applied.push({
        kind,
        block: r.out.block.trim(),
        hash: r.out.hash,
        estimated_tokens: r.out.estimated_tokens,
        ...(r.out.post_check ? { post_check: r.out.post_check } : {}),
      });
    }
  }
  return { applied, omitted };
}
