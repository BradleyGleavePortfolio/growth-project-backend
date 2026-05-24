// src/coach/command-center/churn-intervention.dto.ts
//
// Class-validator DTOs for the tap→draft→approve→send churn intervention
// endpoints. The global ValidationPipe (whitelist + forbidNonWhitelisted)
// runs in main.ts so any unknown property is rejected at the boundary.

import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class GenerateChurnDraftDto {
  // Mobile-generated UUID for idempotency (R19).
  @IsUUID('4', { message: 'idempotency_key must be a valid UUID' })
  idempotency_key!: string;

  // Optional CoachAlert that triggered this intervention. Stored on
  // ChurnIntervention.alert_id for audit; not validated server-side as
  // an FK so a missing alert (already dismissed) doesn't block draft.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  alert_id?: string;
}

export class SendInterventionDto {
  // Final message text — may be the original draft or coach's edit.
  @IsString()
  @MinLength(1, { message: 'message_text must be at least 1 character' })
  @MaxLength(1000, { message: 'message_text must be at most 1000 characters' })
  message_text!: string;

  // Separate idempotency key from the draft (per send attempt).
  @IsUUID('4', { message: 'idempotency_key must be a valid UUID' })
  idempotency_key!: string;
}
