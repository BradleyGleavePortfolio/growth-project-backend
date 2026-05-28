import { HttpException, HttpStatus } from '@nestjs/common';
import { COACH_AI_BUDGET_EXHAUSTED_CODE } from './ai-credits.constants';

// 402 — entitlement/paywall (ENGINEERING_RULES §3). The structured body is
// what the mobile client renders the "hard pause" modal from. pack_options
// gives the UI the three button amounts inline so the failure surface and
// the budget DTO can drift independently — the structured contract here
// guarantees the mobile sees what it needs.
//
// 50 Failures #36 — "Errors not codes": the `code` field is the
// machine-readable stable identifier. `message` is for the operator log,
// not the user-facing copy (the mobile app owns the copy).

export interface CoachAiBudgetExhaustedBody {
  code: typeof COACH_AI_BUDGET_EXHAUSTED_CODE;
  message: string;
  pack_options_cents: number[];
  custom_pack_bounds_cents: { min: number; max: number };
  /** Snapshot at the moment of refusal so the client can render the meter
   *  without an extra round-trip to GET /coach/ai/budget. */
  budget: {
    period_end: string;
    base_displayed_cents: number;
    pack_displayed_cents: number;
    used_displayed_cents: number;
    remaining_displayed_cents: number;
  };
}

export class CoachAiBudgetExhaustedException extends HttpException {
  constructor(body: CoachAiBudgetExhaustedBody) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}
