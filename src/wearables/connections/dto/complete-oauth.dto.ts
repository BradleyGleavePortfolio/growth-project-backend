import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * A6 (AUTHB-05) — body for `POST /v1/wearables/connections/oauth/complete`.
 * The opaque single-use ticket from the callback's return link. Bounded so
 * garbage never reaches the store; the server checks whose ticket it is.
 */
export class CompleteOauthDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  ticket!: string;
}
