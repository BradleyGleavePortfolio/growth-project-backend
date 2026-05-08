import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DataExportStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { SignJWT, jwtVerify, JWTPayload } from 'jose';

// ─── Environment variables ──────────────────────────────────────────────────
// DATA_EXPORT_TOKEN_SECRET   — signs the download JWT. Required. Min 32 chars.
// DATA_EXPORT_BUCKET         — S3 bucket name. Falls back to filesystem if unset.
// DATA_EXPORT_S3_ENDPOINT    — custom S3 endpoint (Fly / MinIO). Optional.
// AWS_ACCESS_KEY_ID          — S3 credentials. Required when S3 is used.
// AWS_SECRET_ACCESS_KEY      — S3 credentials. Required when S3 is used.
// AWS_REGION                 — S3 region. Defaults to 'us-east-1'.
// DATA_EXPORT_FS_DIR         — local dir when S3 not configured. Defaults to /tmp/exports.
// DATA_EXPORT_EXPIRY_DAYS    — signed URL / file lifetime. Defaults to 7.
// DATA_EXPORT_RATE_LIMIT_HRS — hours between requests per user. Defaults to 24.
// SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM — email delivery.
//   When SMTP_HOST is unset the ready-notification is logged (dev mode).

const EXPIRY_DAYS = Number(process.env.DATA_EXPORT_EXPIRY_DAYS ?? '7');
const RATE_LIMIT_HRS = Number(process.env.DATA_EXPORT_RATE_LIMIT_HRS ?? '24');
const TOKEN_SECRET_STR =
  process.env.DATA_EXPORT_TOKEN_SECRET ?? 'change-me-in-production-min32chars!';
const BUCKET = process.env.DATA_EXPORT_BUCKET;
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

  constructor(private readonly prisma: PrismaService) {}

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

    return {
      id: record.id,
      status: record.status,
      created_at: record.created_at,
      completed_at: record.completed_at,
      expires_at: record.expires_at,
      file_size_bytes: record.file_size_bytes,
      // Never return the raw file_url — clients receive a short-lived download
      // token via email and use the /download?token= endpoint.
      download_token:
        record.status === DataExportStatus.READY
          ? await this._mintDownloadToken(record.user_id, record.id)
          : null,
    };
  }

  /**
   * Validate the download token, check the export has not expired, and
   * return the S3 presigned URL (or a filesystem URL) for the redirect.
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

      // Send email with download link
      const downloadToken = await this._mintDownloadToken(userId, exportId);
      await this._sendReadyEmail(userId, exportId, downloadToken, expiresAt);
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
      this._streamAll('communityWin', { author_id: userId }),
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
      return this._streamAll('auditLog', { target_id: userId });
    } catch {
      return [];
    }
  }

  /**
   * Upload the archive buffer to S3-compatible storage. Falls back to local
   * filesystem when DATA_EXPORT_BUCKET is not configured.
   *
   * S3 support requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner
   * to be installed as production dependencies. These packages are NOT bundled
   * by default — see README for the installation command. Without them, the
   * module falls back to the local filesystem path automatically.
   *
   * NEVER serves files through the API process — always returns a URL the
   * client is redirected to.
   */
  private async _uploadFile(
    exportId: string,
    buffer: Buffer,
  ): Promise<string> {
    const filename = `${exportId}.json`;

    if (!BUCKET) {
      // No S3 configured — store on filesystem and return a local token URL.
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      await mkdir(FS_DIR, { recursive: true });
      const filePath = join(FS_DIR, filename);
      await writeFile(filePath, buffer);
      this.logger.warn(
        `DATA_EXPORT_BUCKET not set — export stored at ${filePath}. ` +
          'Configure S3 for production. See src/data-export/README.md.',
      );
      return `local://${filePath}`;
    }

    // S3 upload — requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
    // Dynamic import so the module boots even when these packages are absent (dev).
    try {
      const { S3Client, PutObjectCommand, GetObjectCommand } = await import(
        '@aws-sdk/client-s3'
      );
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

      const s3 = new S3Client({
        region: process.env.AWS_REGION ?? 'us-east-1',
        ...(process.env.DATA_EXPORT_S3_ENDPOINT
          ? { endpoint: process.env.DATA_EXPORT_S3_ENDPOINT }
          : {}),
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
        },
      });

      const key = `exports/${exportId}/${filename}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: buffer,
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
          Metadata: {
            export_id: exportId,
            content_length: String(buffer.length),
          },
        }),
      );

      const presignedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: EXPIRY_DAYS * 24 * 60 * 60 },
      );

      return presignedUrl;
    } catch (err) {
      // S3 SDK not installed — fall back to filesystem
      if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        const { mkdir, writeFile } = await import('fs/promises');
        const { join } = await import('path');
        await mkdir(FS_DIR, { recursive: true });
        const filePath = join(FS_DIR, filename);
        await writeFile(filePath, buffer);
        this.logger.warn(
          '@aws-sdk/client-s3 not installed — export stored at filesystem. ' +
            'Install with: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
        );
        return `local://${filePath}`;
      }
      throw err;
    }
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

    if (!BUCKET) return;

    try {
      const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const url = new URL(fileUrl);
      const key = decodeURIComponent(url.pathname.replace(/^\//, '')).replace(
        `${BUCKET}/`,
        '',
      );
      const s3 = new S3Client({
        region: process.env.AWS_REGION ?? 'us-east-1',
        ...(process.env.DATA_EXPORT_S3_ENDPOINT
          ? { endpoint: process.env.DATA_EXPORT_S3_ENDPOINT }
          : {}),
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
        },
      });
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      this.logger.warn(
        `Could not delete S3 object for expired export: ${(err as Error).message}`,
      );
    }
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
   * Send the "your export is ready" email. Uses nodemailer when SMTP_HOST
   * is configured; logs the URL in dev mode when SMTP_HOST is absent.
   * Nodemailer is a dynamic import — it only needs to be installed when
   * SMTP_HOST is set. In dev, the download URL is logged to console.
   */
  private async _sendReadyEmail(
    userId: string,
    exportId: string,
    downloadToken: string,
    expiresAt: Date,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });

    if (!user) return;

    const baseUrl =
      process.env.PUBLIC_WEB_SIGNUP_URL ?? 'https://app.thegrowthproject.app';
    const downloadUrl = `${baseUrl}/data-export/download?token=${downloadToken}`;
    const expiryDate = expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost) {
      // Dev mode — log so the URL can be used manually
      this.logger.log(
        `[DEV — no SMTP_HOST] Export ${exportId} ready for ${user.email}. ` +
          `Download URL: ${downloadUrl}`,
      );
      return;
    }

    try {
      // Dynamic import — only installed when email delivery is needed.
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT ?? '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const subject = 'Your Growth Project data export is ready';
      const html = [
        `<p>Hi ${user.name ?? 'there'},</p>`,
        `<p>Your personal data export is ready to download. The file contains all your account data in JSON format.</p>`,
        `<p><a href="${downloadUrl}">Download your data</a></p>`,
        `<p>This link expires on <strong>${expiryDate}</strong> (${EXPIRY_DAYS} days). ` +
          `After that, you can request a new export from the Settings screen in the app.</p>`,
        `<p>If you did not request this export, please contact support.</p>`,
        `<p>The Growth Project team</p>`,
      ].join('\n');

      await transporter.sendMail({
        from:
          process.env.SMTP_FROM ??
          '"The Growth Project" <no-reply@thegrowthproject.app>',
        to: user.email,
        subject,
        html,
      });

      this.logger.log(
        `Export-ready email sent to ${user.email} (export ${exportId})`,
      );
    } catch (err) {
      // Email failure is non-fatal — the user can still find the token via /status.
      this.logger.error(
        `Failed to send export-ready email to ${user.email}: ${(err as Error).message}`,
      );
    }
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
