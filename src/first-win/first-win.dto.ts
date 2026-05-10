import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const WIN_TYPES = [
  'logged_first_weight',
  'set_first_goal',
  'first_checkin',
  'first_meal',
] as const;

export type WinType = (typeof WIN_TYPES)[number];

export class CompleteFirstWinDto {
  @ApiProperty({
    enum: WIN_TYPES,
    description:
      'The specific quick-win action the client completed on their first app open.',
    example: 'logged_first_weight',
  })
  @IsIn(WIN_TYPES)
  winType!: WinType;
}
