import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

// B4 — runtime validation for POST /v1/admin/coaches/:id/start-subscription.
// The handler previously accepted an inline `{ plan?; trialDays? }` type with
// no runtime guard, so a malformed `plan` or out-of-range `trialDays` reached
// the Stripe-write path. The only valid plan today is the flat_300 tier; the
// controller still clamps trialDays defensively, but the DTO rejects bad input
// at the boundary (via the global ValidationPipe) before any Stripe call.
const START_SUBSCRIPTION_PLANS = ['flat_300'] as const;

export class StartSubscriptionDto {
  @IsOptional()
  @IsIn(START_SUBSCRIPTION_PLANS as unknown as string[])
  plan?: 'flat_300';

  // 0..90 trial days. 0 means "no trial" (the controller maps it to
  // undefined so Stripe applies the default).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number;
}
