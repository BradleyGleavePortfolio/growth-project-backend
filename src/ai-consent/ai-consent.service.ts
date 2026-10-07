/**
 * AiConsentService — the AI processing consent ledger (R2a, D2 box 2).
 *
 *   getStatus(userId)            -> what GET /me/ai-consent returns
 *   grant(userId, dto, meta)     -> append a 'grant' row (idempotent)
 *   withdraw(userId, meta)       -> append a 'withdraw' row (idempotent)
 *   hasClientAiConsent(userId, scope?) -> ClientAiConsentReader (for R2b / AI paths)
 *   clientsWithAiConsent(ids, scope?)  -> ClientAiConsentReader batch form
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
  CLIENT_AI_CONSENT_COPY_SHA256,
  CLIENT_AI_CONSENT_PARAGRAPH,
  CLIENT_AI_CONSENT_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_PROCESSOR,
  CLIENT_AI_CONSENT_PURPOSE,
  CLIENT_AI_CONSENT_V5_COPY_SHA256,
  CLIENT_AI_CONSENT_V5_PARAGRAPH,
  CLIENT_AI_CONSENT_V5_PARAGRAPH_SHA256,
  CLIENT_AI_CONSENT_V5_VERSION,
  CLIENT_AI_CONSENT_VERSION,
  acceptedClientAiConsent,
  isAiConsentLedgerEnabled,
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
   * For a live v4 (base-only) holder while FEATURE_ROMAN_MEMORY is on: the v5
   * copy that adds 'memory'. Otherwise null (memory off, no live grant, or v5).
   */
  upgrade: ClientAiConsentCopy | null;
  /**
   * True while FEATURE_ROMAN_MEMORY is on. Absent on servers that offered
   * `upgrade` regardless of it; an app shows the v5 offer only when true.
   */
  memory_on: boolean;
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

/** Pure: does this latest row cover `scope`? */
export function coversScope(row: AiConsentLatestRow | null, scope: ClientAiConsentScope): boolean {
  return scope === 'memory' ? isMemoryGrant(row) : isBaseGrant(row);
}

/** The v4 copy: offered to everyone without a live v5 grant. */
export function clientAiConsentCopy(): ClientAiConsentCopy {
  return {
    version: CLIENT_AI_CONSENT_VERSION,
    processor: CLIENT_AI_CONSENT_PROCESSOR,
    paragraph: { text: CLIENT_AI_CONSENT_PARAGRAPH, sha256: CLIENT_AI_CONSENT_PARAGRAPH_SHA256 },
    box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: CLIENT_AI_CONSENT_BOX_LABEL_SHA256 },
    sha256: CLIENT_AI_CONSENT_COPY_SHA256,
  };
}

/** The v5 copy (memory scope). */
export function clientAiConsentV5Copy(): ClientAiConsentCopy {
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

  private toStatus(row: AiConsentLatestRow | null): ClientAiConsentStatus {
    const scope = grantScope(row);
    const memoryOn = isRomanMemoryEnabled();
    const granted = scope !== null;
    const copy = scope === 'memory' ? clientAiConsentV5Copy() : clientAiConsentCopy();
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
      upgrade: scope === 'base' && memoryOn ? clientAiConsentV5Copy() : null,
      memory_on: memoryOn,
    };
  }

  async getStatus(userId: string): Promise<ClientAiConsentStatus> {
    this.assertEnabled();
    return this.toStatus(await this.latestOr503(userId, 'status'));
  }

  /**
   * Record box 2 as allowed. 409 CONSENT_VERSION_MISMATCH (nothing written)
   * unless the client displayed an accepted version (client-ai-v4 or
   * client-ai-v5) and, when sent, that version's sha256. Idempotent: when the
   * latest decision is already a live grant of the same version, nothing is
   * written and the current status returns.
   */
  async grant(
    userId: string,
    dto: GrantClientAiConsentDto,
    meta: AiConsentRequestMeta = {},
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
    );
  }

  /**
   * Record box 2 as withdrawn. Idempotent: when there is no decision on record
   * or the latest decision is already a withdraw, nothing is written.
   */
  async withdraw(userId: string, meta: AiConsentRequestMeta = {}): Promise<ClientAiConsentStatus> {
    this.assertEnabled();
    return this.append(userId, AI_CONSENT_ACTION_WITHDRAW, {
      platform: meta.platform ?? null,
      app_version: meta.app_version ?? null,
      locale: meta.locale ?? null,
    });
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
        return this.toStatus(row);
      }
      if (
        action === AI_CONSENT_ACTION_WITHDRAW &&
        (row === null || row.action === AI_CONSENT_ACTION_WITHDRAW)
      ) {
        return this.toStatus(row);
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
        return this.toStatus(created);
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

  async hasClientAiConsent(userId: string, scope: ClientAiConsentScope = 'base'): Promise<boolean> {
    if (!isAiConsentLedgerEnabled()) return false;
    if (typeof userId !== 'string' || userId.length === 0) return false;
    try {
      return coversScope(await this.latest(userId), scope);
    } catch (err) {
      this.logger.warn(`ai_consent.read_failed code=${prismaErrorCode(err)}`);
      return false;
    }
  }

  async clientsWithAiConsent(
    userIds: readonly string[],
    scope: ClientAiConsentScope = 'base',
  ): Promise<ReadonlySet<string>> {
    const unique = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length > AI_CONSENT_BATCH_MAX) {
      throw new RangeError(`clientsWithAiConsent accepts at most ${AI_CONSENT_BATCH_MAX} ids`);
    }
    if (!isAiConsentLedgerEnabled() || unique.length === 0) return new Set();
    try {
      const rows = await this.prisma.aiProcessingConsentEvent.findMany({
        where: {
          user_id: { in: unique },
          processor: CLIENT_AI_CONSENT_PROCESSOR,
          purpose: CLIENT_AI_CONSENT_PURPOSE,
        },
        select: { user_id: true, ...LATEST_SELECT },
      });
      // Latest decision per user = highest seq (independent of row order).
      const latestByUser = new Map<string, AiConsentLatestRow>();
      for (const row of rows) {
        const prev = latestByUser.get(row.user_id);
        if (!prev || row.seq > prev.seq) latestByUser.set(row.user_id, row);
      }
      const out = new Set<string>();
      for (const [id, row] of latestByUser) if (coversScope(row, scope)) out.add(id);
      return out;
    } catch (err) {
      this.logger.warn(`ai_consent.batch_read_failed code=${prismaErrorCode(err)}`);
      return new Set();
    }
  }
}
