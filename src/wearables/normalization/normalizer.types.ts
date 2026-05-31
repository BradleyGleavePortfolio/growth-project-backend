import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';

/**
 * PR-HK-0 — canonical normalization boundary types.
 *
 * Every connector's `normalize()` converts provider-native payloads into
 * {@link NormalizedSample}[]. This is the single seam where provider
 * idiosyncrasy stops and the canonical schema begins: downstream
 * (IngestionService) is provider-agnostic and depends ONLY on these types
 * (Agent 2 §3.2 — "the ingestion lane is identical for cloud and on-device
 * after the NormalizedSample[] boundary").
 */

/**
 * A raw, provider-native record as returned by `connector.backfill()` or a
 * webhook parse. Intentionally opaque: the connector that produced it is the
 * only code that understands its shape, and it must map it to
 * {@link NormalizedSample} before it crosses the ingestion boundary. The
 * optional `id` is the provider-native record id, threaded through to
 * {@link NormalizedSample.sourceRecordId} for backfill reconciliation.
 */
export interface RawRecord {
  /** Provider-native record id, if the provider assigns one. */
  id?: string;
  /** The provider whose API produced this record. */
  provider: WearableProvider;
  /** The untouched provider payload (one record). */
  payload: unknown;
}

/**
 * The canonical, provider-neutral sample produced by a normalizer and
 * consumed by IngestionService. Maps 1:1 onto a {@link WearableSample} row
 * minus the server-assigned fields (id, dedup_key, recorded_at) which the
 * ingestion lane computes.
 */
export interface NormalizedSample {
  /** Subject client User.id. */
  userId: string;
  /** The connection this sample was ingested through. */
  connectionId: string;
  /** Source provider (also a segment of the dedup key). */
  provider: WearableProvider;
  /** Canonical metric. */
  metric: WearableMetricType;
  /**
   * Primary bucket for the metric, denormalized onto the sample for fast
   * bucket-filtered reads. MUST equal WearableMetricDef.bucket for the
   * metric — the ingestion service is the enforcement point.
   */
  bucket: WearableMetricBucket;
  /** Numeric value in {@link unit}. */
  value: number;
  /** Canonical unit string (matches WearableMetricDef.unit, e.g. "bpm"). */
  unit: string;
  /** Observation window start. */
  startAt: Date;
  /** Observation window end (== startAt for instantaneous samples). */
  endAt: Date;
  /** IANA timezone the provider reported the sample in (e.g. "Europe/London"). */
  sourceTz?: string | null;
  /** Provider-native id for the source record (backfill reconciliation). */
  sourceRecordId?: string | null;
  /** Optional pointer to an archived raw payload. */
  rawRef?: string | null;
}

/**
 * An OAuth token set returned by `exchangeCode()` / `refresh()`. The
 * connection layer (PR-HK-1) KMS-wraps these before persistence; they MUST
 * NEVER be logged or returned to a client (50-Failures #1/#12). On-device
 * providers (HealthKit / Samsung) never produce a TokenSet.
 */
export interface TokenSet {
  /** Long-lived refresh token (KMS-wrapped at rest). */
  refreshToken: string;
  /** Short-lived access token (optional cache; refresh is source of truth). */
  accessToken?: string;
  /** Absolute expiry of the access token, if the provider supplies one. */
  accessTokenExpiresAt?: Date;
  /** Granted provider-native scope strings, for audit + re-consent. */
  scopes?: string[];
  /** Provider-native account id (e.g. Oura/Whoop user id). */
  externalAccountId?: string;
}
