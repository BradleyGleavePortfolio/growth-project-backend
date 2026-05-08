import { Injectable, LoggerService, Scope } from '@nestjs/common';
import { redactObject, redactLogLine } from './log-redaction';

/**
 * AppLoggerService — structured JSON logger.
 *
 * Replaces NestJS's default pretty-printer with a JSON logger whose every
 * line is a single-line JSON object containing:
 *
 *   timestamp  ISO-8601 UTC
 *   level      error | warn | log | debug | verbose
 *   context    NestJS context label (module name, class name, etc.)
 *   request_id X-Request-ID attached by RequestIdMiddleware (if present)
 *   user_id    Supabase UUID of the authenticated user (if present)
 *   message    the log message
 *   ...rest    any extra key-value pairs passed via the meta parameter
 *
 * LOG_FORMAT=pretty (dev default) bypasses JSON serialisation and prints a
 * human-friendly single line instead.  LOG_FORMAT=json (production default)
 * forces JSON mode regardless of NODE_ENV.
 *
 * All values are passed through redactObject before serialisation so
 * passwords, tokens, and bloodwork data never reach the log backend.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLoggerService implements LoggerService {
  /** Context threading — set by RequestIdMiddleware on each request. */
  static requestId: string | undefined;
  static userId: string | undefined;

  private readonly useJson: boolean;
  private readonly minLevel: number;

  private static readonly LEVELS: Record<string, number> = {
    error: 0,
    warn: 1,
    log: 2,
    debug: 3,
    verbose: 4,
  };

  constructor() {
    const fmt = (process.env.LOG_FORMAT ?? 'json').toLowerCase();
    this.useJson = fmt !== 'pretty';

    const level = (process.env.LOG_LEVEL ?? 'log').toLowerCase();
    this.minLevel = AppLoggerService.LEVELS[level] ?? AppLoggerService.LEVELS['log'];
  }

  private shouldLog(level: string): boolean {
    return (AppLoggerService.LEVELS[level] ?? 0) <= this.minLevel;
  }

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace ? { trace } : undefined);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  /**
   * Emit a structured log line.  This is also the public surface for code
   * that wants to add extra key-value pairs (e.g. the logging interceptor
   * adding method/path/status/latency_ms).
   */
  logStructured(
    level: 'log' | 'error' | 'warn' | 'debug' | 'verbose',
    message: string,
    meta?: Record<string, unknown>,
    context?: string,
  ): void {
    this.write(level, message, context, meta);
  }

  private write(
    level: string,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...(AppLoggerService.requestId ? { request_id: AppLoggerService.requestId } : {}),
      ...(AppLoggerService.userId ? { user_id: AppLoggerService.userId } : {}),
      message: typeof message === 'object' ? JSON.stringify(message) : String(message),
      ...(extra ? extra : {}),
    };

    const sanitised = redactObject(entry) as Record<string, unknown>;

    if (this.useJson) {
      const line = JSON.stringify(sanitised);
      // Belt-and-suspenders redaction on the serialised string before output
      process.stdout.write(redactLogLine(line) + '\n');
    } else {
      const { timestamp, level: lvl, context: ctx, message: msg, ...rest } = sanitised;
      const prefix = `[${timestamp}] [${String(lvl).toUpperCase()}] ${ctx ? '[' + ctx + '] ' : ''}`;
      const suffix = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      process.stdout.write(prefix + String(msg) + suffix + '\n');
    }
  }
}
