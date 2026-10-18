/**
 * Invalidation for the Roman client-context memo (PLAN_roman_intelligence §2.5).
 *
 * Rule: a change a person makes in the app, to their own data or (as a coach)
 * to a client's, reaches Roman's next answer for that client.
 *
 * One shared point: `RomanContextInvalidationInterceptor` (global, registered
 * by RomanModule) calls `romanContextInvalidate(<signed-in caller>)` after every
 * successful write request: any method but GET/HEAD/OPTIONS, the handler
 * resolved (so its transaction has committed) and the status is below 400. A
 * write that throws or answers 4xx/5xx invalidates nothing. It runs before the
 * response is sent, so the app never sees a 2xx ahead of the fresh context.
 * RomanClientContextService then drops the caller's own entry and every entry
 * built from the caller's rows: a coach's (or delegated sub-coach's) write drops
 * the entries of that coach's clients, and no one else's. That also covers coach
 * writes that name the client only in the stored row (target archive, booking
 * actions, meal-plan assignment, adjustment approval) and coach-wide edits.
 *
 * `@KeepRomanContext()` exempts Roman's own turn: it writes nothing Roman
 * reads, and invalidating there would empty the memo after every turn.
 * `ClientAIContextService.invalidateForUser` (food log, workout, weight,
 * fasting, check-in, coach message) also still fans out here.
 *
 * Writes with no signed-in caller (webhooks, scheduled jobs) are bounded by
 * the 15 s TTL. Fly runs several machines, so this is per machine by design;
 * the TTL bounds staleness on the others. Write paths import the plain
 * functions, so no module needs to import RomanModule (AiModule already
 * imports RomanModule for the consent guard; a reverse import would be a cycle).
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';

type Listener = (userId: string) => void;
const listeners = new Set<Listener>();

export function onRomanContextInvalidate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function romanContextInvalidate(userId: string): void {
  for (const l of listeners) {
    try {
      l(userId);
    } catch {
      // A listener failure must never break a write path.
    }
  }
}

/** Test seam. */
export function _resetRomanContextListeners(): void {
  listeners.clear();
}

export const KEEP_ROMAN_CONTEXT = 'roman:keep-context';
/** A write route that changes nothing Roman reads (Roman's own turn). */
export const KeepRomanContext = () => SetMetadata(KEEP_ROMAN_CONTEXT, true);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class RomanContextInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<{ method?: string; user?: { id?: string } }>();
    const userId = req.user?.id;
    if (
      !userId ||
      READ_METHODS.has(req.method ?? 'GET') ||
      this.reflector.get<boolean>(KEEP_ROMAN_CONTEXT, context.getHandler())
    ) {
      return next.handle();
    }
    const res = http.getResponse<{ statusCode?: number }>();
    return next.handle().pipe(
      tap(() => {
        if ((res.statusCode ?? 200) < 400) romanContextInvalidate(userId);
      }),
    );
  }
}
