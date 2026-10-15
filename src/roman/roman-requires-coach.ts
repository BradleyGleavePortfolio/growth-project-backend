import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/**
 * Roman is for clients with a coach (owner 2026-10-09 00:0x: "Lets lock roman
 * usage away for coachless clients with epxlanation ... lets leave basic self
 * logging alone though"). A client (role student) with no coach gets a stable
 * 403 on the Roman AI routes (POST /roman/sessions, POST
 * /roman/sessions/:id/messages, POST /ai/chat) before anything is stored,
 * counted against a cap or sent to the AI, so no coach pool or daily budget is
 * touched. The app shows "Join a coach" for this code. 139-15 ("coachless
 * clients have no access to roman at all"): the same 403 on Roman's context
 * reads (GET /ai/context, GET /ai/structured-context, GET /roman/context/me),
 * before anything is read, and on POST /ai/gateway/invoke before the paywall,
 * the context load or the model (ROMANROUTES).
 *
 * Unchanged: coaches and the owner; coached clients (coach AI pool and the
 * daily cap still apply); a crisis message (the fixed 988 / 911 answer, no AI
 * call); scripted Roman lines that make no AI call; reading, listing and
 * deleting the client's own chats; the client's own logging.
 */
export const ROMAN_REQUIRES_COACH = 'ROMAN_REQUIRES_COACH';
export const ROMAN_REQUIRES_COACH_ACTION = 'JOIN_COACH';
export const ROMAN_REQUIRES_COACH_MESSAGE =
  'Roman works with a coach. Join a coach to talk with Roman; your own logging stays open.';

interface RomanUser {
  role?: string | null;
  coach_id?: string | null;
}

/** True for a client with no coach. `req.user` is the fresh User row (JwtAuthGuard). */
export function romanRequiresCoach(user: RomanUser | null | undefined): boolean {
  return !!user && user.role === 'student' && !user.coach_id;
}

export function romanRequiresCoachException(): HttpException {
  return new HttpException(
    {
      error: ROMAN_REQUIRES_COACH,
      code: ROMAN_REQUIRES_COACH,
      message: ROMAN_REQUIRES_COACH_MESSAGE,
      action: ROMAN_REQUIRES_COACH_ACTION,
    },
    HttpStatus.FORBIDDEN,
  );
}

/** Throws the 403 ROMAN_REQUIRES_COACH for a client with no coach. */
export function assertRomanHasCoach(user: RomanUser | null | undefined): void {
  if (romanRequiresCoach(user)) throw romanRequiresCoachException();
}

/**
 * Roman's own-context reads answer clients only (ROMANCTX-ROLE, ROMANROUTES):
 * RolesGuard lets a coach through @Roles('student') and the owner through every
 * route, so they get the guard's own 403 "Insufficient role"; then a client with
 * no coach gets 403 ROMAN_REQUIRES_COACH. Call it before anything is read.
 */
export function assertRomanClient(user: RomanUser | null | undefined): void {
  if (user?.role !== 'student') throw new ForbiddenException('Insufficient role');
  assertRomanHasCoach(user);
}

/** assertRomanHasCoach as a guard, for a controller whose paywall guard would answer first. */
@Injectable()
export class RomanRequiresCoachGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    assertRomanHasCoach(ctx.switchToHttp().getRequest<{ user?: RomanUser }>().user);
    return true;
  }
}
