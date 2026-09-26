import { BadRequestException, ConflictException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsObject,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';
import { isCanonicalPlatform } from '../scout-platform';
import {
  HEX64_PATTERN,
  OBSERVATION_CONFLICT_CODES,
  type ArtifactRejection,
  type ObservationConflictCode,
} from './contract';
import { isHex64, parseEvidence, unitKey, type ParsedEvidence } from './parse';

// S10-B — DTOs, bounds and the route-body envelope of the two S10 run routes
// (docs/decisions/2026-09-26-s10-induction.md D-S10-2, D-S10-4 "Routes"). The per-evidence grammar
// is S10-A's `parseEvidence`; the body-size cap is S10-A's `OBSERVATION_BODY_MAX_BYTES` /
// `checkObservationBodySize` (enforced by the controller). S10-B owns the envelope: `intent_id`,
// one entry per unit and the cardinality bound ≤ 4 families × declared scopes. The 409 codes are
// the closed `OBSERVATION_CONFLICT_CODES` (S10-A contract.ts) beside `RUN_CONFLICT_CODES`,
// unedited. coach_id, execution_epoch, received_at, evidence_digest and the challenge are
// server-bound and never appear in a request body (whitelist + forbidNonWhitelisted rejects them).

/** Canonical slug grammar (`isCanonicalPlatform`), as a validator pattern. */
const CANONICAL_PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/;

/**
 * Declaration bounds (fail-closed S10-B choice; the doc fixes no number): at most 16 platforms and
 * 16 scopes per platform, so one declaration is ≤ 256 units per family and a matching observation
 * body stays within the 32 KiB cap.
 */
export const DECLARATION_MAX_PLATFORMS = 16;
export const DECLARATION_MAX_SCOPES_PER_PLATFORM = 16;
/** Static upper bound of `observations[]` (4 families × every declarable scope). */
export const OBSERVATION_MAX_ENTRIES =
  CANONICAL_FAMILIES.length * DECLARATION_MAX_PLATFORMS * DECLARATION_MAX_SCOPES_PER_PLATFORM;

/** Fixed, identifier-free messages; the code is the machine-readable part. */
const OBSERVATION_CONFLICT_MESSAGES: Record<ObservationConflictCode, string> = {
  declaration_conflict: 'The run already holds a different declaration; it is immutable.',
  declaration_after_ingest:
    'The run has already staged rows or a claim; it can no longer be declared.',
  declaration_missing: 'The run has no declaration; declare its platforms and scopes first.',
  observation_conflict: 'A different observation is already stored for this unit and epoch.',
  observation_after_claim:
    'The run has already been claimed; no further observations are accepted.',
  observation_not_declared:
    'The observation names a platform, scope or family the run did not declare.',
};

/** Body of every S10 observation 409: `{code, message}` (the `runConflict` shape). */
export interface ObservationConflictBody {
  code: ObservationConflictCode;
  message: string;
}

/** The single constructor for S10 observation conflicts (same envelope as `runConflict`). */
export function observationConflict(code: ObservationConflictCode): ConflictException {
  const body: ObservationConflictBody = { code, message: OBSERVATION_CONFLICT_MESSAGES[code] };
  return new ConflictException(body);
}

export const isObservationConflictCode = (value: unknown): value is ObservationConflictCode =>
  typeof value === 'string' && (OBSERVATION_CONFLICT_CODES as readonly string[]).includes(value);

/**
 * Why the S10-B envelope refused a body: an S10-A artifact/size rejection, or one of the two
 * envelope-only reasons S10-B owns (`bad_intent`, `duplicate_unit`).
 */
export type EnvelopeRejection = ArtifactRejection | 'bad_intent' | 'duplicate_unit';

/** A 400 for a body the envelope refuses; the rejection is a diagnostic only. */
export function observationBodyRejected(reason: EnvelopeRejection): BadRequestException {
  return new BadRequestException(`observation body rejected: ${reason}`);
}

// ── POST /api/scout/runs/declaration ────────────────────────────────────────────────────

/** One declared platform and its expected account scopes. */
export class ScoutRunDeclarationPlatformDto {
  @ApiProperty({
    description: 'Canonical source platform slug (never normalised).',
    minLength: 1,
    maxLength: 256,
    pattern: CANONICAL_PLATFORM_PATTERN.source,
  })
  @IsString()
  @Length(1, 256)
  @Matches(CANONICAL_PLATFORM_PATTERN)
  source_platform!: string;

  @ApiProperty({
    description:
      'The source accounts/workspaces authorized for this import, each as sha256 hex of the ' +
      "source's scope id (never the raw id). Non-empty and unique.",
    type: [String],
    minItems: 1,
    maxItems: DECLARATION_MAX_SCOPES_PER_PLATFORM,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DECLARATION_MAX_SCOPES_PER_PLATFORM)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(HEX64_PATTERN, { each: true })
  account_scope_id_digests!: string[];
}

/** POST /api/scout/runs/declaration body. */
export class ScoutRunDeclarationDto {
  @ApiProperty({
    description: 'Intent id of the open server run (the text form of the server setup intent).',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  intent_id!: string;

  @ApiProperty({
    description:
      'The run’s authorized platform set: non-empty, unique canonical slugs, each with its ' +
      'non-empty expected scope set. Immutable once recorded.',
    type: [ScoutRunDeclarationPlatformDto],
    minItems: 1,
    maxItems: DECLARATION_MAX_PLATFORMS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DECLARATION_MAX_PLATFORMS)
  @ValidateNested({ each: true })
  @Type(() => ScoutRunDeclarationPlatformDto)
  platforms!: ScoutRunDeclarationPlatformDto[];
}

/** 200 body of the declaration (identical on an exact replay). */
export class ScoutRunDeclarationResult {
  @ApiProperty({ description: 'The run key: the intent id.' })
  intent_id!: string;

  @ApiProperty({
    description:
      'The run’s ONE server-generated 32-byte challenge (RFC 4648 §4 base64) that every source ' +
      'statement must embed. An exact replay returns the original challenge.',
    minLength: 44,
    maxLength: 44,
  })
  challenge_b64!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Server-owned; set once.' })
  declared_at!: string;
}

/** One declared unit set, normalised: platforms sorted, scopes sorted. */
export interface NormalizedDeclaration {
  readonly platforms: readonly {
    readonly source_platform: string;
    readonly account_scope_id_digests: readonly string[];
  }[];
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Service-side re-validation of a declaration (fail closed even without the global pipe):
 * `platforms` non-empty, unique canonical slugs; each scope array non-empty, unique, 64 hex.
 * Returns the normalised set or `null` (→ 400, no row). An empty list never means "declared".
 */
export function normalizeDeclaration(platforms: unknown): NormalizedDeclaration | null {
  if (!Array.isArray(platforms)) return null;
  const entries: readonly unknown[] = platforms;
  if (entries.length === 0 || entries.length > DECLARATION_MAX_PLATFORMS) return null;
  const seen = new Set<string>();
  const out: { source_platform: string; account_scope_id_digests: string[] }[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') return null;
    const platform: unknown = Reflect.get(entry, 'source_platform');
    const scopes: unknown = Reflect.get(entry, 'account_scope_id_digests');
    if (!isCanonicalPlatform(platform) || seen.has(platform)) return null;
    seen.add(platform);
    if (!Array.isArray(scopes)) return null;
    const scopeList: readonly unknown[] = scopes;
    if (scopeList.length === 0 || scopeList.length > DECLARATION_MAX_SCOPES_PER_PLATFORM)
      return null;
    const unique = new Set<string>();
    for (const scope of scopeList) {
      if (!isHex64(scope) || unique.has(scope)) return null;
      unique.add(scope);
    }
    out.push({ source_platform: platform, account_scope_id_digests: [...unique].sort(byteOrder) });
  }
  out.sort((a, b) => byteOrder(a.source_platform, b.source_platform));
  return { platforms: out };
}

/** The declared `(platform, scope)` pairs as order-free keys (exact-replay comparison). */
export function declarationPairKeys(declaration: NormalizedDeclaration): string[] {
  const keys: string[] = [];
  for (const p of declaration.platforms) {
    for (const scope of p.account_scope_id_digests) {
      keys.push(JSON.stringify([p.source_platform, scope]));
    }
  }
  return keys.sort(byteOrder);
}

// ── POST /api/scout/runs/observation ────────────────────────────────────────────────────

/** OpenAPI shape of one ObservationEvidenceV1 (validated strictly by S10-A `parseEvidence`). */
export class ScoutRunObservationEvidenceSchema {
  @ApiProperty({ enum: [1] })
  evidence_version!: 1;

  @ApiProperty({ pattern: CANONICAL_PLATFORM_PATTERN.source })
  source_platform!: string;

  @ApiProperty({ pattern: HEX64_PATTERN.source })
  account_scope_id_digest!: string;

  @ApiProperty({ enum: [...CANONICAL_FAMILIES] })
  family!: string;

  @ApiProperty({ enum: ['source_signed_enumeration'] })
  basis_kind!: 'source_signed_enumeration';

  @ApiProperty({ pattern: HEX64_PATTERN.source })
  mapping_spec_digest!: string;

  @ApiProperty({ description: 'Canonical base64 of the strict canonical JSON source statement.' })
  statement_b64!: string;

  @ApiProperty({ pattern: '^[a-z0-9._-]{1,64}$' })
  key_id!: string;

  @ApiProperty({ description: 'Canonical base64 of the 64-byte Ed25519 source signature.' })
  signature_b64!: string;
}

/**
 * POST /api/scout/runs/observation body. `observations[]` entries are deliberately NOT nested
 * class-validator DTOs: each is parsed by S10-A `parseEvidence` (strict keys, canonical base64,
 * canonical statement), so the envelope never whitelists, strips or coerces an evidence field.
 */
export class ScoutRunObservationDto {
  @ApiProperty({
    description: 'Intent id of the open, declared server run.',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  intent_id!: string;

  @ApiProperty({
    description:
      'One ObservationEvidenceV1 per (platform, scope, family): at most 4 families × the ' +
      'declared scopes, one entry per unit; the whole body is ≤ 32 KiB.',
    type: [ScoutRunObservationEvidenceSchema],
    minItems: 1,
    maxItems: OBSERVATION_MAX_ENTRIES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OBSERVATION_MAX_ENTRIES)
  @IsObject({ each: true })
  observations!: object[];
}

/** 200 body of an observation upload (identical replay stores nothing new). */
export class ScoutRunObservationResult {
  @ApiProperty({ description: 'The run key: the intent id.' })
  intent_id!: string;

  @ApiProperty({
    description: 'Epoch read under the run row lock and bound to every row.',
    minimum: 1,
  })
  execution_epoch!: number;

  @ApiProperty({ description: 'Evidence rows inserted by this request.', minimum: 0 })
  stored!: number;

  @ApiProperty({
    description: 'Entries identical to an already stored row (no row written).',
    minimum: 0,
  })
  replayed!: number;
}

export type EnvelopeResult =
  | {
      readonly ok: true;
      readonly intent_id: string;
      readonly observations: readonly ParsedEvidence[];
    }
  | { readonly ok: false; readonly reason: EnvelopeRejection };

/**
 * The observation envelope (S10-B-owned): exactly `{intent_id, observations}`, `intent_id` 1-128
 * chars, `observations` a non-empty array ≤ `OBSERVATION_MAX_ENTRIES`, every entry a valid
 * `parseEvidence` object, at most one entry per `(platform, scope, family)` unit. Never throws.
 * The declared-scope cardinality is checked under the run lock (`withinDeclaredCardinality`).
 */
export function parseObservationEnvelope(body: unknown): EnvelopeResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'not_object' };
  }
  const keys = Object.keys(body);
  for (const key of keys) {
    if (key !== 'intent_id' && key !== 'observations') return { ok: false, reason: 'unknown_key' };
  }
  const intent: unknown = Reflect.get(body, 'intent_id');
  const list: unknown = Reflect.get(body, 'observations');
  if (intent === undefined || list === undefined) return { ok: false, reason: 'missing_key' };
  if (typeof intent !== 'string' || intent.length === 0 || intent.length > 128) {
    return { ok: false, reason: 'bad_intent' };
  }
  if (!Array.isArray(list)) return { ok: false, reason: 'bad_count' };
  const items: readonly unknown[] = list;
  if (items.length === 0) return { ok: false, reason: 'bad_count' };
  if (items.length > OBSERVATION_MAX_ENTRIES) return { ok: false, reason: 'too_large' };
  const seen = new Set<string>();
  const observations: ParsedEvidence[] = [];
  for (const item of items) {
    const parsed = parseEvidence(item);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const { source_platform, account_scope_id_digest, family } = parsed.value.evidence;
    const key = unitKey(source_platform, account_scope_id_digest, family);
    if (seen.has(key)) return { ok: false, reason: 'duplicate_unit' };
    seen.add(key);
    observations.push(parsed.value);
  }
  return { ok: true, intent_id: intent, observations };
}

/** D-S10-2 "Privacy and bounds": at most 4 families × the run's declared scopes. */
export function withinDeclaredCardinality(entries: number, declaredScopeCount: number): boolean {
  return (
    Number.isSafeInteger(declaredScopeCount) &&
    declaredScopeCount > 0 &&
    entries <= CANONICAL_FAMILIES.length * declaredScopeCount
  );
}
