import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma.service';
import {
  SCOUT_INGEST_EVENT,
  type ScoutIngestDto,
  type ScoutIngestResult,
} from './scout-ingest.dto';
import { RunGateClosed, ScoutLifecycleService } from './lifecycle/lifecycle.service';

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
  private readonly lifecycle: ScoutLifecycleService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    @Optional() lifecycle?: ScoutLifecycleService,
  ) {
    this.lifecycle = lifecycle ?? new ScoutLifecycleService(prisma, analytics);
  }

  /**
   * Persist a crawl batch for `coachId`, idempotently.
   *
   * Idempotency is enforced by the (coach_id, intent_id, entity_type,
   * source_platform, source_id) unique index (G2-C: the wide identity is the
   * only key) + `skipDuplicates`, which compiles to INSERT ... ON CONFLICT DO
   * NOTHING with no conflict target, so whatever unique indexes the database
   * carries arbitrate. A replayed batch (extension retry/recovery) inserts zero
   * rows and is reported as fully deduped. In-batch duplicate identities
   * collapse the same way, so `received` counts the envelope while `deduped`
   * counts every entity that did not produce a new row. The same source_id in
   * another family or on another platform is a distinct identity and inserts.
   *
   * R-IDEMP-1 (2026-07-08): capturedAt is a value, not a key. The idempotency
   * key is (coach_id, intent_id, entity_type, source_platform, source_id) —
   * "the coach saw entity X of family F on platform P during crawl session Y."
   * A coach's crawl re-observes the same source entity over time; each
   * re-observation within an intent must be a no-op replay, not a new row.
   * Putting capturedAt in the key would break this: an extension retry
   * carrying a fresh timestamp would insert a duplicate, defeating replay
   * safety. Different intent_id = a new observation series, correctly inserts.
   *
   * S7-L (decision §3.1): when `intent_id` is the text of an owned server setup
   * intent the batch is written inside ONE transaction whose first statement is
   * the run gate (`assertRunOpen`, an UPDATE that is itself the row lock); a
   * closed gate rolls the batch back and answers 409 `run_not_started` /
   * `run_fenced` (+ `fence_reason`). A legacy intent string keeps the single
   * createMany below unchanged.
   */
  async ingest(coachId: string, dto: ScoutIngestDto): Promise<ScoutIngestResult> {
    const received = dto.entities.length;

    const rows = dto.entities.map((entity) => ({
      coach_id: coachId,
      intent_id: dto.intent_id,
      entity_type: dto.entity_type,
      source_id: entity.sourceId,
      source_platform: entity.sourcePlatform,
      // capturedAt is a strict-ISO8601-validated DTO field (see ScoutEntityDto),
      // so it always parses — no null-degrade path.
      captured_at: new Date(entity.capturedAt),
      payload: redactPayload(entity.payload),
    }));

    const resolution = await this.lifecycle.resolve(coachId, dto.intent_id);
    let count: number;
    if (resolution.mode === 'server') {
      try {
        count = await this.prisma.$transaction(async (tx) => {
          const epoch = await this.lifecycle.assertRunOpen(tx, coachId, dto.intent_id);
          if (epoch === null) throw new RunGateClosed();
          const written = await tx.scoutIngestEntity.createMany({
            data: rows,
            skipDuplicates: true,
          });
          return written.count;
        });
      } catch (err) {
        if (!(err instanceof RunGateClosed)) throw err;
        throw ScoutLifecycleService.closedConflict(
          await this.lifecycle.classifyClosed(coachId, dto.intent_id),
        );
      }
    } else {
      ({ count } = await this.prisma.scoutIngestEntity.createMany({
        data: rows,
        skipDuplicates: true,
      }));
    }

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
