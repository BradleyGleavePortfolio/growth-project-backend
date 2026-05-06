import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type WinType =
  | 'logged_first_weight'
  | 'set_first_goal'
  | 'first_checkin'
  | 'first_meal';

const VALID_WIN_TYPES = new Set<WinType>([
  'logged_first_weight',
  'set_first_goal',
  'first_checkin',
  'first_meal',
]);

export function isValidWinType(value: unknown): value is WinType {
  return typeof value === 'string' && VALID_WIN_TYPES.has(value as WinType);
}

@Injectable()
export class FirstWinService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks the Day 1 Win as completed for the given user.
   *
   * Idempotent: if `first_win_completed_at` is already set the existing
   * timestamp is returned unchanged — no second write is made.
   *
   * @param userId - The internal User.id (UUID)
   * @param winType - The specific win action the client completed
   * @returns The stored completedAt timestamp
   */
  async complete(userId: string, winType: WinType): Promise<Date> {
    // Read current state first to avoid a write on every call (idempotency).
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { first_win_completed_at: true },
    });

    if (user.first_win_completed_at !== null) {
      // Already completed — return the original timestamp. No DB write.
      return user.first_win_completed_at;
    }

    const now = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        first_win_completed_at: now,
        // win_type is informational; stored on the update metadata below via
        // a fire-and-forget audit if needed. For now we keep the schema
        // minimal — the field is a timestamp only.
      },
    });

    return now;
  }

  /**
   * Returns whether the Day 1 Win has been completed and when.
   *
   * @param userId - The internal User.id (UUID)
   */
  async getStatus(
    userId: string,
  ): Promise<{ completed: boolean; completedAt: string | null }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { first_win_completed_at: true },
    });

    const completedAt = user.first_win_completed_at;
    return {
      completed: completedAt !== null,
      completedAt: completedAt ? completedAt.toISOString() : null,
    };
  }
}
