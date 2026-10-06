import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * PR-HK-1 — query params for `GET /v1/wearables/connections/oauth/callback`.
 *
 * Both fields are provider-supplied and untrusted. `state` is validated for
 * length sanity here (bounded to defeat oversized/garbage inputs) and then
 * cryptographically validated + consumed by `OauthStateService` BEFORE any
 * token exchange (50-Failures #5 — callback validates state first). `code` is
 * the provider authorization code passed straight to the connector's
 * `exchangeCode`. We never log either value (#12 — no secret in logs).
 *
 * Length bounds are generous (providers vary) but finite — an unbounded query
 * string is a DoS vector (#8 phantom validation).
 */
export class OauthCallbackDto {
  /**
   * Provider authorization code to exchange for tokens. B-WEARLIST-125:
   * optional so a declined consent (`?error=access_denied&state=...`, no code)
   * reaches the handler and is sent back to the app instead of a raw 400 page.
   */
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(2048)
  code?: string;

  /** Opaque CSRF state previously minted by `oauth/start`. */
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(512)
  state!: string;

  /**
   * B-WEARLIST-125: extra parameters providers add to the redirect (Strava,
   * WHOOP and Oura echo `scope`; a declined consent sends `error`). Declared
   * so the global forbidNonWhitelisted pipe does not reject a normal callback.
   * Never logged.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  scope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  error?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  error_description?: string;
}
