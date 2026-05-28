import { ApiProperty } from '@nestjs/swagger';

// DTO for GET /coach/ai/budget. Spec §5.
//
// Every numeric field is in **cents**. The mobile client computes the
// displayed dollar string with the device locale; the server never sends
// formatted money strings. Multiplier is serialised as `string` to avoid
// JS Number drift on the boundary (the schema column is Decimal(6,3)).

export class CustomPackBoundsDto {
  @ApiProperty({ example: 1000, description: 'Minimum custom pack in cents ($10).' })
  min!: number;

  @ApiProperty({ example: 50_000, description: 'Maximum custom pack in cents ($500).' })
  max!: number;
}

export class CoachAiBudgetResponseDto {
  @ApiProperty({ format: 'date-time', example: '2026-05-01T00:00:00.000Z' })
  period_start!: string;

  @ApiProperty({ format: 'date-time', example: '2026-05-31T00:00:00.000Z' })
  period_end!: string;

  @ApiProperty({ example: 12500, description: 'Displayed base allowance in cents ($125).' })
  base_displayed_cents!: number;

  @ApiProperty({ example: 2500, description: 'Sum of pack face-values this period in cents.' })
  pack_displayed_cents!: number;

  @ApiProperty({ example: 15000, description: 'base_displayed + pack_displayed.' })
  total_displayed_cents!: number;

  @ApiProperty({ example: 9375, description: 'Displayed used = actual_used * multiplier.' })
  used_displayed_cents!: number;

  @ApiProperty({ example: 5625 })
  remaining_displayed_cents!: number;

  @ApiProperty({ example: 62.5, description: 'Percent used (0-100, one decimal).' })
  pct_used!: number;

  @ApiProperty({ example: 4000, description: 'Hard actual ceiling in cents ($40).' })
  base_actual_cents!: number;

  @ApiProperty({
    example: '3.125',
    description: 'Decimal(6,3) value multiplier serialised as string for cross-runtime safety.',
  })
  value_multiplier!: string;

  @ApiProperty({ example: 3000, description: 'Actual Anthropic cents spent this period.' })
  actual_used_cents!: number;

  @ApiProperty({
    type: [Number],
    example: [1000, 2500, 9900],
    description: 'Locked pack tier face-values in cents ($10 / $25 / $99).',
  })
  pack_options_cents!: number[];

  @ApiProperty({ type: CustomPackBoundsDto })
  custom_pack_bounds_cents!: CustomPackBoundsDto;
}
