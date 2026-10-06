// S-AICOST-123 / agent 123. Arithmetic only: no provider, DB, or production calls.
// All usage volumes below are planning assumptions, not measured usage.
// Runtime limits and rates audited at backend 5230306cb63df7290459bb362340a42f385f39d5.
const priceUsd = (input, output) => (3 * input + 15 * output) / 1_000_000;
const clients = 100;
const romanTurns = Array.from({ length: 50 }, (_, index) => {
  const turn = index + 1;
  // buildContextTurns takes 30 messages; boundRomanPayload discards an
  // initial assistant message, leaving up to 15 user + 14 assistant messages.
  const input = 6000 + Math.min(turn, 15) * 100 + Math.min(turn - 1, 14) * 1024;
  const usd = priceUsd(input, 1024);
  return { turn, input_tokens: input, output_tokens: 1024, usd, pool_debit_cents: Math.ceil(usd * 100) };
});
const guideCalls = [
  { input_tokens: 2100, output_tokens: 600 },
  { input_tokens: 2800, output_tokens: 600 },
].map((call) => ({
  ...call,
  total_tokens: call.input_tokens + call.output_tokens,
  usd: priceUsd(call.input_tokens, call.output_tokens),
}));
console.log(JSON.stringify({
  job: 'S-AICOST-123',
  backend_sha: '5230306cb63df7290459bb362340a42f385f39d5',
  evidence: {
    roman_limits: 'https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/roman/roman.constants.ts',
    roman_history_and_spend: 'https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/roman/roman.service.ts',
    guide_quota_and_calls: 'https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/ai/ai.service.ts',
    price: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  assumptions: {
    clients,
    roman_user_turns_per_client: 50,
    roman_base_system_input_tokens: 6000,
    roman_tokens_per_user_message: 100,
    roman_output_tokens_per_reply: 1024,
    guide_base_system_input_tokens: 2000,
    guide_tokens_per_user_message: 100,
    guide_output_tokens_per_reply: 600,
    sequential_successful_calls_only: true,
    note: 'Conservative long-reply planning scenario; not telemetry or a strict worst-case theorem.',
  },
  roman: {
    first_turn: romanTurns[0],
    mature_turn: romanTurns[49],
    requested_turns: clients * romanTurns.length,
    requested_provider_usd_before_admission: clients * romanTurns.reduce((sum, turn) => sum + turn.usd, 0),
    requested_pool_debit_usd_before_admission: clients * romanTurns.reduce((sum, turn) => sum + turn.pool_debit_cents, 0) / 100,
    configured_default_platform_daily_usd_cap: 100,
    default_one_coach_monthly_actual_credit_usd: 40,
    minimum_pool_credit_to_admit_turn_cents: Math.ceil(priceUsd(24_000, 1024) * 100),
    comparison_constant_6000_input_and_1024_output_for_5000_turns_usd: priceUsd(6000, 1024) * clients * 50,
  },
  guide: {
    ordinary_two_call_example: guideCalls,
    tokens_consumed_per_client_after_two_calls: guideCalls.reduce((sum, call) => sum + call.total_tokens, 0),
    third_call_required_reservation_tokens: 6600,
    nominal_daily_quota_tokens: 12000,
    third_call_rejected: guideCalls.reduce((sum, call) => sum + call.total_tokens, 0) + 6600 > 12000,
    provider_usd_for_100_clients_two_calls: clients * guideCalls.reduce((sum, call) => sum + call.usd, 0),
    provider_usd_for_30_such_days: 30 * clients * guideCalls.reduce((sum, call) => sum + call.usd, 0),
    conservative_nominal_token_envelope_100_clients_usd: clients * 12000 * 15 / 1_000_000,
    envelope_caveat: 'Only the ordinary-usage nominal quota envelope; all-output valuation is deliberately loose, not a hard USD breaker.',
  },
  roman_and_guide_nominal_daily_planning_envelope_usd: 100 + clients * 12000 * 15 / 1_000_000,
}, null, 2));
