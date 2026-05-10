import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

export class AssignSubCoachDto {
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  sub_coach_id!: string;
}
