import {
  IsString,
  IsOptional,
  IsNumber,
  IsObject,
  IsIn,
  IsISO8601,
} from 'class-validator';

/** Finance signal types accepted by the inbound federation endpoint.
 * Intentionally narrow — only signals the finance backend owns are
 * accepted here. Other PTM signal types are rejected with 400 to keep
 * the inbound surface minimal and auditable. */
export type FinanceFederationSignalType = 'finance_eod' | 'finance_milestone';

export const ALLOWED_FINANCE_SIGNAL_TYPES: FinanceFederationSignalType[] = [
  'finance_eod',
  'finance_milestone',
];

export class InboundSignalDto {
  /**
   * Fitness-backend User UUID. Preferred over `email` when both are
   * provided — avoids the email-lookup round-trip and sidesteps the
   * brittle email-join documented in FederationService.
   */
  @IsString()
  @IsOptional()
  user_id?: string;

  /**
   * Client email address. Used for user lookup when `user_id` is not
   * provided. Matched case-insensitively against the fitness database.
   * Never stored or echoed in the response.
   */
  @IsString()
  @IsOptional()
  email?: string;

  /** One of the accepted finance signal types. Other types are rejected
   * with 400 to prevent the surface from being widened by the caller. */
  @IsString()
  @IsIn(ALLOWED_FINANCE_SIGNAL_TYPES)
  signal_type!: FinanceFederationSignalType;

  /** Numeric magnitude. Defaults to 1 (boolean event) when omitted.
   * Semantics per signal type:
   *   - `finance_eod`       — EOD submission count (usually 1 per event)
   *   - `finance_milestone` — milestone count or numeric milestone value
   */
  @IsNumber()
  @IsOptional()
  value?: number;

  /**
   * Optional per-signal context. PII-free only — no emails, names, or
   * raw financial figures. Caller may include a stable `milestone_type`
   * string (e.g. `'net_worth_100k'`) or a count field.
   */
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  /**
   * ISO-8601 timestamp override. When provided the signal is recorded
   * at the given time rather than `now()`. Must be in the past.
   * Useful when the finance backend batches and ships signals with a
   * short delay.
   */
  @IsISO8601()
  @IsOptional()
  recorded_at?: string;
}
