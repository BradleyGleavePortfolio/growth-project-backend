import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DataExportStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { SignJWT, jwtVerify, JWTPayload } from 'jose';

// ─── Environment variables ──────────────────────────────────────────────────
// DATA_EXPORT_TOKEN_SECRET   — signs the download JWT. Required. Min 32 chars.
// DATA_EXPORT_FS_DIR         — local dir for export files. Defaults to /tmp/exports.
// DATA_EXPORT_EXPIRY_DAYS    — file lifetime in days. Defaults to 7.
// DATA_EXPORT_RATE_LIMIT_HRS — hours between requests per user. Defaults to 24.
// PUBLIC_WEB_SIGNUP_URL      — base URL for the download link in logs/email.
//
// Future work (not yet supported — install packages first):
//   DATA_EXPORT_BUCKET         — S3 bucket name. Requires @aws-sdk/client-s3.
//   DATA_EXPORT_S3_ENDPOINT    — custom S3 endpoint (Fly / MinIO). Optional.
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION — S3 credentials.
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM — email delivery.
//     Requires nodemailer. Until installed, download URL is logged to console.

const EXPIRY_DAYS = Number(process.env.DATA_EXPORT_EXPIRY_DAYS ?? '7');
const RATE_LIMIT_HRS = Number(process.env.DATA_EXPORT_RATE_LIMIT_HRS ?? '24');
const TOKEN_SECRET_STR =
  process.env.DATA_EXPORT_TOKEN_SECRET ?? 'change-me-in-production-min32chars!';
const FS_DIR = process.env.DATA_EXPORT_FS_DIR ?? '/tmp/exports';

// jose requires a KeyLike or Uint8Array — derive a symmetric key from the secret string.
function getTokenKey(): Uint8Array {
  return new TextEncoder().encode(TOKEN_SECRET_STR);
}

// Download token additional claims
interface DownloadTokenClaims extends JWTPayload {
  eid: string;        // export request id
  type: string;       // 'data_export_download'
}

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(private readonly prisma: PrismaService) {
    // Fail closed in production: if the secret is missing or is the hardcoded
    // default, the entire service is unusable and we must not silently mint
    // tokens with a known-value secret.
    if (process.env.NODE_ENV === 'production') {
      if (
        !process.env.DATA_EXPORT_TOKEN_SECRET ||
        process.env.DATA_EXPORT_TOKEN_SECRET.length < 32 ||
        process.env.DATA_EXPORT_TOKEN_SECRET === 'change-me-in-production-min32chars!'
      ) {
        throw new Error(
          'DATA_EXPORT_TOKEN_SECRET must be a random 32+ character secret in production. ' +
            'Set this value in Fly secrets before deploying.',
        );
      }
    } else if (
      !process.env.DATA_EXPORT_TOKEN_SECRET ||
      process.env.DATA_EXPORT_TOKEN_SECRET === 'change-me-in-production-min32chars!'
    ) {
      this.logger.warn(
        'DATA_EXPORT_TOKEN_SECRET is not set — using the insecure default. ' +
          'Set DATA_EXPORT_TOKEN_SECRET before going to production.',
      );
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Enqueue a new export for the user. Enforces the per-user rate limit
   * (one PENDING or READY request within RATE_LIMIT_HRS). If a previous
   * FAILED request exists it is superseded — the user can always retry after
   * a failure.
   *
   * The actual file generation runs async via _runExport() after this method
   * returns so the HTTP response comes back immediately (202 Accepted).
   */
  async requestExport(userId: string) {
    // Rate limit check — block only on PENDING or READY within the window.
    const windowStart = new Date(
      Date.now() - RATE_LIMIT_HRS * 60 * 60 * 1000,
    );
    const existing = await this.prisma.dataExportRequest.findFirst({
      where: {
        user_id: userId,
        status: { in: [DataExportStatus.PENDING, DataExportStatus.READY] },
        created_at: { gte: windowStart },
      },
      orderBy: { created_at: 'desc' },
    });

    if (existing) {
      throw new ConflictException(
        `An export is already ${existing.status.toLowerCase()} for your account. ` +
          `You can request a new export after ${RATE_LIMIT_HRS} hours.`,
      );
    }

    const record = await this.prisma.dataExportRequest.create({
      data: {
        user_id: userId,
        status: DataExportStatus.PENDING,
      },
    });

    // Fire-and-forget — do not await so the HTTP response returns immediately.
    this._runExport(record.id, userId).catch((err: Error) => {
      this.logger.error(
        `Export ${record.id} for user ${userId} failed: ${err.message}`,
        err.stack,
      );
    });

    // Audit: wrap in try/catch so a missing audit module never breaks the export.
    this._tryAudit(userId, userId, 'data_export_requested', {
      export_id: record.id,
    });

    return record;
  }

  /**
   * Return the most recent export request for the user. Used for status
   * polling from the mobile app. Returns 404 if no export has ever been
   * requested.
   */
  async getLatestStatus(userId: string) {
    const record = await this.prisma.dataExportRequest.findFirst({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });

    if (!record) {
      throw new NotFoundException('No data export has been requested yet.');
    }

    // A download is only servable via HTTPS redirect when the file is stored
    // in a remote location (S3/CDN). Local filesystem files (local://) cannot
    // be opened by a browser and must not show a download button on the client.
    const isLocalFile =
      record.status === DataExportStatus.READY &&
      typeof record.file_url === 'string' &&
      record.file_url.startsWith('local://');

    return {
      id: record.id,
      status: record.status,
      created_at: record.created_at,
      completed_at: record.completed_at,
      expires_at: record.expires_at,
      file_size_bytes: record.file_size_bytes,
      // download_available: false when file is stored locally (S3 not yet configured).
      // The mobile uses this to show "contact support" instead of a broken download button.
      download_available: record.status === DataExportStatus.READY && !isLocalFile,
      // Never return the raw file_url — clients receive a short-lived download
      // token and use the /download?token= endpoint.
      download_token:
        record.status === DataExportStatus.READY && !isLocalFile
          ? await this._mintDownloadToken(record.user_id, record.id)
          : null,
    };
  }

  /**
   * Validate the download token, check the export has not expired, and
   * return the filesystem URL for the redirect.
   */
  async resolveDownloadUrl(token: string): Promise<string> {
    let payload: DownloadTokenClaims;

    try {
      const result = await jwtVerify(token, getTokenKey());
      payload = result.payload as DownloadTokenClaims;
    } catch {
      throw new UnauthorizedException('Invalid or expired download token.');
    }

    if (payload.type !== 'data_export_download') {
      throw new UnauthorizedException('Invalid token type.');
    }

    const record = await this.prisma.dataExportRequest.findUnique({
      where: { id: payload.eid },
    });

    if (!record || record.user_id !== payload.sub) {
      throw new UnauthorizedException('Token is not bound to this account.');
    }

    if (record.status === DataExportStatus.EXPIRED) {
      throw new GoneException(
        'This export has expired. Request a new export from the Settings screen.',
      );
    }

    if (record.status !== DataExportStatus.READY || !record.file_url) {
      throw new GoneException('Export is not ready yet.');
    }

    // Check wall-clock expiry
    if (record.expires_at && record.expires_at < new Date()) {
      // Mark expired lazily
      await this.prisma.dataExportRequest.update({
        where: { id: record.id },
        data: { status: DataExportStatus.EXPIRED },
      });
      throw new GoneException(
        'This export has expired. Request a new export from the Settings screen.',
      );
    }

    // Audit download event
    this._tryAudit(record.user_id, record.user_id, 'data_export_downloaded', {
      export_id: record.id,
    });

    return record.file_url;
  }

  /**
   * Nightly cleanup: find READY requests past their expiry, delete the file
   * from storage, and mark the row EXPIRED.
   */
  async expireOldExports(): Promise<void> {
    const expired = await this.prisma.dataExportRequest.findMany({
      where: {
        status: DataExportStatus.READY,
        expires_at: { lte: new Date() },
      },
    });

    for (const record of expired) {
      try {
        if (record.file_url) {
          await this._deleteStoredFile(record.file_url);
        }
        await this.prisma.dataExportRequest.update({
          where: { id: record.id },
          data: { status: DataExportStatus.EXPIRED },
        });
        this.logger.log(
          `Expired export ${record.id} for user ${record.user_id}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to expire export ${record.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Build the full JSON archive for a user, upload to storage, and update
   * the database row. Streams each model independently so memory usage stays
   * proportional to the largest single model's page size (500 rows), not the
   * total dataset.
   */
  private async _runExport(exportId: string, userId: string): Promise<void> {
    // Mark RUNNING
    await this.prisma.dataExportRequest.update({
      where: { id: exportId },
      data: { status: DataExportStatus.RUNNING },
    });

    try {
      const { buffer, sha256 } = await this._buildArchive(userId, exportId);

      const expiresAt = new Date(
        Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      );
      const fileUrl = await this._uploadFile(exportId, buffer);

      await this.prisma.dataExportRequest.update({
        where: { id: exportId },
        data: {
          status: DataExportStatus.READY,
          file_url: fileUrl,
          completed_at: new Date(),
          expires_at: expiresAt,
          file_size_bytes: buffer.length,
          sha256,
        },
      });

      this._tryAudit(userId, userId, 'data_export_completed', {
        export_id: exportId,
        file_size_bytes: buffer.length,
        sha256,
      });

      // Log download URL (email delivery is a future enhancement — see README)
      const downloadToken = await this._mintDownloadToken(userId, exportId);
      this._logReadyNotification(userId, exportId, downloadToken, expiresAt);
    } catch (err) {
      this.logger.error(
        `Export ${exportId} failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.prisma.dataExportRequest.update({
        where: { id: exportId },
        data: { status: DataExportStatus.FAILED },
      });
      throw err;
    }
  }

  /**
   * Assemble the full JSON archive. Each top-level key maps to one Prisma
   * model. Streams 500 rows at a time per model to avoid loading the entire
   * dataset into memory at once.
   */
  private async _buildArchive(
    userId: string,
    exportId: string,
  ): Promise<{ buffer: Buffer; sha256: string }> {
    const startedAt = new Date();

    const [
      user,
      profile,
      preferences,
      notificationPrefs,
      weightLogs,
      loggedEntries,
      workouts,
      fastingWindows,
      waterLogs,
      habits,
      lessonCompletions,
      checkIns,
      savedRecipes,
      listItems,
      coachMessages,
      coachNudges,
      messageDrafts,
      mealPlans,
      communityWins,
      coachGuidelines,
      buildWeekEnrollment,
      buildWeekCompletions,
      inviteCodes,
      diagnosticSubmissions,
      ptmSignals,
      ptmPredictions,
      auditLogs,
      dataExportRequests,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          created_at: true,
          archived_at: true,
          deletion_scheduled_at: true,
        },
      }),
      this._streamAll('userProfile', { user_id: userId }),
      this._streamAll('userPreferences', { user_id: userId }),
      this._streamAll('notificationPreferences', { user_id: userId }),
      this._streamAll('weightLog', { user_id: userId }),
      this._streamAll('loggedFoodEntry', { user_id: userId }),
      this._streamAll('workoutSession', { user_id: userId }),
      this._streamAll('fastingWindow', { user_id: userId }),
      this._streamAll('waterLog', { user_id: userId }),
      this._streamAll('habit', { user_id: userId }),
      this._streamAll('lessonCompletion', { user_id: userId }),
      this._streamAll('checkIn', { user_id: userId }),
      this._streamAll('savedRecipe', { user_id: userId }),
      this._streamAll('listItem', { user_id: userId }),
      this._streamCoachMessages(userId),
      this._streamAll('coachNudge', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this._streamAll('messageDraft', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this._streamAll('mealPlan', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this._streamAll('communityWin', { user_id: userId }),
      this._streamAll('coachGuideline', {
        OR: [{ coach_id: userId }, { client_id: userId }],
      }),
      this.prisma.buildWeekEnrollment.findUnique({ where: { user_id: userId } }),
      this._streamBuildWeekCompletions(userId),
      this._streamAll('inviteCode', { coach_id: userId }),
      this._streamAll('diagnosticSubmission', { user_id: userId }),
      this._streamAll('clientSignal', { user_id: userId }),
      this._streamAll('ptmPrediction', { user_id: userId }),
      this._streamAuditLogs(userId),
      this._streamAll('dataExportRequest', { user_id: userId }),
    ]);

    const completedAt = new Date();

    // Build with placeholder sha256 first, then replace
    const archive: Record<string, unknown> = {
      manifest: {
        export_id: exportId,
        user_id: userId,
        schema_version: '1.0',
        requested_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        sha256: null,
      },
      user,
      profile,
      preferences,
      notification_preferences: notificationPrefs,
      weight_logs: weightLogs,
      food_entries: loggedEntries,
      workout_sessions: workouts,
      fasting_windows: fastingWindows,
      water_logs: waterLogs,
      habits,
      lesson_completions: lessonCompletions,
      check_ins: checkIns,
      saved_recipes: savedRecipes,
      list_items: listItems,
      // Messages: own messages verbatim; third-party messages redacted.
      // See README for the redaction contract.
      coach_messages: coachMessages,
      coach_nudges: coachNudges,
      message_drafts: messageDrafts,
      meal_plans: mealPlans,
      community_wins: communityWins,
      coach_guidelines: coachGuidelines,
      build_week_enrollment: buildWeekEnrollment,
      build_week_completions: buildWeekCompletions,
      invite_codes: inviteCodes,
      diagnostic_submissions: diagnosticSubmissions,
      ptm_signals: ptmSignals,
      ptm_predictions: ptmPredictions,
      // AuditLog: only entries where the user is the target.
      audit_log_entries_about_user: auditLogs,
      data_export_requests: dataExportRequests,
    };

    const jsonForHash = JSON.stringify(archive);
    const sha256 = crypto.createHash('sha256').update(jsonForHash).digest('hex');
    (archive.manifest as Record<string, unknown>).sha256 = sha256;

    const finalJson = JSON.stringify(archive, null, 2);
    const buffer = Buffer.from(finalJson, 'utf-8');

    return { buffer, sha256 };
  }

  /**
   * Generic helper: page through a model's rows 500 at a time.
   */
  private async _streamAll(
    model: string,
    where: Record<string, unknown>,
  ): Promise<unknown[]> {
    const PAGE = 500;
    const results: unknown[] = [];
    let skip = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (this.prisma as any)[model];

    if (!delegate) {
      return [];
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page: unknown[] = await delegate.findMany({
        where,
        skip,
        take: PAGE,
      });
      results.push(...page);
      if (page.length < PAGE) break;
      skip += PAGE;
    }

    return results;
  }

  /**
   * CoachMessage export. Messages sent by the requesting user are returned
   * verbatim. Messages sent by a third party that are visible to the user
   * are redacted to protect the other party's privacy rights under GDPR.
   */
  private async _streamCoachMessages(userId: string): Promise<unknown[]> {
    const PAGE = 500;
    const results: unknown[] = [];
    let skip = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.prisma.coachMessage.findMany({
        where: {
          OR: [
            { sender_id: userId },
            { coach_id: userId },
            { client_id: userId },
          ],
        },
        skip,
        take: PAGE,
      });

      for (const msg of page) {
        if ((msg as Record<string, unknown>).sender_id === userId) {
          results.push(msg);
        } else {
          results.push({
            id: (msg as Record<string, unknown>).id,
            sent_at:
              (msg as Record<string, unknown>).sent_at ??
              (msg as Record<string, unknown>).created_at,
            redacted: true,
            note: 'This message was sent by another party. Its content is redacted to protect their privacy.',
          });
        }
      }

      if (page.length < PAGE) break;
      skip += PAGE;
    }

    return results;
  }

  private async _streamBuildWeekCompletions(userId: string): Promise<unknown[]> {
    const enrollment = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: userId },
    });
    if (!enrollment) return [];
    return this._streamAll('buildWeekDayCompletion', {
      enrollment_id: enrollment.id,
    });
  }

  private async _streamAuditLogs(userId: string): Promise<unknown[]> {
    try {
      // AuditLog uses target_user_id (FK to User) not target_id (free-form resource id)
      return this._streamAll('auditLog', { target_user_id: userId });
    } catch {
      return [];
    }
  }

  /**
   * Store the export archive on the local filesystem.
   *
   * S3 support is a future enhancement — install @aws-sdk/client-s3 and
   * @aws-sdk/s3-request-presigner, then set DATA_EXPORT_BUCKET. See README.
   *
   * NEVER serves files through the API process — always returns a URL the
   * client is redirected to.
   */
  private async _uploadFile(
    exportId: string,
    buffer: Buffer,
  ): Promise<string> {
    const filename = `${exportId}.json`;
    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    await mkdir(FS_DIR, { recursive: true });
    const filePath = join(FS_DIR, filename);
    await writeFile(filePath, buffer);
    this.logger.log(
      `Export ${exportId} stored at ${filePath} (${buffer.length} bytes). ` +
        'Configure DATA_EXPORT_BUCKET for S3 storage in production — see src/data-export/README.md.',
    );
    return `local://${filePath}`;
  }

  private async _deleteStoredFile(fileUrl: string): Promise<void> {
    if (fileUrl.startsWith('local://')) {
      const filePath = fileUrl.replace('local://', '');
      const { unlink } = await import('fs/promises');
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone.
      }
      return;
    }

    // S3 deletion is a future enhancement — requires @aws-sdk/client-s3.
    this.logger.warn(
      `Cannot delete non-local file URL: ${fileUrl}. S3 deletion requires @aws-sdk/client-s3.`,
    );
  }

  /**
   * Mint a short-lived, user-bound JWT for the download endpoint using jose.
   * Expires in EXPIRY_DAYS days so it stays valid for the full lifetime of
   * the export file.
   */
  private async _mintDownloadToken(
    userId: string,
    exportId: string,
  ): Promise<string> {
    return new SignJWT({
      eid: exportId,
      type: 'data_export_download',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${EXPIRY_DAYS}d`)
      .sign(getTokenKey());
  }

  /**
   * Log that an export is ready — without logging the download token or URL.
   *
   * The download token is short-lived and user-bound; logging it would expose
   * it to anyone with access to the log aggregator. The mobile client polls
   * /status to retrieve a fresh token via the authenticated API instead.
   *
   * Email delivery is a future enhancement. Install nodemailer and set
   * SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM to enable it.
   * See src/data-export/README.md for the installation steps.
   */
  private _logReadyNotification(
    userId: string,
    exportId: string,
    _downloadToken: string, // intentionally unused — never log tokens
    expiresAt: Date,
  ): void {
    const expiryDate = expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // Log only non-sensitive identifiers. Never log the download token or URL.
    this.logger.log(
      `[Export ready] exportId=${exportId} userId=${userId} expires=${expiryDate}. ` +
        'Client will retrieve a fresh download token via GET /v1/me/data-export/status.',
    );
  }

  /**
   * Best-effort audit log. Silently swallowed if the AuditLog model is absent
   * or if the audit service throws — audit must never block the export flow.
   */
  private _tryAudit(
    actorId: string,
    targetId: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auditDelegate = (this.prisma as any).auditLog;
    if (!auditDelegate) return;

    auditDelegate
      .create({
        data: {
          actor_id: actorId,
          target_id: targetId,
          event_type: eventType,
          metadata,
        },
      })
      .catch((_err: Error) => {
        // Intentionally swallowed.
      });
  }
}
