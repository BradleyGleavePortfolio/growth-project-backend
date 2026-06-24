// TM-7b — Admin applicant-review query pipes.
//
// Mirrors the TM-7a ParseListingStatusPipe contract for the applicant queue:
// the optional `status` filter must reject an unknown value with a STABLE
// machine-readable discriminator (`invalid_application_status`) over the wire,
// not just class-validator's generic 400. `@IsIn(APPLICATION_STATUS)` stays on
// the DTO for OpenAPI + class-validator metadata; this pipe is applied directly
// to the `status` query param so the rejection carries the documented `code`
// while leaving every other DTO validation error on the default 400 path.
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { APPLICATION_STATUS, type ApplicationStatus } from './admin-applications.dto';

@Injectable()
export class ParseApplicationStatusPipe
  implements PipeTransform<unknown, ApplicationStatus | undefined>
{
  transform(value: unknown): ApplicationStatus | undefined {
    // The filter is optional: a genuinely omitted status (no `status` key at
    // all) is a valid "all queues" query.
    if (value === undefined || value === null) return undefined;
    // An empty-string status (`?status=`) is supplied-but-invalid, not omitted.
    // Treat it like any other unknown value so it returns the same stable
    // `code: 'invalid_application_status'` envelope as `?status=garbage` rather
    // than falling through to the DTO @IsIn's generic, uncoded 400 (B-P2-8).
    if (typeof value === 'string' && (APPLICATION_STATUS as readonly string[]).includes(value)) {
      return value as ApplicationStatus;
    }
    // Stable discriminator clients can branch on, surfaced verbatim by
    // HttpExceptionFilter (which copies `code` off the exception body).
    throw new BadRequestException({
      error: 'Bad Request',
      message: 'Invalid application status',
      code: 'invalid_application_status',
    });
  }
}
