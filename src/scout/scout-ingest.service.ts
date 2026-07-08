import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma.service';
import {
  SCOUT_INGEST_EVENT,
  type ScoutIngestDto,
  type ScoutIngestResult,
} from './scout-ingest.dto';

/**
 * Payload keys stripped server-side before persistence (case-insensitive,
 * recursively through nested objects and arrays). OWASP: never trust the
 * client — the extractor should never send secrets, but a compromised or buggy
 * extension must not be able to land credentials in our JSONB store. Values are
 * dropped silently; nothing about a stripped value is logged.
 */
const REDACTED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'cookie',
  'session',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'bearer',
  'ssn',
  'credit_card',
  'cardnumber',
  'cvv',
  'private_key',
]);

@Injectable()
export class ScoutIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Persist a crawl batch for `coachId`, idempotently.
   *
   * Idempotency is enforced by the (coach_id, intent_id, source_id) unique
   * index + `skipDuplicates`, which compiles to INSERT ... ON CONFLICT DO
   * NOTHING. A replayed batch (extension retry/recovery) inserts zero rows and
   * is reported as fully deduped. In-batch duplicate source_ids collapse the
   * same way, so `received` counts the envelope while `deduped` counts every
   * entity that did not produce a new row.
   */
  async ingest(coachId: string, dto: ScoutIngestDto): Promise<ScoutIngestResult> {
    const received = dto.entities.length;

    const rows = dto.entities.map((entity) => ({
      coach_id: coachId,
      intent_id: dto.intent_id,
      entity_type: dto.entity_type,
      source_id: entity.sourceId,
      source_platform: entity.sourcePlatform,
      captured_at: parseCapturedAt(entity.capturedAt),
      payload: redactPayload(entity.payload),
    }));

    const { count } = await this.prisma.scoutIngestEntity.createMany({
      data: rows,
      skipDuplicates: true,
    });

    const deduped = received - count;

    this.analytics.capture(coachId, SCOUT_INGEST_EVENT, {
      intent_id: dto.intent_id,
      entity_type: dto.entity_type,
      received,
      deduped,
    });

    return { received, deduped };
  }
}

/**
 * Parse the top-level `capturedAt` ISO timestamp into a Date. The DTO already
 * guarantees it is a non-empty string, but a value that is not a parseable date
 * must not fail the whole batch — provenance persistence degrades to NULL
 * rather than 500ing an otherwise valid crawl.
 */
function parseCapturedAt(value: string): Date | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Keys that could pollute Object.prototype if written dynamically to a
 * plain object. Enumerated separately from REDACTED_PAYLOAD_KEYS because
 * they are structural (prototype pollution) rather than semantic
 * (credentials) — a security-conscious payload could legitimately contain
 * "token" but never "__proto__" as a JSON key we intend to persist.
 */
const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Recursively strip denylisted keys from a client-supplied payload before it is
 * persisted as JSONB. Structure is otherwise preserved verbatim. Nested objects
 * and array elements are walked; matching happens on the lowercased key.
 */
function redactPayload(
  payload: Prisma.InputJsonObject,
): Record<string, Prisma.InputJsonValue | null> {
  // Use a Map + null-prototype output object so no dynamic write can traverse
  // the prototype chain. CodeQL js/remote-property-injection would otherwise
  // flag `clean[key] = ...` where `key` derives from a client payload.
  const clean = new Map<string, Prisma.InputJsonValue | null>();
  for (const [key, value] of Object.entries(payload)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    if (REDACTED_PAYLOAD_KEYS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    clean.set(key, redactValue(value));
  }
  // Object.create(null) yields an object with no prototype — Prisma serialises
  // it identically to a plain object for JSONB, but it cannot inherit or leak
  // Object.prototype pollution from any source.
  const out: Record<string, Prisma.InputJsonValue | null> = Object.create(null);
  for (const [k, v] of clean) out[k] = v;
  return out;
}

function redactValue(value: Prisma.InputJsonValue | null): Prisma.InputJsonValue | null {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (isJsonRecord(value)) {
    return redactPayload(value);
  }
  return value;
}

function isJsonRecord(value: Prisma.InputJsonValue | null): value is Prisma.InputJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
