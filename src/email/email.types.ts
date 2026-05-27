// Canonical email template keys. Each maps to a Handlebars template under
// src/email/templates/<key>.hbs and a sender helper on EmailService. Keep
// these strings stable — they appear in EmailSendLog rows and in audit
// metadata, so renaming requires a backfill.
export const EmailTemplateKey = {
  // NUDGE-V1 — behavioral re-engagement (one template per trigger).
  // Tone: calm, premium, lifestyle. Never guilt. One CTA, one-tap unsubscribe.
  // Placed at top of the record to avoid textual-merge collision with
  // PR #281 (dunning-v1) which appends after DUNNING_FINAL. Both blocks
  // are independent hunks; merge order is irrelevant.
  NUDGE_MISSED_CHECKIN: 'nudge-missed-checkin',
  NUDGE_STREAK_BROKEN: 'nudge-streak-broken',
  NUDGE_ONBOARDING_ABANDONED: 'nudge-onboarding-abandoned',
  NUDGE_INACTIVE: 'nudge-inactive',
  // ─── existing template keys below; append new keys above the legacy block ───
  COACH_INVITES_CLIENT: 'coach-invites-client',
  PAYMENT_REMINDER: 'payment-reminder',
  PAYMENT_FAILED: 'payment-failed',
  COACH_ONBOARDING_WELCOME: 'coach-onboarding-welcome',
  CLIENT_ONBOARDING_WELCOME: 'client-onboarding-welcome',
  WEEKLY_DIGEST: 'weekly-digest',
  PAYMENT_RECEIPT: 'payment-receipt',
  DUNNING_FINAL: 'dunning-final',
} as const;
export type EmailTemplateKey =
  (typeof EmailTemplateKey)[keyof typeof EmailTemplateKey];

// Send-status terminology used in EmailSendLog and the SendEmailResult.
//   sent     — provider accepted the payload
//   skipped  — idempotency hit (same idempotency_key already sent)
//   failed   — provider error or invalid input; logged but surfaced to caller
//   logged   — EMAIL_TRANSPORT=log (dev mode) — payload printed, not sent
export type EmailSendStatus = 'sent' | 'skipped' | 'failed' | 'logged';

export interface SendEmailInput {
  to: string;
  template: EmailTemplateKey;
  data: Record<string, unknown>;
  // Stable opaque key used to deduplicate sends. Required: callers must
  // pick a deterministic value (e.g. `invite:<invite_code_id>`) so that a
  // retry never produces a duplicate email. See EmailSendLog model.
  idempotencyKey: string;
  // Optional override for the From: address. Defaults to EMAIL_FROM_ADDRESS.
  from?: string;
  // Optional reply-to header; falls back to provider default if unset.
  replyTo?: string;
}

export interface SendEmailResult {
  status: EmailSendStatus;
  // Provider-side id (Resend message id) when status==='sent'. Null on
  // 'skipped' or 'logged'. Useful for support traces.
  providerMessageId: string | null;
  // Mirrored from input.idempotencyKey for caller convenience.
  idempotencyKey: string;
  // Human-readable error text on 'failed'. Never contains the provider
  // API key. Safe to surface up to the operator.
  error?: string;
}
