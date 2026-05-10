// Phase 7C — Leaderboard DTOs.
// Strict input validation keeps bad data from corrupting the score cache.

import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class OptInDto {
  /** true = appear on roster leaderboard; false = hide. */
  @IsBoolean()
  enabled!: boolean;

  /**
   * Optional public display name.
   * Max 40 chars to fit comfortably in the list row.
   * If omitted, the service derives "{firstName} {lastInitial}.".
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  displayName?: string;
}
