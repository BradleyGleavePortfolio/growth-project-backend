/**
 * Roman v1.1 background spend (R11-00): one admission path for every paid
 * background job (day summaries, notes from chats, coach playbook builds).
 *
 * Two bounds, both checked before any provider call, both fail closed:
 *  1. The head coach's monthly AI pool (owner decision D4 default): a job is
 *     admitted only when the pool can still pay its worst case, and its real
 *     cost is debited after it under the job's own capability. A client's
 *     turn limit is never touched. A payer with no pool (no coach) is bounded
 *     by the ceiling below only, the same rule as a Roman turn.
 *  2. A platform-wide daily ceiling for all background work together
 *     (ROMAN_BACKGROUND_DAILY_COST_CAP_USD, default 10), kept on the
 *     content-free AiRequestAudit ledger under the capabilities roman.memory
 *     and roman.playbook. It is separate from the chat ceiling (capability
 *     roman.chat), so background work can never use chat headroom.
 *
 * A refusal is a closed reason, never a throw: the scheduler skips the job
 * and tries again on its next run. Ledger rows carry token counts and
 * content-free metadata only, never prompt or reply text.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../../prisma.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { ROMAN_MODEL_PRICE_PER_MTOK } from '../anthropic-client.provider';
import {
  ROMAN_BACKGROUND_CAPABILITIES,
  ROMAN_BACKGROUND_DAILY_COST_CAP_USD_DEFAULT,
  type RomanBackgroundCapability,
} from '../roman.constants';
import { romanErrorTag, romanSanitizedError } from '../roman-error-tag';

/** pg_advisory_xact_lock namespace for background admission: ASCII 'rmbg'. */
export const ROMAN_BACKGROUND_LOCK_NAMESPACE = 0x72_6d_62_67;

/** Whose pool pays: a client's head coach, or a coach's own head coach. */
export type RomanBackgroundPayer =
  | { readonly kind: 'client'; readonly clientId: string }
  | { readonly kind: 'coach'; readonly coachId: string };

export interface RomanBackgroundReserveInput {
  readonly capability: RomanBackgroundCapability;
  readonly payer: RomanBackgroundPayer;
  readonly model: string;
  /** Upper bound of the request's input tokens (bytes of the payload are enough). */
  readonly inputTokenBound: number;
  readonly maxOutputTokens: number;
}

export interface RomanBackgroundReservation {
  readonly requestId: string;
  readonly capability: RomanBackgroundCapability;
  readonly model: string;
  /** Head coach whose pool pays; null when the payer has no pool. */
  readonly poolCoachId: string | null;
}

export type RomanBackgroundRefusal =
  'pool_empty' | 'pool_unavailable' | 'cap_reached' | 'ledger_unavailable';

export type RomanBackgroundAdmission =
  | { readonly admitted: true; readonly reservation: RomanBackgroundReservation }
  | { readonly admitted: false; readonly reason: RomanBackgroundRefusal };

const HIGHEST_PRICE = Object.values(ROMAN_MODEL_PRICE_PER_MTOK).reduce(
  (m, p) => ({ input: Math.max(m.input, p.input), output: Math.max(m.output, p.output) }),
  { input: 0, output: 0 },
);

@Injectable()
export class RomanBackgroundSpendService {
  private readonly logger = new Logger(RomanBackgroundSpendService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly budget: CoachAIBudgetService | null = null,
  ) {}

  /** The configured ceiling; an invalid value falls back to the default (never "no cap"). */
  dailyCapUsd(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.ROMAN_BACKGROUND_DAILY_COST_CAP_USD;
    if (raw === undefined || raw.trim() === '') return ROMAN_BACKGROUND_DAILY_COST_CAP_USD_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : ROMAN_BACKGROUND_DAILY_COST_CAP_USD_DEFAULT;
  }

  /** USD cost at the model's list price; an unknown model is priced at the highest rate. */
  static costUsd(model: string | null, inputTokens: number, outputTokens: number): number {
    const price = (model && ROMAN_MODEL_PRICE_PER_MTOK[model]) || HIGHEST_PRICE;
    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  }

  /**
   * Admit one background job: pool pre-check first (read only), then the
   * ceiling compare and the reservation insert under one advisory lock.
   */
  async reserve(input: RomanBackgroundReserveInput): Promise<RomanBackgroundAdmission> {
    const promptReserve = Math.max(0, Math.ceil(input.inputTokenBound));
    const outputReserve = Math.max(0, Math.ceil(input.maxOutputTokens));
    const reserveUsd = RomanBackgroundSpendService.costUsd(
      input.model,
      promptReserve,
      outputReserve,
    );

    let poolCoachId: string | null = null;
    if (this.budget) {
      try {
        poolCoachId = await this.poolCoachIdFor(this.budget, input.payer);
        if (poolCoachId) {
          const { budget } = await this.budget.canCharge(poolCoachId, 0);
          const worstCents = Math.ceil(reserveUsd * 100);
          if (budget.actual_used_cents + worstCents > budget.total_actual_available_cents) {
            this.logger.warn(`roman.background_pool_empty capability=${input.capability}`);
            return { admitted: false, reason: 'pool_empty' };
          }
        }
      } catch (err) {
        this.reportFailure('roman.background_pool_failed', err);
        return { admitted: false, reason: 'pool_unavailable' };
      }
    }

    const requestId = `roman-bg:${randomUUID()}`;
    const cap = this.dailyCapUsd();
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayKey = Math.floor(dayStart.getTime() / 86_400_000);
    let admitted: boolean;
    try {
      admitted = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROMAN_BACKGROUND_LOCK_NAMESPACE}::int4, ${dayKey}::int4)`;
        const rows = await tx.aiRequestAudit.groupBy({
          by: ['model'],
          where: {
            capability: { in: [...ROMAN_BACKGROUND_CAPABILITIES] },
            created_at: { gte: dayStart },
          },
          _sum: { prompt_token_estimate: true, response_token_estimate: true },
        });
        let used = 0;
        for (const r of rows) {
          used += RomanBackgroundSpendService.costUsd(
            r.model,
            r._sum.prompt_token_estimate ?? 0,
            r._sum.response_token_estimate ?? 0,
          );
        }
        if (used + reserveUsd > cap) return false;
        await tx.aiRequestAudit.create({
          data: {
            request_id: requestId,
            capability: input.capability,
            requester_id: payerId(input.payer),
            requester_role: 'system',
            subject_user_id: input.payer.kind === 'client' ? input.payer.clientId : null,
            tenant_coach_id: poolCoachId,
            provider: 'anthropic',
            model: input.model,
            enabled: true,
            prompt_token_estimate: promptReserve,
            response_token_estimate: outputReserve,
            metadata: { state: 'reserved' },
          },
        });
        return true;
      });
    } catch (err) {
      this.reportFailure('roman.background_ledger_failed', err);
      return { admitted: false, reason: 'ledger_unavailable' };
    }
    if (!admitted) {
      this.logger.warn(`roman.background_capacity_reached cap_usd=${cap}`);
      return { admitted: false, reason: 'cap_reached' };
    }
    return {
      admitted: true,
      reservation: { requestId, capability: input.capability, model: input.model, poolCoachId },
    };
  }

  /**
   * Replace the reservation with the real tokens, then debit the pool at
   * the exact cost (CREDIT-METER-130: the pool rounds once per period; a
   * cost above the remainder consumes the remainder). The provider call already happened, so failures are logged
   * and reported, never thrown; a failed settle keeps the reservation, which
   * only over-counts.
   */
  async settle(
    reservation: RomanBackgroundReservation,
    inputTokens: number,
    outputTokens: number,
    metadata: Record<string, string | number | boolean | string[] | null> = {},
  ): Promise<void> {
    try {
      await this.prisma.aiRequestAudit.update({
        where: { request_id: reservation.requestId },
        data: {
          prompt_token_estimate: inputTokens,
          response_token_estimate: outputTokens,
          metadata: { state: 'settled', ...metadata },
        },
      });
    } catch (err) {
      this.logger.warn(`roman.background_settle_failed: ${romanErrorTag(err)}`);
    }
    const coachId = reservation.poolCoachId;
    if (!coachId || !this.budget) return;
    const cents =
      RomanBackgroundSpendService.costUsd(reservation.model, inputTokens, outputTokens) * 100;
    if (cents <= 0) return;
    try {
      const debit = await this.budget.recordUsage({
        coachId,
        actualCostCents: cents,
        capability: reservation.capability,
        contextId: reservation.requestId,
      });
      if (debit.recorded) return;
      const { budget } = await this.budget.canCharge(coachId, 0);
      const rest = budget.total_actual_available_cents - budget.actual_used_cents;
      if (rest > 0) {
        await this.budget.recordUsage({
          coachId,
          actualCostCents: Math.min(rest, cents),
          capability: reservation.capability,
          contextId: reservation.requestId,
        });
      }
    } catch (err) {
      this.reportFailure('roman.background_pool_debit_failed', err);
    }
  }

  private async poolCoachIdFor(
    budget: CoachAIBudgetService,
    payer: RomanBackgroundPayer,
  ): Promise<string | null> {
    if (payer.kind === 'coach') return budget.resolveHeadCoachId(payer.coachId);
    const user = await this.prisma.user.findUnique({
      where: { id: payer.clientId },
      select: { coach_id: true },
    });
    return user?.coach_id ? budget.resolveHeadCoachId(user.coach_id) : null;
  }

  private reportFailure(event: string, err: unknown): void {
    this.logger.error(`${event}: ${romanErrorTag(err)}`);
    Sentry.captureException(romanSanitizedError(event, err), {
      tags: { feature: 'roman', op: 'roman.background' },
    });
  }
}

function payerId(payer: RomanBackgroundPayer): string {
  return payer.kind === 'client' ? payer.clientId : payer.coachId;
}
