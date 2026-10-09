import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  BIO_MAX,
  BUSINESS_NAME_MAX,
  CLIENTS_TODAY,
  COACH_SPECIALTIES,
  COACHING_TOUCH,
  CONSULTATION_STEPS,
  DISPLAY_NAME_MAX,
  HEADLINE_MAX,
  MAX_SPECIALTIES,
  PROGRAMMING_STYLE,
  YEARS_COACHING_MAX,
  type ClientsToday,
  type CoachingTouch,
  type ConsultationStep,
  type ProgrammingStyle,
} from './coach-consultation.vocab';

// COACH-CONSULT-BE-134 — body of PUT /coach/consultation and
// POST /coach/consultation/complete. Every field is optional (a partial save);
// null clears an optional field. The global ValidationPipe (whitelist +
// forbidNonWhitelisted) rejects any other key. Required-ness is checked only at
// complete (display_name, clients_today), in the service.
export class CoachConsultationAnswersDto {
  @IsOptional()
  @IsIn(CONSULTATION_STEPS as readonly string[])
  step?: ConsultationStep;

  @IsOptional()
  @IsString()
  @MaxLength(DISPLAY_NAME_MAX)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BUSINESS_NAME_MAX)
  business_name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(HEADLINE_MAX)
  headline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(BIO_MAX)
  bio?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(YEARS_COACHING_MAX)
  years_coaching?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIALTIES)
  @IsIn(COACH_SPECIALTIES as readonly string[], { each: true })
  specialties?: string[] | null;

  @IsOptional()
  @IsIn(CLIENTS_TODAY as readonly string[])
  clients_today?: ClientsToday | null;

  @IsOptional()
  @IsIn(COACHING_TOUCH as readonly string[])
  coaching_touch?: CoachingTouch | null;

  @IsOptional()
  @IsIn(PROGRAMMING_STYLE as readonly string[])
  programming_style?: ProgrammingStyle | null;
}
