import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { MIN_CHECKOUT_RECOVERY_SECRET_LENGTH } from '../common/env-validation';

// GUEST-ELIGIBILITY (agent 170, owner #170-2 WELCOME-BACK-CHECK + #169-8
// WEB-BUYER, audit LS-1140 item 2). A web buyer whose email already has a
// TGP account proves the email with a 6-digit code BEFORE any PaymentIntent
// exists, and only buyers this coach can take may pay:
//   * no account          -> 'new'        pays without a check (#170-2)
//   * student, no coach   -> 'no_coach'   pays after the code
//   * student, this coach -> 'same_coach' pays after the code
//   * student, other coach-> 'other_coach' refused (#SWITCH-V1), incl. the
//                            house coach's packages until b#1131 lands
//   * coach/sub-coach/owner -> 'not_client' refused before payment
export type BuyerVerdict = 'new' | 'no_coach' | 'same_coach' | 'other_coach' | 'not_client';

export interface BuyerAccount {
  id: string;
  name: string;
  role: string;
  coach_id: string | null;
}

export const CODE_TTL_SECONDS = 10 * 60;
export const CODE_MAX_WRONG = 5;
export const BUYER_TOKEN_TTL_SECONDS = 30 * 60;
const BUYER_TOKEN_TYPE = 'buyer_verified';

// #SWITCH-V1 (owner, reused verbatim). The not-client line needs owner words.
export const SWITCH_V1_MESSAGE =
  'Your account already has a coach. To change coaches, contact support from Settings.';
export const NOT_CLIENT_MESSAGE =
  'This email belongs to a coach account, so it can’t buy a coaching package. Use a different email.';
export const CODE_REQUIRED_MESSAGE =
  'This email already has a TGP account. Enter the code we emailed you to keep going.';
export const CODE_INVALID_MESSAGE =
  'That code didn’t work. Check the newest email from us, or send a new code.';

export function buyerVerdict(
  user: Pick<BuyerAccount, 'role' | 'coach_id'> | null,
  sellingCoachId: string,
): BuyerVerdict {
  if (!user) return 'new';
  if (user.role !== 'student') return 'not_client';
  if (!user.coach_id) return 'no_coach';
  return user.coach_id === sellingCoachId ? 'same_coach' : 'other_coach';
}

/** The refusal a buyer sees for an ineligible verdict, or null when they may pay. */
export function buyerRefusal(verdict: BuyerVerdict): ConflictException | null {
  if (verdict === 'other_coach') {
    return new ConflictException({ error: 'BUYER_HAS_COACH', message: SWITCH_V1_MESSAGE });
  }
  if (verdict === 'not_client') {
    return new ConflictException({ error: 'BUYER_NOT_CLIENT', message: NOT_CLIENT_MESSAGE });
  }
  return null;
}

/** "Hey {N}" uses the first name only. */
export function firstNameOf(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

// Every visible check reads the account the same way: one indexed lookup on
// the unique email column, case-insensitive like the DTO's lower-casing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function findBuyerAccount(db: any, email: string): Promise<BuyerAccount | null> {
  return db.user.findFirst({
    where: { email: { equals: email.toLowerCase().trim(), mode: 'insensitive' } },
    select: { id: true, name: true, role: true, coach_id: true },
  });
}

/** Shared HS256 key (CHECKOUT_RECOVERY_SECRET) for recovery links and buyer proofs. */
export function recoverySecretKey(config: ConfigService): Uint8Array {
  // Audit A276-F3-P2-1 — share the entropy floor with the boot validator
  // (≥256 bits per RFC 7518 §3.2 for HS256). Trim defensively so a
  // trailing newline from an operator paste doesn't slip through.
  const raw =
    config.get<string>('CHECKOUT_RECOVERY_SECRET') ?? process.env.CHECKOUT_RECOVERY_SECRET ?? '';
  const secret = raw.trim();
  if (!secret || secret.length < MIN_CHECKOUT_RECOVERY_SECRET_LENGTH) {
    throw new BadRequestException({
      error: 'CHECKOUT_RECOVERY_NOT_CONFIGURED',
      message: `Recovery secret not configured. Set CHECKOUT_RECOVERY_SECRET to a ${MIN_CHECKOUT_RECOVERY_SECRET_LENGTH}+ char value (256-bit entropy per RFC 7518 §3.2).`,
    });
  }
  return new TextEncoder().encode(secret);
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Opaque per-(email, package) key, so stored keys never carry the email. */
export function codeSlot(key: Uint8Array, email: string, shareToken: string): string {
  return createHmac('sha256', key).update(`slot:${email.toLowerCase()}|${shareToken}`).digest('hex');
}

/** Codes are stored only as this keyed hash. */
export function hashCode(key: Uint8Array, slot: string, code: string): string {
  return createHmac('sha256', key).update(`code:${slot}:${code}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Proof that this email passed the code for this package, carried into createIntent. */
export async function mintBuyerToken(key: Uint8Array, email: string, shareToken: string): Promise<string> {
  return new SignJWT({ em: email.toLowerCase(), st: shareToken, type: BUYER_TOKEN_TYPE })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${BUYER_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

export async function buyerTokenValid(
  key: Uint8Array,
  token: string | undefined,
  email: string,
  shareToken: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    return (
      payload.type === BUYER_TOKEN_TYPE &&
      payload.st === shareToken &&
      payload.em === email.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * createIntent gate: runs BEFORE any GuestCheckout row or Stripe object.
 * A new email passes untouched (#170-2). An existing email needs a fresh
 * proof for this email + package, then must be a buyer this coach can take.
 */
export async function assertBuyerMayPay(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  config: ConfigService,
  args: { shareToken: string; sellingCoachId: string; email: string; buyerToken?: string },
): Promise<BuyerVerdict> {
  const account = await findBuyerAccount(db, args.email);
  const verdict = buyerVerdict(account, args.sellingCoachId);
  if (verdict === 'new') return verdict;
  const key = recoverySecretKey(config);
  if (!(await buyerTokenValid(key, args.buyerToken, args.email, args.shareToken))) {
    throw new ForbiddenException({ error: 'BUYER_CODE_REQUIRED', message: CODE_REQUIRED_MESSAGE });
  }
  const refusal = buyerRefusal(verdict);
  if (refusal) throw refusal;
  return verdict;
}

/** Settlement boundary: the buyer's account gained another coach after the check. */
export class BuyerHasOtherCoachError extends Error {
  constructor() {
    super('buyer_has_other_coach');
    this.name = 'BuyerHasOtherCoachError';
  }
}
