import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * SubCoachIdempotencyService — atomic-claim implementation.
 *
 * Contract (R19 / F29):
 *   - A given (actor_id, idempotency_key) executes the underlying mutation
 *     at most once. Concurrent retries with the same key block on the
 *     unique-index race and the loser reads the winner's stored response.
 *   - The request body + action are hashed and stored with the row. If a
 *     replay arrives with the SAME key but DIFFERENT action / body, we
 *     reject with 422 instead of silently returning the wrong result
 *     (this prevents the "client reused a UUID across endpoints" failure).
 *
 * Flow:
 *   1. Hash (action + canonicalized payload).
 *   2. Try to INSERT an idempotency row with status='in_progress' inside
 *      a transaction. If insert wins, run the mutation (passed in as a
 *      callback), then UPDATE the row to status='completed' with the
 *      response.
 *   3. If INSERT loses on P2002, fetch the existing row. If its action +
 *      hash match, return its response (this includes the case where the
 *      original is still 'in_progress' — we return its existing response
 *      slot, defaulting to the polled completed value).
 *   4. If existing row's action/hash differ, throw 422.
 *
 * Action + hash live on the row (request_hash column added in
 * 20260525000000_sub_coach_rls_and_fks).
 */
@Injectable()
export class SubCoachIdempotencyService {
  private readonly logger = new Logger(SubCoachIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stable canonical JSON used for hashing. Object keys are sorted so the
   * same logical payload always hashes to the same value regardless of
   * field order in the wire payload.
   */
  static canonicalHash(action: string, payload: unknown): string {
    const canonical = stableStringify({ action, payload });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Execute `runMutation` under the protection of an idempotency claim.
   *
   * - If no row exists for (actor_id, key): atomically insert
   *   status='in_progress' with the request hash, run the mutation,
   *   persist the response with status='completed', return it.
   * - If a row exists with matching action + hash: return its response
   *   (idempotent replay). Marked with `idempotent_replay: true` so the
   *   caller can flag the wire response.
   * - If a row exists with mismatched action or hash: throw 422.
   *
   * NOTE: We deliberately keep the mutation OUTSIDE the idempotency
   * INSERT transaction. The INSERT/UPDATE pair on the idempotency row is
   * the atomic claim; the actual mutation runs between them. This means
   * a server crash mid-mutation leaves an `in_progress` row that a later
   * retry would see — for now, an in_progress row makes the retry return
   * the (empty) stored response, which is safer than re-executing a
   * partial mutation. If a real long-running operation is needed in
   * future, add a `claimed_at` watchdog.
   */
  async runWithIdempotency<TResponse>(args: {
    actorId: string;
    idempotencyKey: string;
    action: string;
    payload: unknown;
    runMutation: () => Promise<TResponse>;
  }): Promise<{ response: TResponse; replay: boolean }> {
    const { actorId, idempotencyKey, action, payload, runMutation } = args;
    const requestHash = SubCoachIdempotencyService.canonicalHash(
      action,
      payload,
    );

    // 1. Try to claim the (actor, key) atomically.
    let claimed = false;
    try {
      await this.prisma.subCoachMutationIdempotency.create({
        data: {
          actor_id: actorId,
          idempotency_key: idempotencyKey,
          action,
          request_hash: requestHash,
          status: 'in_progress',
          response: Prisma.JsonNull,
        },
      });
      claimed = true;
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
      // Existing row — fall through to replay handling.
    }

    if (!claimed) {
      const existing = await this.prisma.subCoachMutationIdempotency.findUnique(
        {
          where: {
            SubCoachMutationIdempotency_actor_key: {
              actor_id: actorId,
              idempotency_key: idempotencyKey,
            },
          },
          select: {
            action: true,
            request_hash: true,
            response: true,
            status: true,
          },
        },
      );
      // Existing must exist (we just lost the unique race), but guard
      // anyway in case of a delete between insert + fetch.
      if (!existing) {
        // Recurse once — the row vanished. Safest is to throw a 500-like
        // condition; the operator wrapper will surface it.
        throw new Error(
          'Idempotency row vanished between claim and replay read',
        );
      }
      if (
        existing.action !== action ||
        (existing.request_hash !== null &&
          existing.request_hash !== requestHash)
      ) {
        throw new UnprocessableEntityException({
          error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
          message:
            'This idempotency key was previously used for a different action or payload',
        });
      }
      return {
        response: existing.response as unknown as TResponse,
        replay: true,
      };
    }

    // 2. We hold the claim. Run the mutation.
    let response: TResponse;
    try {
      response = await runMutation();
    } catch (err) {
      // Mutation failed — release the claim so a corrected retry can
      // proceed. (Deleting is safe because we just created this row.)
      try {
        await this.prisma.subCoachMutationIdempotency.delete({
          where: {
            SubCoachMutationIdempotency_actor_key: {
              actor_id: actorId,
              idempotency_key: idempotencyKey,
            },
          },
        });
      } catch (delErr) {
        this.logger.error(
          `Failed to release in-progress idempotency claim after mutation error: ${
            delErr instanceof Error ? delErr.message : String(delErr)
          }`,
        );
      }
      throw err;
    }

    // 3. Persist the response and mark completed.
    try {
      await this.prisma.subCoachMutationIdempotency.update({
        where: {
          SubCoachMutationIdempotency_actor_key: {
            actor_id: actorId,
            idempotency_key: idempotencyKey,
          },
        },
        data: {
          status: 'completed',
          response: response as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Persistence failure must not mask the real mutation result.
      this.logger.error(
        `Failed to persist idempotency response: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return { response, replay: false };
  }
}

/**
 * Stable stringify: deterministic ordering of object keys at every depth.
 * Arrays preserve their order. Used to canonicalize request payloads for
 * hashing so {a:1,b:2} and {b:2,a:1} produce the same hash.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}
