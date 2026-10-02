import { IsObject, IsString, MaxLength } from 'class-validator';

/**
 * PUT /me/onboarding/consultation body. `answers` is a partial patch keyed by
 * consultation screen key; each value is validated by
 * consultation-answers.ts (unknown keys -> 400 invalid_answers).
 */
export class SaveConsultationDto {
  @IsString()
  @MaxLength(20)
  version!: string;

  @IsObject()
  answers!: Record<string, unknown>;
}
