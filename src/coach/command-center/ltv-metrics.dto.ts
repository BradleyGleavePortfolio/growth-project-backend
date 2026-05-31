// src/coach/command-center/ltv-metrics.dto.ts
//
// DTOs for GET /coach/command-center/ltv-metrics.
// All monetary values are in the coach's default currency (typically USD).

import { ApiProperty } from '@nestjs/swagger';

export class NextMilestoneDto {
  @ApiProperty({
    description:
      'How many more active recurring clients are needed to hit the next ' +
      'round MRR milestone (e.g. +2 clients to reach $3,000 MRR). ' +
      'Zero if the coach already exceeds the nearest milestone.',
    example: 2,
  })
  clients_needed!: number;

  @ApiProperty({
    description:
      'The target MRR value (in cents) for the next milestone. ' +
      'Computed as the next round milestone above current MRR (e.g. $1k, $2k, $5k, $10k).',
    example: 300000,
  })
  mrr_target_cents!: number;

  @ApiProperty({
    description:
      'Human-readable label for the milestone (e.g. "$3,000 / mo").',
    example: '$3,000 / mo',
  })
  mrr_target_label!: string;
}

export class LtvMetricsResponseDto {
  // ─── Core MRR ──────────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Monthly Recurring Revenue in cents. ' +
      'Computed as the sum of amount_cents × (12 / interval_count) / 12 for all ' +
      'active recurring ClientPurchase rows belonging to this coach ' +
      '(status=active, billing_type=recurring). ' +
      'One-time packages are excluded (they are not recurring revenue).',
    example: 250000,
  })
  mrr_cents!: number;

  @ApiProperty({ description: 'MRR formatted as a currency string.', example: '$2,500' })
  mrr_label!: string;

  @ApiProperty({
    description: 'Number of clients with an active, non-canceled ClientPurchase (any billing type).',
    example: 12,
  })
  active_client_count!: number;

  // ─── RPCM — Revenue Per Client Per Month ───────────────────────────────────

  @ApiProperty({
    description:
      'Average Revenue Per Client Per Month in cents. ' +
      'Formula: mrr_cents / max(active_client_count, 1). ' +
      'This is the coach\'s core LTV lever — the number to fixate on and grow.',
    example: 20833,
  })
  revenue_per_client_month_cents!: number;

  @ApiProperty({
    description: 'RPCM formatted as a currency string.',
    example: '$208',
  })
  revenue_per_client_month_label!: string;

  // ─── LTV ───────────────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Average client lifespan in months. ' +
      'Computed from canceled recurring purchases: ' +
      'mean( (canceled_at - created_at) in months ) for the last 90 days of cancellations. ' +
      'Falls back to 6 months if there are fewer than 3 cancellations (stub; see comment).',
    example: 7.2,
  })
  avg_client_lifespan_months!: number;

  @ApiProperty({
    description:
      'True when avg_client_lifespan_months is a stub (fewer than 3 cancellations). ' +
      'Frontend should display an “estimated” label when this flag is set.',
    example: true,
  })
  lifespan_is_estimate!: boolean;

  @ApiProperty({
    description:
      'Human-readable note explaining why the lifespan is estimated. ' +
      'Only present when lifespan_is_estimate is true.',
    example: 'Based on industry average (fewer than 3 cancellations recorded)',
    nullable: true,
  })
  lifespan_estimate_note!: string | null;

  @ApiProperty({
    description:
      'Estimated average client LTV in cents. ' +
      'Formula: revenue_per_client_month_cents × avg_client_lifespan_months. ' +
      'Value is approximate when lifespan_is_estimate is true.',
    example: 150000,
  })
  estimated_ltv_cents!: number;

  @ApiProperty({ description: 'LTV formatted as a currency string.', example: '$1,500' })
  estimated_ltv_label!: string;

  @ApiProperty({
    description:
      'LTV-1: True when estimated_ltv_cents is itself an estimate — i.e. it was ' +
      'derived from a stubbed/industry-average client lifespan (fewer than 3 ' +
      'cancellations), not from real churn data. The frontend MUST label the LTV ' +
      'as an estimate (not a hard dollar figure) when this is true. Mirrors ' +
      'lifespan_is_estimate today, but is exposed separately so the LTV card can ' +
      'carry its own honesty label.',
    example: true,
  })
  estimated_ltv_is_estimate!: boolean;

  @ApiProperty({
    description:
      'Human-readable note explaining why estimated_ltv_cents is an estimate. ' +
      'Only present (non-null) when estimated_ltv_is_estimate is true.',
    example:
      'Estimated LTV — derived from an estimated client lifespan. Based on industry average (only 1 cancellation recorded — need ≥3 for a real average)',
    nullable: true,
  })
  estimated_ltv_estimate_note!: string | null;

  // ─── Churn ─────────────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Monthly churn rate as a percentage (0–100). ' +
      'Formula: (clients canceled this calendar month) / (clients at start of month) × 100. ' +
      'Only recurring purchases are counted; one-time package expirations are excluded.',
    example: 8.3,
  })
  churn_rate_pct!: number;

  // ─── NRR ───────────────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Net Revenue Retention as a percentage (0–200+). ' +
      'STUB: gross_logo_retention approximation (1 - churn_rate). ' +
      'True NRR requires expansion/contraction MRR data not yet available. ' +
      'Will be accurate once upgrade/downgrade events are tracked. ' +
      'See nrr_is_stub flag.',
    example: 91.7,
  })
  net_revenue_retention_pct!: number;

  @ApiProperty({
    description:
      'True when net_revenue_retention_pct is a gross-logo-retention stub ' +
      '(1 - churn_rate), not true Net Revenue Retention. ' +
      'Frontend should display a disclaimer when this is true.',
    example: true,
  })
  nrr_is_stub!: boolean;

  // ─── Projections ───────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Projected Annual Revenue in cents. Simple formula: mrr_cents × 12. ' +
      'Assumes flat MRR — this is a baseline floor, not a growth projection.',
    example: 3000000,
  })
  projected_annual_revenue_cents!: number;

  @ApiProperty({
    description: 'Projected Annual Revenue formatted as a currency string.',
    example: '$30,000',
  })
  projected_annual_revenue_label!: string;

  // ─── MRR Trend ─────────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      '"up" if current MRR is >= 5% higher than 30 days ago. ' +
      '"down" if >= 5% lower. "flat" otherwise. ' +
      'Drives green/amber/red color coding in the mobile UI.',
    enum: ['up', 'flat', 'down'],
    example: 'up',
  })
  mrr_trend!: 'up' | 'flat' | 'down';

  @ApiProperty({
    description:
      'MRR 30 days ago (in cents). Used to compute mrr_trend and the delta label in the UI.',
    example: 230000,
  })
  mrr_30d_ago_cents!: number;

  // ─── Gamification ──────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Consecutive months with zero churn (no recurring subscription canceled ' +
      'in the calendar month). Resets to 0 the month any recurring client cancels. ' +
      'Duolingo-style streak mechanic.',
    example: 3,
  })
  zero_churn_streak_months!: number;

  @ApiProperty({
    description:
      'All-time highest RPCM ever recorded for this coach (in cents). ' +
      'LTV-3: persisted in the coach_ltv_peak table (source of truth). ' +
      'newPeak = max(persisted_peak, current_rpcm); the persisted value never ' +
      'regresses across the month boundary.',
    example: 22000,
  })
  all_time_peak_rpcm_cents!: number;

  @ApiProperty({ description: 'All-time peak RPCM formatted as a currency string.', example: '$220' })
  all_time_peak_rpcm_label!: string;

  @ApiProperty({
    description:
      'True when all_time_peak_rpcm_cents is a best-effort estimate rather than a ' +
      'persisted historical maximum. LTV-3: now always false — the value is ' +
      'persisted in coach_ltv_peak. Retained for API compatibility.',
    example: false,
  })
  peak_rpcm_is_estimate!: boolean;

  @ApiProperty({
    description:
      'True if current RPCM STRICTLY exceeds the persisted all-time peak (a ' +
      'genuinely new record) — triggers a "New Record" badge in the UI. ' +
      'False when current RPCM only ties or is below the persisted peak.',
    example: false,
  })
  is_new_rpcm_record!: boolean;

  // ─── LTV:CAC Placeholder ───────────────────────────────────────────────────

  @ApiProperty({
    description:
      'LTV-to-CAC ratio. Numerator = estimated_ltv_cents. ' +
      'Denominator = null (CAC requires manual input from the coach; not yet modeled). ' +
      'The mobile UI surfaces the LTV and a note that CAC can be entered in Settings.',
    nullable: true,
    example: null,
  })
  ltv_cac_ratio!: number | null;

  // ─── Next Milestone ────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Nudge card: how many more clients at current ARPC are needed to hit ' +
      'the next round MRR milestone.',
    type: () => NextMilestoneDto,
  })
  next_milestone!: NextMilestoneDto;

  // ─── Currency ──────────────────────────────────────────────────────────────

  @ApiProperty({ description: 'ISO 4217 currency code.', example: 'usd' })
  currency!: string;

  @ApiProperty({
    description: 'ISO 8601 timestamp of when these metrics were computed.',
    example: '2026-06-05T12:00:00.000Z',
  })
  computed_at!: string;
}
