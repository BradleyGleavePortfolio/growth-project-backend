// TM-7a — Admin moderation query pipes.
//
// B-P2-6: the listing review queue's optional `status` filter must reject an
// unknown value with a STABLE machine-readable discriminator
// (`invalid_listing_status`) over the wire, not just class-validator's generic
// 400. `@IsIn(LISTING_STATUS)` stays on the DTO for OpenAPI + class-validator
// metadata; this pipe is applied directly to the `status` query param so the
// rejection carries the documented `code` while leaving every other DTO
// validation error on the default 400 path.
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { LISTING_STATUS, type ListingStatus } from './admin-moderation.dto';

@Injectable()
export class ParseListingStatusPipe
  implements PipeTransform<unknown, ListingStatus | undefined>
{
  transform(value: unknown): ListingStatus | undefined {
    // The filter is optional: an omitted status is a valid "all queues" query.
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && (LISTING_STATUS as readonly string[]).includes(value)) {
      return value as ListingStatus;
    }
    // Stable discriminator clients can branch on, surfaced verbatim by
    // HttpExceptionFilter (which copies `code` off the exception body).
    throw new BadRequestException({
      error: 'Bad Request',
      message: 'Invalid listing status',
      code: 'invalid_listing_status',
    });
  }
}
