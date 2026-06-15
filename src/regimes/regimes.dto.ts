/**
 * DTOs for the F2 named-regimes module.
 *
 * class-validator DTOs (mirrors WorkoutBuilderModule) — the global
 * ValidationPipe enforces them before the controller body runs.
 */

import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class PromoteRegimeDto {
  // Optional independent display name set at promote time. When omitted the
  // regime falls back to WorkoutProgram.name in the UI.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  regime_display_name?: string;
}

export class UpdateRegimeDto {
  // The only field this endpoint owns. All other program fields edit via the
  // existing /workout-programs routes.
  @IsString()
  @MaxLength(120)
  regime_display_name!: string;
}

export class DecideRefundDto {
  // Coach decision on a pending partial-refund: keep the buyer's dripped
  // content, or unassign (cancel) their pending/due drops.
  @IsIn(['keep_drops', 'unassign_drops'])
  decision!: 'keep_drops' | 'unassign_drops';
}
