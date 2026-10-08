import { AsyncLocalStorage } from 'node:async_hooks';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * CREDIT-PAY-131 (owner decision 10 fallback, CREDIT-REFILL-130 B3). The app
 * says on every request what its build can sell (mobile src/services/api.ts
 * and src/config/purchaseSurfaces.ts):
 *   X-Client-Purchase-Policy  'all' | 'p2p-only' | 'p2p-and-ai-credits'
 *   X-Client-Platform         'ios' | 'android'
 * The coach-facing "AI credits used up" copy names a credit pack only when the
 * calling build sells packs; otherwise it gives the date the pool renews.
 * Copy only: these headers are client-supplied, so nothing is allowed or
 * refused because of them.
 */
export interface CallerPurchaseHeaders {
  policy: string | null;
  platform: string | null;
}

const callerApp = new AsyncLocalStorage<CallerPurchaseHeaders>();

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | null {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

/** Reads the two headers from a Node request header map (lower-case names). */
export function readCallerPurchaseHeaders(
  headers: Record<string, unknown> | undefined,
): CallerPurchaseHeaders {
  return {
    policy: headerValue(headers, 'x-client-purchase-policy'),
    platform: headerValue(headers, 'x-client-platform'),
  };
}

/**
 * True only when the calling build shows credit packs:
 *   - 'p2p-and-ai-credits': an iOS US-link build (Stripe Checkout in the
 *     system browser);
 *   - 'all' from iOS: development builds and builds before 6 with the in-app
 *     checkout.
 * Android release builds send 'all' but hide packs, so 'all' counts only from
 * iOS. No headers (server jobs, web, older builds) means false.
 */
export function creditPacksSoldInCallerApp(
  caller: CallerPurchaseHeaders | undefined = callerApp.getStore(),
): boolean {
  if (!caller) return false;
  if (caller.policy === 'p2p-and-ai-credits') return true;
  return caller.policy === 'all' && caller.platform === 'ios';
}

/** Runs `fn` with the caller's purchase headers in scope (interceptor and tests). */
export function runWithCallerPurchaseHeaders<T>(caller: CallerPurchaseHeaders, fn: () => T): T {
  return callerApp.run(caller, fn);
}

/**
 * "They renew on November 1." The pool's period_end is the first instant of
 * the next period (startOfNextMonth, UTC), so its UTC calendar date is the
 * renewal day.
 */
export function poolRenewsSentence(periodEnd: Date | string | null | undefined): string {
  const when = periodEnd ? new Date(periodEnd) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return 'They renew when the next monthly period starts.';
  }
  const day = when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `They renew on ${day}.`;
}

/**
 * Puts the request's purchase headers in scope for the whole handler. Nest
 * binds the handler to the async context that is active when `handle()` is
 * called, so the copy chosen anywhere below (services, gateway) sees them.
 */
@Injectable()
export class CallerPurchasePolicyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const caller = readCallerPurchaseHeaders(req?.headers);
    return new Observable((subscriber) =>
      callerApp.run(caller, () => next.handle().subscribe(subscriber)),
    );
  }
}
