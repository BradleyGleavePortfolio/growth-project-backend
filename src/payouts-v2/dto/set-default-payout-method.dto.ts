import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Optional query/body for the cursor-paginated list endpoint
 * `GET /me/payout-methods` (spec §2.1). Mirrors the repo's existing cursor
 * idiom: opaque `cursor` (a PayoutMethod id) + bounded `limit` (default 50,
 * max 100). The set-default action itself takes the method id from the route
 * param (`POST /me/payout-methods/:id/default`), so no body is required there.
 */
export class ListPayoutMethodsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string;
}
