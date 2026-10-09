import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma.service';
import type { AuthedRequest } from '../../auth/auth-request';
import { OPEN_TO_COACHLESS_CLIENT_KEY } from '../../common/decorators/open-to-coachless-client.decorator';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { LOCKED_DUNNING_CODE } from './dunning-v2.cadence';
import { effectiveLock } from './dunning-effective-access';
import { VoicePolicyService } from '../../roman/voice/voice-policy.service';

/**
 * B3 Smart Dunning v2 — Day-10 hard-lockout guard (spec §3 / §8.1).
 *
 * Backend enforcement of the hard lockout: when the signed-in client has an
 * ACTIVE DunningState with `locked_out_at != null` (set only by the Day-10
 * sweep, cleared only by payment) and no OTHER live entitlement, every
 * NON-allowed route returns `403 LOCKED_DUNNING`.
 *
 * S-DUNNING: the lock no longer also requires `entitlement_active === false`.
 * Stripe's `customer.subscription.updated` (sent for many reasons while a
 * subscription is past_due) re-derives `entitlement_active = true` for
 * past_due, which silently lifted the lockout. `locked_out_at` is now the sole
 * authority. A client who also holds a separate live grant (a comp or
 * invite-code purchase, or a coach-kept access) is not locked. Login then
 * collapses to the payment-update screen only; community, workouts, programs,
 * generic chat are all 403.
 *
 * Allowed while LOCKED (brief §3, confirmed against the spec's "Roman explains
 * the lockout" carve-out):
 *   - /billing/*  and /checkout/* and /payment-recovery/* (update the card)
 *   - the two coach-scoped billing surfaces, /coach/billing/* (mobile) and
 *     /v1/coach/me/billing* (v1) — both open the same Stripe portal
 *   - /auth/*     (sign-in, /auth/me, /auth/extension/refresh, password reset —
 *     recovery must never be locked). Note there is no mounted /auth/logout or
 *     /auth/refresh; the mounted refresh route is /auth/extension/refresh.
 *   - health checks (health, healthz, readyz)
 *   - data export (/v1/me/data-export/*) and account deletion
 *     (/me/delete-account*) — required while locked (App Store 5.1.1(v), and a
 *     locked client must always be able to take their data and leave)
 *   - Roman chat: /roman/* (RomanController) — the dedicated Roman assistant
 *     surface, so Roman can explain the lockout. This is the ONLY AI-adjacent
 *     carve-out. The entitlement-gated student AI assistant (/ai/*, AiController)
 *     is a paid VALUE surface and stays LOCKED; the internal /ai/gateway
 *     provider-routing surface is never a client explanation route. (Roman chat
 *     is itself dark behind FEATURE_ROMAN_CHAT_ENABLED — a 404 while OFF — so
 *     allow-listing it is only meaningful once that flag is also ON.)
 *   - AI processing consent (AiConsentController, R2a): exactly
 *     GET /me/ai-consent, POST /me/ai-consent/roman and
 *     DELETE /me/ai-consent/roman. Reading, granting and withdrawing the box-2
 *     AI consent is a privacy control, never a paid value surface, so billing
 *     state must never block it (operator ruling on #622). Matched as exact
 *     METHOD + PATH pairs (Sol B-622-1): no descendant path, no other method,
 *     and the rest of /me/* stays locked.
 *   - Contact the coach (S-DUNNING F8, B-353-10): exactly GET /messages,
 *     POST /messages, POST /messages/read and GET /messages/unread-count
 *     (ClientMessagingController; the thread is always with the client's
 *     assigned coach), plus POST /messages/report (MessagesSafetyController,
 *     safety). "Message coach" is the lockout screen's way back. Matched as
 *     exact METHOD + PATH pairs like the AI consent operations: voice upload
 *     (paid), coach-review, the coach-side routes and every other method or
 *     descendant stay locked.
 *   - Basic functions (owner 10-08 23:5x: "No reason to ever lock a client
 *     from basic functions"): every route marked @OpenToCoachlessClient() (the
 *     client's own food, workout and fasting logging, targets, plans,
 *     check-ins and insights), except AI guidance under /ai/*, which stays
 *     locked like every paid value surface (operator reading 10-09: billing,
 *     the dispute pause, coach services and Roman stay as they are). Matched
 *     by the route's metadata, not its path, so an unmarked route is never
 *     opened by accident.
 *
 * Posture: this guard is a HARD no-op while FEATURE_DUNNING_V2 is OFF — it
 * returns `true` immediately and reads no state, so v1 deployments are
 * completely unaffected. It also fails OPEN on any lookup error (never lock a
 * user out because of an infra hiccup) — the only path that locks is an
 * explicit `locked_out_at` row.
 */

/** First-segment heads (post-/api prefix) always reachable while locked. */
const ALLOWED_PREFIXES: readonly string[] = [
  'billing',
  'checkout',
  'payment-recovery',
  'recover',
  'auth',
  'health',
  'healthz',
  'readyz',
] as const;

/**
 * Coach-scoped billing surfaces, matched as FULL normalized route prefixes
 * rather than by segment position. Both entries reach the same
 * `BillingService.createCoachPortalSession` capability — the Stripe portal a
 * locked coach needs in order to cure the delinquency — so both must stay
 * reachable while locked.
 *
 * Positional matching is deliberately not used here: matching an allow-list
 * token in any segment admitted `scheduling/auth/google/*` (a paid Google
 * Calendar integration surface) purely because its second segment was `auth`,
 * and would have admitted every future controller with a colliding segment.
 */
const ALLOWED_ROUTE_PREFIXES: readonly string[] = [
  'coach/billing', // MobileCoachBillingController — status, portal-session
  'coach/me/billing', // CoachBillingController (v1) — billing, billing/portal-session
] as const;

/**
 * The dedicated Roman chat surface (`/roman/*`, RomanController) the locked
 * client may reach so the Roman assistant can explain the lockout. Deliberately
 * NOT `/ai/*`: that is the entitlement-gated student AI assistant (AiController),
 * a paid value surface that must stay locked, and `/ai/gateway` is internal
 * provider routing, never a client explanation route.
 */
const ROMAN_CHAT_PREFIXES: readonly string[] = ['roman'] as const;

/**
 * Roman routes that serve the client's coaching data, not the lockout
 * explanation: GET /roman/context/me returns the coach's program, meal plan,
 * guidelines and targets, so it stays locked (operator ruling 2026-10-05 13:37,
 * Opus B-665-2).
 */
const ROMAN_LOCKED_PREFIXES: readonly string[] = ['roman/context'] as const;

/**
 * Privacy operations a locked client must always reach (operator ruling on
 * #622): reading, granting and withdrawing AI processing consent cannot depend
 * on billing state. Exact METHOD + normalized PATH pairs, compared by equality
 * (Sol B-622-1 / Opus C-622-1): `GET me/ai-consent/export`,
 * `POST me/ai-consent`, `PUT me/ai-consent/roman` and every other descendant
 * or method stay locked.
 */
const PRIVACY_OPERATIONS: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', 'me/ai-consent'], // AiConsentController.get — read status
  ['POST', 'me/ai-consent/roman'], // AiConsentController.grant
  ['DELETE', 'me/ai-consent/roman'], // AiConsentController.withdraw
] as const;

/**
 * Account-rights surfaces matched as full route prefixes: data export and
 * account deletion stay reachable while locked (S-DUNNING F8).
 */
const ACCOUNT_RIGHTS_PREFIXES: readonly string[] = [
  'me/data-export', // DataExportController — request, status, download
  'me/delete-account', // AccountDeletionController — request, confirm, cancel, status
] as const;

/**
 * Contact the coach (S-DUNNING F8; B-353-10, Opus L3 on mobile m#353): the
 * locked client's thread with their own coach. ClientMessagingController
 * resolves the thread from the client's assigned coach (no path param), so
 * these exact METHOD + normalized PATH pairs open that one thread, plus the
 * safety report, and nothing else: `POST messages/voice-upload` (paid),
 * `GET messages/coach-review`, `coach/clients/:id/messages`, any future
 * `messages/*` surface and every other method or descendant stay locked.
 */
const COACH_THREAD_OPERATIONS: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', 'messages'], // ClientMessagingController.listThread
  ['POST', 'messages'], // ClientMessagingController.send
  ['POST', 'messages/read'], // ClientMessagingController.markRead
  ['GET', 'messages/unread-count'], // ClientMessagingController.unreadCount
  ['POST', 'messages/report'], // MessagesSafetyController — report a message
] as const;

/**
 * Marked basic-function routes that still lock: AI guidance (/ai/*) is Roman's
 * guide and draws on the coach's AI pool, so it stays locked exactly as before.
 */
const BASIC_FUNCTION_LOCKED_PREFIXES: readonly string[] = ['ai'] as const;

/**
 * True when a route marked @OpenToCoachlessClient() (`markedOpen`) stays
 * reachable while the client is locked out: every marked route except /ai/*.
 */
export function isBasicFunctionWhileLocked(markedOpen: boolean, path: string): boolean {
  if (!markedOpen) return false;
  return !BASIC_FUNCTION_LOCKED_PREFIXES.some((prefix) => matchesRoutePrefix(path, prefix));
}

@Injectable()
export class DunningLockoutGuard implements CanActivate {
  private readonly logger = new Logger(DunningLockoutGuard.name);
  // Reads route metadata only (no dependencies), so the existing constructor
  // and every caller of it stay unchanged.
  private readonly reflector = new Reflector();

  // Phase 2: VoicePolicyService supplies the Day-10 lockout SCREEN copy + the
  // RomanAvatar crop the locked client sees. @Optional so the guard keeps
  // working in thin unit tests; the existing 403 `message` reason is left
  // untouched, the Roman copy is attached additively under `lockout_copy`.
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly voice?: VoicePolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Flag OFF → guard is invisible. v1 unaffected.
    if (!isDunningV2Enabled()) return true;

    const req = context.switchToHttp().getRequest<
      AuthedRequest & {
        method?: string;
        path?: string;
        originalUrl?: string;
        url?: string;
      }
    >();

    const path = normalizePath(req.path ?? req.originalUrl ?? req.url ?? '');
    if (isAllowedWhileLocked(path)) return true;
    if (isPrivacyOperationWhileLocked(req.method, path)) return true;
    if (isCoachThreadOperationWhileLocked(req.method, path)) return true;
    if (isBasicFunctionWhileLocked(this.isMarkedOpen(context), path)) return true;

    const userId = req.user?.id;
    if (!userId) return true; // unauthenticated routes are handled by auth guards

    let locked = false;
    try {
      locked = await this.isClientLockedOut(userId);
    } catch (err) {
      // Fail OPEN — never lock a user out on an infra error.
      this.logger.warn(
        `DunningLockoutGuard lookup failed for user=${userId}: ${(err as Error).message}`,
      );
      return true;
    }

    if (!locked) return true;

    // The short `message` is the stable 403 reason and is preserved verbatim
    // (flag-independent). The Day-10 lockout SCREEN copy + avatar crop the
    // client reads is supplied by the Voice Policy (FEATURE_ROMAN_COPY_V2-
    // gated): legacy household-ledger text while OFF, Roman Option-3 while ON.
    const lockoutCopy = this.voice ? this.voice.copyFor('lockout_day10') : undefined;
    throw new ForbiddenException({
      code: LOCKED_DUNNING_CODE,
      message:
        'Your account is locked pending a billing matter. Update your payment to restore access.',
      lockout_copy: lockoutCopy,
    });
  }

  /**
   * True when the handler or its controller carries @OpenToCoachlessClient().
   * A context with no handler or class (a bare test double) counts as
   * unmarked, so the lock applies as before.
   */
  private isMarkedOpen(context: ExecutionContext): boolean {
    const targets: Parameters<Reflector['getAllAndOverride']>[1] = [];
    if (typeof context.getHandler === 'function') targets.push(context.getHandler());
    if (typeof context.getClass === 'function') targets.push(context.getClass());
    if (targets.length === 0) return false;
    return this.reflector.getAllAndOverride<boolean>(OPEN_TO_COACHLESS_CLIENT_KEY, targets) === true;
  }

  /**
   * A client is locked out when ANY of their purchases has an ACTIVE
   * DunningState with `locked_out_at != null`, unless the client also holds a
   * different live entitlement (comp / invite-code grant, another paid
   * package, or access the coach kept on). Resolved via
   * ClientPurchase.client_user_id -> DunningState.purchase_id.
   */
  private async isClientLockedOut(userId: string): Promise<boolean> {
    // S-DUNNING-R3 (B-628-7): the same rule the status read model uses.
    const lock = await effectiveLock(this.prisma, userId);
    return lock.locked;
  }
}

/** Strip the global `/api` prefix and a leading slash, lowercase. */
export function normalizePath(raw: string): string {
  let p = (raw.split('?')[0] ?? '').toLowerCase();
  if (p.startsWith('/')) p = p.slice(1);
  if (p.startsWith('api/')) p = p.slice('api/'.length);
  // Strip a leading version segment (e.g. v1/) so prefix checks are stable.
  if (p.startsWith('v1/')) p = p.slice('v1/'.length);
  return p;
}

/** True if `path` is exactly `prefix` or sits underneath it. */
function matchesRoutePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True if `path` (normalized) is reachable while the client is locked out. */
export function isAllowedWhileLocked(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return true; // root / health redirect

  if (ALLOWED_PREFIXES.includes(segments[0])) return true;
  for (const prefix of ALLOWED_ROUTE_PREFIXES) {
    if (matchesRoutePrefix(path, prefix)) return true;
  }
  // Dedicated Roman chat surface (/roman/*) so Roman can explain the lockout.
  if (ROMAN_LOCKED_PREFIXES.some((locked) => matchesRoutePrefix(path, locked))) return false;
  for (const chat of ROMAN_CHAT_PREFIXES) {
    if (matchesRoutePrefix(path, chat)) return true;
  }
  for (const prefix of ACCOUNT_RIGHTS_PREFIXES) {
    if (matchesRoutePrefix(path, prefix)) return true;
  }
  // Contact-the-coach routes are METHOD + PATH pairs, see
  // isCoachThreadOperationWhileLocked.
  return false;
}

/**
 * True only for the exact privacy operations in PRIVACY_OPERATIONS. `path` is
 * normalized (see normalizePath); `method` is the raw request method, compared
 * case-insensitively. A missing method never matches.
 */
export function isPrivacyOperationWhileLocked(method: string | undefined, path: string): boolean {
  return matchesOperation(PRIVACY_OPERATIONS, method, path);
}

/**
 * True only for the exact coach-thread operations in COACH_THREAD_OPERATIONS
 * (B-353-10), matched like the privacy operations.
 */
export function isCoachThreadOperationWhileLocked(
  method: string | undefined,
  path: string,
): boolean {
  return matchesOperation(COACH_THREAD_OPERATIONS, method, path);
}

function matchesOperation(
  operations: ReadonlyArray<readonly [method: string, path: string]>,
  method: string | undefined,
  path: string,
): boolean {
  if (typeof method !== 'string' || method.length === 0) return false;
  const m = method.toUpperCase();
  return operations.some(([pm, pp]) => pm === m && pp === path);
}
