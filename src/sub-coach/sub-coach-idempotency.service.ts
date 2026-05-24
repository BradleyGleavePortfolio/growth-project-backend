import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * SubCoachIdempotencyService
 *
 * Persists (actor_id, idempotency_key) -> response for sub-coach
 * mutation endpoints. First write wins; later retries with the same
 * key read the stored response back instead of re-executing the
 * mutation. Implements R19 / F29.
 *
 * Storage is keyed by actor so two different users cannot collide by
 * choosing the same UUID.
 */
@Injectable()
export class SubCoachIdempotencyService {
  private readonly logger = new Logger(SubCoachIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Look up a previously stored response for this actor + key. */
  async findExisting<T>(
    actorId: string,
    idempotencyKey: string,
  ): Promise<T | null> {
    const row = await this.prisma.subCoachMutationIdempotency.findUnique({
      where: {
        SubCoachMutationIdempotency_actor_key: {
          actor_id: actorId,
          idempotency_key: idempotencyKey,
        },
      },
      select: { response: true },
    });
    if (!row) return null;
    return row.response as unknown as T;
  }

  /**
   * Persist a (actor, key, action, response) row. If a row already
   * exists for this (actor, key) — concurrent retry committed first —
   * return the existing response so the caller can return it instead.
   */
  async store<T>(
    actorId: string,
    idempotencyKey: string,
    action: string,
    response: T,
  ): Promise<T> {
    try {
      await this.prisma.subCoachMutationIdempotency.create({
        data: {
          actor_id: actorId,
          idempotency_key: idempotencyKey,
          action,
          response: response as unknown as Prisma.InputJsonValue,
        },
      });
      return response;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.findExisting<T>(actorId, idempotencyKey);
        if (existing) return existing;
      }
      // Idempotency persistence failure must not mask the real mutation
      // result; surface to logs and return the response we computed.
      this.logger.error(
        `Failed to persist idempotency row: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return response;
    }
  }
}
