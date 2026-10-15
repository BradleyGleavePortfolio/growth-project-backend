/**
 * AiConsentService — the AI processing consent ledger (R2a, D2 box 2).
 *
 *   getStatus(userId)            -> what GET /me/ai-consent returns
 *   grant(userId, dto, meta)     -> append a 'grant' row (idempotent)
 *   withdraw(userId, meta)       -> append a 'withdraw' row (idempotent)
 *   hasClientAiConsent(userId, scope?, audience?) -> ClientAiConsentReader (for R2b / AI paths)
 *   clientsWithAiConsent(ids, scope?, audience?)  -> ClientAiConsentReader batch form
 *
 * Accepted copies (client-ai-v5): a grant counts only for an accepted version
 * with that version's exact sha256 (CLIENT_AI_CONSENT_ACCEPTED). v4 gives the
 * 'base' scope (every day-1 AI path), v5 gives 'base' + 'memory' (Roman v1.1).
 * POST accepts v4 (the 10-07 app build) and v5. GET offers the v4 copy to
 * everyone without a live v5 grant, so the 10-07 contract is unchanged, and
 * adds `scope` plus, for a v4 holder, `upgrade` (the v5 copy, one optional
 * tap). `upgrade` is offered only while FEATURE_ROMAN_MEMORY is on: the v5
 * copy describes notes and summaries that do not exist while it is off, so
 * no client is asked to agree to them early. `memory_on` says so explicitly,
 * so an app can tell this server from an older one that sent `upgrade` to
 * every v4 holder. A withdrawal ends both scopes.
 *
 * Memory on by default (R11-C2B, owner 2026-10-07 10:18): while
 * FEATURE_ROMAN_MEMORY is on, GET also sends `memory_copy` (the v5 copy) to
 * everyone without a live v5 grant, so the one Roman tick in the
 * consultation (box 2) and Settings > Roman AI can grant client-ai-v5 with
 * the exact text shown. Memory off is a client-ai-v4 grant by a live v5
 * holder: Roman stays allowed under the base scope and the ledger row records
 * the v4 notice. Roman's notes are kept (owner ruling 2026-10-07 11:46: they
 * are deleted only with the account, by the deletion manifest); without the
 * 'memory' scope Roman does not read or write them. Turning it back on is a
 * v5 grant again, and Roman uses the kept notes again. A withdrawal keeps
 * them too.
 *
 * Coach-free copies (owner decision 62, 2026-10-12): a client with no coach
 * sees client-ai-v4-coach-free / client-ai-v5-coach-free (the same paragraphs
 * with every coach sentence or clause removed; same scopes, for the 'client'
 * audience only: a coach-free grant never covers coach AI drafts or
 * coach-method learning, also after the client joins a coach). The app asks
 * for them with GET ?variant=coach_free. For a client with a coach
 * (User.coach_id) GET reads a live coach-free grant as needs_reconsent with
 * the coached copy, so the app asks for the coached text; a live coached
 * grant reads its coached copies whatever is asked.
 *
 * Safety-reply exception (owner 57c, 2026-10-12): client-ai-v6 / v7 are the
 * coached v4 / v5 copies with one sentence added (a coach sees the message
 * behind an urgent medical or eating-disorder safety reply). With no live
 * grant, GET ?variant=safety_exception offers them; a plain GET keeps v4 / v5,
 * the text installed builds pin. A live grant reads its own generation, and its
 * memory offer follows the ask: a v4 holder who asks for v6 / v7 turns memory on
 * with client-ai-v7, the text the app shows (CONSENTV7). POST and DELETE read the
 * same ?variant= for their response; without one they read the copies on file.
 *
 * History is append-only: a decision is a new row with seq = latest.seq + 1.
 * The unique index (user_id, processor, purpose, seq) turns a race between two
 * writers into a P2002 on the loser, which re-reads and re-decides (so two
 * concurrent identical grants record ONE row). Rows are never updated; the DB
 * rejects UPDATE with a trigger.
 *
 * Tenancy: the subject is always the authenticated caller (controller passes
 * req.user.id); nothing in a request body can name another user.
 *
 * Logging (Sol A-R2-2 applied here): log lines carry ids, version and the
 * Prisma error CODE only. Never exception messages, request bodies or copy
 * text.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { isRomanMemoryEnabled } from '../roman/memory/roman-memory.feature';
import {
  AI_CONSENT_ACTION_GRANT,
  AI_CONSENT_ACTION_WITHDRAW,
  AI_CONSENT_BATCH_MAX,
  AI_CONSENT_ERROR_CONFLICT,
  AI_CONSENT_ERROR_UNAVAILABLE,
  AI_CONSENT_ERROR_VERSION_MISMATCH,
  AI_CONSENT_WRITE_ATTEMPTS,
  CLIENT_AI_CONSENT_BOX_LABEL,
  CLIENT_AI_CONSENT_BOX_LABEL_SHA256,
  CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
  CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL_SHA256,
  CLIENT_AI_CONSENT_COPY_SHA256,
  CLIENT_AI_CONSENT_PARAGRAPH,
  CLIENT_AI_CONSENT_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_PROCESSOR,
  CLIENT_AI_CONSENT_PURPOSE,
  CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256,
  CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH,
  CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_V4_COACH_FREE_VERSION,
  CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256,
  CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH,
  CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_V5_COACH_FREE_VERSION,
  CLIENT_AI_CONSENT_V5_COPY_SHA256,
  CLIENT_AI_CONSENT_V5_PARAGRAPH,
  CLIENT_AI_CONSENT_V5_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_V5_VERSION,
  CLIENT_AI_CONSENT_V6_COPY_SHA256,
  CLIENT_AI_CONSENT_V6_PARAGRAPH,
  CLIENT_AI_CONSENT_V6_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_V6_VERSION,
  CLIENT_AI_CONSENT_V7_COPY_SHA256,
  CLIENT_AI_CONSENT_V7_PARAGRAPH,
  CLIENT_AI_CONSENT_V7_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_V7_VERSION,
  CLIENT_AI_CONSENT_VERSION,
  acceptedClientAiConsent,
  isAiConsentLedgerEnabled,
  isCoachFreeClientAiVersion,
  type ClientAiConsentAudience,
  type ClientAiConsentScope,
} from './ai-consent.constants';
import type { GrantClientAiConsentDto } from './ai-consent.dto';
import type { ClientAiConsentReader } from './ai-consent.reader';

/** The latest-decision columns the service reads. */
export interface AiConsentLatestRow {
  seq: number;
  action: string;
  consent_version: string;
  copy_sha256: string;
  created_at: Date;
}

export type ClientAiConsentState = 'granted' | 'not_granted' | 'withdrawn' | 'needs_reconsent';

export interface ClientAiConsentCopy {
  version: string;
  processor: string;
  paragraph: { text: string; sha256: string };
  box_label: { text: string; sha256: string };
  /** sha256 of paragraph.text + "\n\n" + box_label.text (UTF-8). */
  sha256: string;
}

export interface ClientAiConsentStatus {
  purpose: string;
  processor: string;
  /** True only for a live grant of the current copy (version + sha256). */
  granted: boolean;
  state: ClientAiConsentState;
  /** Copy version of the latest decision (null if the user never decided). */
  version: string | null;
  /** Set when the latest decision is a grant. */
  granted_at: string | null;
  /** Set when the latest decision is a withdraw. */
  withdrawn_at: string | null;
  current_version: string;
  /** True when the latest decision is a grant of an older copy. */
  needs_reconsent: boolean;
  /**
   * The copy on offer: the v5 copy for a live v5 holder, otherwise the v4
   * copy (the 10-07 build pins v4). `current_version` is its version.
   */
  copy: ClientAiConsentCopy;
  /** What the live grant covers; null when there is no live grant. */
  scope: ClientAiConsentScope | null;
  /**
   * For a live base-only holder while FEATURE_ROMAN_MEMORY is on: the memory copy
   * the app asked for (v7 with ?variant=safety_exception, else that grant's own: v5
   * for v4, v7 for v6). Otherwise null (memory off, no live grant, or memory).
   */
  upgrade: ClientAiConsentCopy | null;
  /**
   * True while FEATURE_ROMAN_MEMORY is on. Absent on servers that offered
   * `upgrade` regardless of it; an app shows the v5 offer only when true.
   */
  memory_on: boolean;
  /**
   * R11-C2B: the v5 copy box 2 shows and grants while FEATURE_ROMAN_MEMORY is
   * on, for everyone without a live v5 grant (a v5 holder's `copy` is
   * already v5). Null while memory is off, so an app shows today's v4 text.
   */
  memory_copy: ClientAiConsentCopy | null;
}

/** The copies the app asked for (?variant=, see the controller). */
export interface ClientAiConsentAsk {
  coachFree?: boolean;
  hasCoach?: boolean;
  safetyException?: boolean;
}

export interface AiConsentRequestMeta {
  platform?: string | null;
  app_version?: string | null;
  locale?: string | null;
}

/** Pure: the scope a latest row gives, or null when it is not a live accepted grant. */
export function grantScope(row: AiConsentLatestRow | null): ClientAiConsentScope | null {
  if (row === null || row.action !== AI_CONSENT_ACTION_GRANT) return null;
  const accepted = acceptedClientAiConsent(row.consent_version);
  return accepted !== null && row.copy_sha256 === accepted.copy_sha256 ? accepted.scope : null;
}

/** Pure: a live grant of client-ai-v4 or client-ai-v5 with its exact sha256. */
export function isBaseGrant(row: AiConsentLatestRow | null): boolean {
  return grantScope(row) !== null;
}

/** Pure: a live grant of client-ai-v5 with its exact sha256 (Roman v1.1 memory). */
export function isMemoryGrant(row: AiConsentLatestRow | null): boolean {
  return grantScope(row) === 'memory';
}

/**
 * Pure: does this latest row cover `scope` for `audience`? A coach-free grant
 * covers the 'client' audience only (owner 62); the default is 'coach'.
 */
export function coversScope(
  row: AiConsentLatestRow | null,
  scope: ClientAiConsentScope,
  audience: ClientAiConsentAudience = 'coach',
): boolean {
  if (audience !== 'client' && isCoachFreeClientAiVersion(row?.consent_version)) return false;
  return scope === 'memory' ? isMemoryGrant(row) : isBaseGrant(row);
}

/**
 * Which copies a status carries: 'pre57c' client-ai-v4 / v5 (what a plain GET
 * offers, so installed builds keep their pinned text), 'coached' client-ai-v6 /
 * v7 (owner 57c, the safety-reply exception; GET ?variant=safety_exception),
 * 'coach_free' (owner 62).
 */
export type ClientAiCopyFamily = 'pre57c' | 'coached' | 'coach_free';

function familyOfVersion(version: unknown): ClientAiCopyFamily {
  if (isCoachFreeClientAiVersion(version)) return 'coach_free';
  return version === CLIENT_AI_CONSENT_V6_VERSION || version === CLIENT_AI_CONSENT_V7_VERSION
    ? 'coached'
    : 'pre57c';
}

/** The base ('base' scope) copy of `family`. */
export function clientAiConsentCopy(family: ClientAiCopyFamily = 'pre57c'): ClientAiConsentCopy {
  if (family === 'coached') {
    return {
      version: CLIENT_AI_CONSENT_V6_VERSION,
      processor: CLIENT_AI_CONSENT_PROCESSOR,
      paragraph: {
        text: CLIENT_AI_CONSENT_V6_PARAGRAPH,
        sha256: CLIENT_AI_CONSENT_V6_PARAGRAPH_SHA256,
      },
      box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: CLIENT_AI_CONSENT_BOX_LABEL_SHA256 },
      sha256: CLIENT_AI_CONSENT_V6_COPY_SHA256,
    };
  }
  if (family === 'coach_free') {
    return {
      version: CLIENT_AI_CONSENT_V4_COACH_FREE_VERSION,
      processor: CLIENT_AI_CONSENT_PROCESSOR,
      paragraph: {
        text: CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH,
        sha256: CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH_SHA256,
      },
      box_label: {
        text: CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
        sha256: CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL_SHA256,
      },
      sha256: CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256,
    };
  }
  return {
    version: CLIENT_AI_CONSENT_VERSION,
    processor: CLIENT_AI_CONSENT_PROCESSOR,
    paragraph: { text: CLIENT_AI_CONSENT_PARAGRAPH, sha256: CLIENT_AI_CONSENT_PARAGRAPH_SHA256 },
    box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: CLIENT_AI_CONSENT_BOX_LABEL_SHA256 },
    sha256: CLIENT_AI_CONSENT_COPY_SHA256,
  };
}

/** The memory-scope copy of `family`. */
export function clientAiConsentV5Copy(family: ClientAiCopyFamily = 'pre57c'): ClientAiConsentCopy {
  if (family === 'coached') {
    return {
      version: CLIENT_AI_CONSENT_V7_VERSION,
      processor: CLIENT_AI_CONSENT_PROCESSOR,
      paragraph: {
        text: CLIENT_AI_CONSENT_V7_PARAGRAPH,
        sha256: CLIENT_AI_CONSENT_V7_PARAGRAPH_SHA256,
      },
      box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: CLIENT_AI_CONSENT_BOX_LABEL_SHA256 },
      sha256: CLIENT_AI_CONSENT_V7_COPY_SHA256,
    };
  }
  if (family === 'coach_free') {
    return {
      version: CLIENT_AI_CONSENT_V5_COACH_FREE_VERSION,
      processor: CLIENT_AI_CONSENT_PROCESSOR,
      paragraph: {
        text: CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH,
        sha256: CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH_SHA256,
      },
      box_label: {
        text: CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
        sha256: CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL_SHA256,
      },
      sha256: CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256,
    };
  }
  return {
    version: CLIENT_AI_CONSENT_V5_VERSION,
    processor: CLIENT_AI_CONSENT_PROCESSOR,
    paragraph: {
      text: CLIENT_AI_CONSENT_V5_PARAGRAPH,
      sha256: CLIENT_AI_CONSENT_V5_PARAGRAPH_SHA256,
    },
    box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: CLIENT_AI_CONSENT_BOX_LABEL_SHA256 },
    sha256: CLIENT_AI_CONSENT_V5_COPY_SHA256,
  };
}

function prismaErrorCode(err: unknown): string {
  return err instanceof Prisma.PrismaClientKnownRequestError ? err.code : 'unknown';
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const LATEST_SELECT = {
  seq: true,
  action: true,
  consent_version: true,
  copy_sha256: true,
  created_at: true,
} as const;

@Injectable()
export class AiConsentService implements ClientAiConsentReader {
  private readonly logger = new Logger(AiConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 503 while the ledger flag is off (defence in depth behind the route guard). */
  assertEnabled(): void {
    if (!isAiConsentLedgerEnabled()) {
      throw new ServiceUnavailableException({
        code: AI_CONSENT_ERROR_UNAVAILABLE,
        message: 'This choice is unavailable right now.',
      });
    }
  }

  private async latest(userId: string): Promise<AiConsentLatestRow | null> {
    return this.prisma.aiProcessingConsentEvent.findFirst({
      where: {
        user_id: userId,
        processor: CLIENT_AI_CONSENT_PROCESSOR,
        purpose: CLIENT_AI_CONSENT_PURPOSE,
      },
      orderBy: { seq: 'desc' },
      select: LATEST_SELECT,
    });
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: AI_CONSENT_ERROR_UNAVAILABLE,
      message: 'This choice is unavailable right now.',
    });
  }

  /**
   * The latest decision for an HTTP operation (GET status, or the read that
   * precedes every grant / withdraw attempt). Any read failure is the
   * contract's 503 AI_CONSENT_UNAVAILABLE, never a generic 500 (Sol B-622-2);
   * the log carries the operation, user id and Prisma error code only.
   */
  private async latestOr503(userId: string, op: string): Promise<AiConsentLatestRow | null> {
    try {
      return await this.latest(userId);
    } catch (err) {
      this.logger.error(`ai_consent.${op}_read_failed user=${userId} code=${prismaErrorCode(err)}`);
      throw this.unavailable();
    }
  }

  /**
   * `askCoachFree` (GET, or a POST / DELETE with ?variant=): true for ?variant=coach_free
   * (the app's ask for a client with no coach), false for a plain GET. `hasCoach` (with it): the
   * caller has a coach (User.coach_id). For a client with a coach GET always
   * offers the coached copies, and a live coach-free grant never reads as live:
   * GET answers needs_reconsent, so the app asks for the coached text (owner 62;
   * Roman for the client stays covered server-side). Otherwise a live grant
   * reads the copies of its own family; with no live grant, GET follows the ask
   * and a POST / DELETE response with no ask follows the latest decision on file.
   * `askSafety` (GET ?variant=safety_exception, owner 57c): with no live grant
   * the coached copies are client-ai-v6 / v7, and a live v4 grant's memory offer is
   * client-ai-v7; a plain GET keeps v4 / v5, the text installed builds pin.
   */
  private toStatus(
    row: AiConsentLatestRow | null,
    askCoachFree?: boolean,
    hasCoach = false,
    askSafety = false,
  ): ClientAiConsentStatus {
    const onFile = familyOfVersion(row?.consent_version);
    const scope = hasCoach && onFile === 'coach_free' ? null : grantScope(row);
    const memoryOn = isRomanMemoryEnabled();
    const granted = scope !== null;
    const coachFree = granted
      ? onFile === 'coach_free'
      : !hasCoach && (askCoachFree ?? onFile === 'coach_free');
    // A live grant, and a POST / DELETE with no ?variant=, read the copies on file; else the ask.
    const coached = granted || askCoachFree === undefined ? onFile === 'coached' : askSafety;
    const family: ClientAiCopyFamily = coachFree ? 'coach_free' : coached ? 'coached' : 'pre57c';
    // A new agreement (memory on, Allow) is offered in the copies the app shows (CONSENTV7).
    const offer: ClientAiCopyFamily = askSafety && !coachFree ? 'coached' : family;
    const copy = scope === 'memory' ? clientAiConsentV5Copy(family) : clientAiConsentCopy(family);
    const isGrant = row?.action === AI_CONSENT_ACTION_GRANT;
    const isWithdraw = row?.action === AI_CONSENT_ACTION_WITHDRAW;
    let state: ClientAiConsentState = 'not_granted';
    if (granted) state = 'granted';
    else if (isGrant) state = 'needs_reconsent';
    else if (isWithdraw) state = 'withdrawn';
    return {
      purpose: CLIENT_AI_CONSENT_PURPOSE,
      processor: CLIENT_AI_CONSENT_PROCESSOR,
      granted,
      state,
      version: row?.consent_version ?? null,
      granted_at: isGrant && row ? row.created_at.toISOString() : null,
      withdrawn_at: isWithdraw && row ? row.created_at.toISOString() : null,
      current_version: copy.version,
      needs_reconsent: isGrant && !granted,
      copy,
      scope,
      upgrade: scope === 'base' && memoryOn ? clientAiConsentV5Copy(offer) : null,
      memory_on: memoryOn,
      memory_copy: memoryOn && scope !== 'memory' ? clientAiConsentV5Copy(offer) : null,
    };
  }

  /** toStatus for the request's ask; with none (POST / DELETE, no ?variant=) the copies on file. */
  private statusFor(
    row: AiConsentLatestRow | null,
    ask?: ClientAiConsentAsk,
  ): ClientAiConsentStatus {
    if (!ask) return this.toStatus(row);
    return this.toStatus(
      row,
      ask.coachFree === true,
      ask.hasCoach === true,
      ask.safetyException === true,
    );
  }

  async getStatus(userId: string, opts: ClientAiConsentAsk = {}): Promise<ClientAiConsentStatus> {
    this.assertEnabled();
    return this.statusFor(await this.latestOr503(userId, 'status'), opts);
  }

  /**
   * Record box 2 as allowed. 409 CONSENT_VERSION_MISMATCH (nothing written)
   * unless the client displayed an accepted version (client-ai-v4,
   * client-ai-v5 or their coach-free versions) and, when sent, that version's sha256. Idempotent: when the
   * latest decision is already a live grant of the same version, nothing is
   * written and the current status returns.
   *
   * A client-ai-v4 grant by a live client-ai-v5 holder is "Roman's memory"
   * switched off (R11-C2B): the v4 grant is appended and Roman's notes are
   * kept, unread without the 'memory' scope (R11-C2C, owner 11:46).
   */
  async grant(
    userId: string,
    dto: GrantClientAiConsentDto,
    meta: AiConsentRequestMeta = {},
    ask?: ClientAiConsentAsk,
  ): Promise<ClientAiConsentStatus> {
    this.assertEnabled();
    // Defence in depth behind the DTO (Sol B-622-3): a supplied digest must be
    // a string; null or any other type is a malformed request, never a crash.
    if (dto.copy_sha256 !== undefined && typeof dto.copy_sha256 !== 'string') {
      throw new BadRequestException('copy_sha256 must be a 64-character hex string');
    }
    const accepted = acceptedClientAiConsent(dto.version);
    const shaMismatch =
      accepted !== null &&
      dto.copy_sha256 !== undefined &&
      dto.copy_sha256.toLowerCase() !== accepted.copy_sha256;
    if (accepted === null || shaMismatch) {
      throw new ConflictException({
        code: AI_CONSENT_ERROR_VERSION_MISMATCH,
        current_version: CLIENT_AI_CONSENT_VERSION,
        copy_sha256: CLIENT_AI_CONSENT_COPY_SHA256,
        message: 'The wording has changed. Please review the current version.',
      });
    }
    return this.append(
      userId,
      AI_CONSENT_ACTION_GRANT,
      {
        platform: dto.platform ?? meta.platform ?? null,
        app_version: dto.app_version ?? meta.app_version ?? null,
        locale: dto.locale ?? meta.locale ?? null,
      },
      { version: dto.version, copy_sha256: accepted.copy_sha256 },
      ask,
    );
  }

  /**
   * Record box 2 as withdrawn. Idempotent: when there is no decision on record
   * or the latest decision is already a withdraw, nothing is written.
   */
  async withdraw(
    userId: string,
    meta: AiConsentRequestMeta = {},
    ask?: ClientAiConsentAsk,
  ): Promise<ClientAiConsentStatus> {
    this.assertEnabled();
    return this.append(
      userId,
      AI_CONSENT_ACTION_WITHDRAW,
      {
        platform: meta.platform ?? null,
        app_version: meta.app_version ?? null,
        locale: meta.locale ?? null,
      },
      undefined,
      ask,
    );
  }

  private async append(
    userId: string,
    action: typeof AI_CONSENT_ACTION_GRANT | typeof AI_CONSENT_ACTION_WITHDRAW,
    meta: { platform: string | null; app_version: string | null; locale: string | null },
    /** The accepted copy a grant records (the v4 copy when omitted). */
    grantCopy: { version: string; copy_sha256: string } = {
      version: CLIENT_AI_CONSENT_VERSION,
      copy_sha256: CLIENT_AI_CONSENT_COPY_SHA256,
    },
    ask?: ClientAiConsentAsk,
  ): Promise<ClientAiConsentStatus> {
    for (let attempt = 1; attempt <= AI_CONSENT_WRITE_ATTEMPTS; attempt += 1) {
      // Re-read on every attempt (a P2002 means another writer won); a failed
      // read is 503 like a failed write.
      const row = await this.latestOr503(userId, action);
      if (
        action === AI_CONSENT_ACTION_GRANT &&
        row !== null &&
        isBaseGrant(row) &&
        row.consent_version === grantCopy.version
      ) {
        return this.statusFor(row, ask);
      }
      if (
        action === AI_CONSENT_ACTION_WITHDRAW &&
        (row === null || row.action === AI_CONSENT_ACTION_WITHDRAW)
      ) {
        return this.statusFor(row, ask);
      }
      // A withdraw refers to the grant it ends; a grant to the copy it accepts.
      const consent_version =
        action === AI_CONSENT_ACTION_GRANT || row === null ? grantCopy.version : row.consent_version;
      const copy_sha256 =
        action === AI_CONSENT_ACTION_GRANT || row === null
          ? grantCopy.copy_sha256
          : row.copy_sha256;
      try {
        const created = await this.prisma.aiProcessingConsentEvent.create({
          data: {
            user_id: userId,
            processor: CLIENT_AI_CONSENT_PROCESSOR,
            purpose: CLIENT_AI_CONSENT_PURPOSE,
            seq: (row?.seq ?? 0) + 1,
            action,
            consent_version,
            copy_sha256,
            platform: meta.platform,
            app_version: meta.app_version,
            locale: meta.locale,
          },
          select: LATEST_SELECT,
        });
        this.logger.log(
          `ai_consent.${action} user=${userId} version=${consent_version} seq=${created.seq}`,
        );
        return this.statusFor(created, ask);
      } catch (err) {
        if (isUniqueViolation(err) && attempt < AI_CONSENT_WRITE_ATTEMPTS) continue;
        if (isUniqueViolation(err)) {
          this.logger.warn(`ai_consent.${action}_contended user=${userId}`);
          throw new ConflictException({
            code: AI_CONSENT_ERROR_CONFLICT,
            message: 'Another change to this choice is in progress. Please try again.',
          });
        }
        this.logger.error(`ai_consent.${action}_failed user=${userId} code=${prismaErrorCode(err)}`);
        throw this.unavailable();
      }
    }
    // Unreachable: the loop either returns or throws on its last attempt.
    throw this.unavailable();
  }

  // ---------------------------------------------------------------------------
  // ClientAiConsentReader — the narrow interface for R2b and every AI path.
  // ---------------------------------------------------------------------------

  async hasClientAiConsent(
    userId: string,
    scope: ClientAiConsentScope = 'base',
    audience: ClientAiConsentAudience = 'coach',
  ): Promise<boolean> {
    if (!isAiConsentLedgerEnabled()) return false;
    if (typeof userId !== 'string' || userId.length === 0) return false;
    try {
      return coversScope(await this.latest(userId), scope, audience);
    } catch (err) {
      this.logger.warn(`ai_consent.read_failed code=${prismaErrorCode(err)}`);
      return false;
    }
  }

  async clientsWithAiConsent(
    userIds: readonly string[],
    scope: ClientAiConsentScope = 'base',
    audience: ClientAiConsentAudience = 'coach',
  ): Promise<ReadonlySet<string>> {
    const unique = batchIds(userIds, 'clientsWithAiConsent');
    if (!isAiConsentLedgerEnabled() || unique.length === 0) return new Set();
    try {
      const out = new Set<string>();
      for (const [id, row] of await this.latestByUser(unique)) {
        if (coversScope(row, scope, audience)) out.add(id);
      }
      return out;
    } catch (err) {
      this.logger.warn(`ai_consent.batch_read_failed code=${prismaErrorCode(err)}`);
      return new Set();
    }
  }

  /** R11-M4: grant time of each live client-ai-v5 ('memory') grant among `userIds`. */
  async memoryGrantTimes(
    userIds: readonly string[],
    audience: ClientAiConsentAudience = 'coach',
  ): Promise<ReadonlyMap<string, Date>> {
    const unique = batchIds(userIds, 'memoryGrantTimes');
    if (!isAiConsentLedgerEnabled() || unique.length === 0) return new Map();
    try {
      const out = new Map<string, Date>();
      for (const [id, row] of await this.latestByUser(unique)) {
        if (coversScope(row, 'memory', audience)) out.set(id, row.created_at);
      }
      return out;
    } catch (err) {
      this.logger.warn(`ai_consent.batch_read_failed code=${prismaErrorCode(err)}`);
      return new Map();
    }
  }

  /** Latest decision per user = highest seq (independent of row order). Throws on a read failure. */
  private async latestByUser(unique: string[]): Promise<Map<string, AiConsentLatestRow>> {
    const rows = await this.prisma.aiProcessingConsentEvent.findMany({
      where: {
        user_id: { in: unique },
        processor: CLIENT_AI_CONSENT_PROCESSOR,
        purpose: CLIENT_AI_CONSENT_PURPOSE,
      },
      select: { user_id: true, ...LATEST_SELECT },
    });
    const latest = new Map<string, AiConsentLatestRow>();
    for (const row of rows) {
      const prev = latest.get(row.user_id);
      if (!prev || row.seq > prev.seq) latest.set(row.user_id, row);
    }
    return latest;
  }
}

function batchIds(userIds: readonly string[], method: string): string[] {
  const unique = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length > AI_CONSENT_BATCH_MAX) {
    throw new RangeError(`${method} accepts at most ${AI_CONSENT_BATCH_MAX} ids`);
  }
  return unique;
}
