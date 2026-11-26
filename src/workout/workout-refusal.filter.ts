import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { WORKOUT_REFUSALS } from './workout-refusal';

/**
 * WORKOUT-REFUSAL-CODES-BE: bound to POST /workouts and PUT /workouts/:id only. A refusal listed in
 * WORKOUT_REFUSALS keeps its class, status, message and error and gains `code` and `next_step`; every
 * other exception reaches the envelope exactly as thrown. Only these two classes are caught, so a
 * ThrottlerException still reaches the global ThrottlerExceptionFilter (its Retry-After kept).
 */
@Catch(BadRequestException, NotFoundException)
export class WorkoutRefusalFilter implements ExceptionFilter {
  private readonly envelope = new HttpExceptionFilter();

  catch(exception: BadRequestException | NotFoundException, host: ArgumentsHost): void {
    const body = exception.getResponse();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
    const refusal =
      fields && typeof fields.code !== 'string'
        ? WORKOUT_REFUSALS.find((r) => exception instanceof r.type && r.matches(fields.message))
        : undefined;
    if (!fields || !refusal) return this.envelope.catch(exception, host);
    const coded = { ...fields, code: refusal.code, next_step: refusal.next_step };
    this.envelope.catch(new refusal.type(coded, { cause: exception.cause }), host);
  }
}
