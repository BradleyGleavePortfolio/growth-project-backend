import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  FAMILY_QUALIFIERS,
  type FamilyQualifierCode,
  RELATIONSHIP_CLOSURES,
  type RelationshipClosureCode,
  RUN_MODES,
  RUN_PHASES,
  RUN_REASON_CODES,
  type RunMode,
  type RunPhase,
  type RunReasonCode,
} from './lifecycle/reason-codes';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// IMPORTER-E — DTOs for the extension's cross-device progress + completion
// surface (DESIGN.md v0.3 §10 + §2 step 11). Field names match the
// status_snapshot the extension already broadcasts via chrome.runtime.sendMessage
// verbatim (intent_id / progress[] / lastError) so the backend does not force a
// re-shape on the extension side. ValidationPipe (whitelist +
// forbidNonWhitelisted) rejects any unknown field with a 400.

/** One per-entity progress line inside a status_snapshot. */
export class ScoutProgressEntryDto {
  @ApiProperty({
    description: 'Entity family this line reports on.',
    maxLength: 64,
    example: 'clients',
  })
  @IsString()
  @MaxLength(64)
  entity_type!: string;

  @ApiProperty({
    description: 'Entities committed so far for this family.',
    minimum: 0,
    example: 12,
  })
  @IsInt()
  @Min(0)
  count_committed!: number;

  @ApiProperty({ description: 'Best-effort total the crawler expects.', minimum: 0, example: 40 })
  @IsInt()
  @Min(0)
  total_estimated!: number;
}

/**
 * POST /api/scout/progress body — the status_snapshot the background worker
 * posts on every batch commit. Only the latest snapshot per (coach, intent)
 * is retained, so the array is bounded: a crawl walks a fixed, small set of
 * entity types (identity, clients, workouts, library, goals — see DESIGN §9).
 */
export class ScoutProgressDto {
  @ApiProperty({
    description: 'Crawl session id (snake_case outer envelope).',
    maxLength: 128,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MaxLength(128)
  intent_id!: string;

  /**
   * Client-generated stable identifier for the physical device running the
   * crawl (the same device id the extension already mints under R80). It is
   * part of the progress storage key so a coach mirroring one import from two
   * devices at once — e.g. laptop and phone — keeps two independent snapshot
   * rows instead of clobbering each other.
   *
   * deviceId alone is sufficient: intent_id is already generated per crawl
   * session, so the only overlap it does not disambiguate is the same intent
   * mirrored from two physical devices, which deviceId resolves. Two tabs on a
   * single device either share one crawl (one stream — coalescing is correct)
   * or mint distinct intent_ids, so a separate sessionId would add a key column
   * with no distinct collision to prevent.
   */
  @ApiProperty({
    description: 'Client-minted stable device id (camelCase); part of the progress storage key.',
    minLength: 1,
    maxLength: 64,
    example: 'dev_5f2c',
  })
  @IsString()
  @Length(1, 64)
  deviceId!: string;

  @ApiProperty({
    type: [ScoutProgressEntryDto],
    description: 'Per-entity progress lines.',
    maxItems: 64,
  })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ScoutProgressEntryDto)
  progress!: ScoutProgressEntryDto[];

  @ApiPropertyOptional({ description: 'Latest non-fatal error, if any.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  lastError?: string;
}

/** The three terminal states the extension reports on crawl settle. */
export const SCOUT_TERMINAL_STATUSES = ['success', 'partial', 'failed'] as const;
export type ScoutTerminalStatus = (typeof SCOUT_TERMINAL_STATUSES)[number];

/**
 * POST /api/scout/ingest/complete body — the terminal call fired once the
 * crawl settles. final_counts is an open per-entity tally kept as a bounded
 * JSON object; error_summary is present only for partial / failed runs.
 */
export class ScoutCompleteDto {
  @ApiProperty({
    description: 'Crawl session id (snake_case outer envelope).',
    maxLength: 128,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MaxLength(128)
  intent_id!: string;

  @ApiProperty({
    description: 'Terminal state the crawl settled into.',
    enum: SCOUT_TERMINAL_STATUSES,
    example: 'success',
  })
  @IsIn(SCOUT_TERMINAL_STATUSES)
  terminal_status!: ScoutTerminalStatus;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Optional per-entity final tally.',
  })
  @IsOptional()
  @IsObject()
  final_counts?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Human-readable summary for partial/failed runs.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error_summary?: string;
}

// States the READ surface can prove: `running` is derived from present evidence
// when no terminal row exists yet; a legacy run's three terminals are the settled
// terminal_status reflected verbatim. S7-L widens the vocabulary with the server-run
// terminals (`complete|blocked|cancelled|timed_out`; `partial|failed` are shared) — a
// legacy row still never projects them and a server row never projects `success`.
// `pending` stays deliberately absent (not representable).
// See docs/decisions/2026-07-15-importer-import-status-read.md and
// docs/decisions/2026-09-24-s7l-run-lifecycle.md §5.
export const SCOUT_READ_STATUSES = [
  'running',
  ...SCOUT_TERMINAL_STATUSES,
  'complete',
  'blocked',
  'cancelled',
  'timed_out',
] as const;
export type ScoutReadStatus = (typeof SCOUT_READ_STATUSES)[number];

/** GET /api/scout/import/status query — one run, identified by its intent id. */
export class ScoutImportStatusQueryDto {
  @ApiProperty({
    description: 'Crawl session id of the run to read.',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  intent_id!: string;
}

/** One server-authoritative committed count per entity family. */
export class ScoutImportEntityCountDto {
  @ApiProperty({ description: 'Entity family.', example: 'clients' })
  entity_type!: string;

  @ApiProperty({ description: 'Entities actually committed (proof, not an estimate).', minimum: 0 })
  committed!: number;
}

/** Reconstruction ledger tally of one family (N/Q1 invariant 6: staged = sum of the three). */
export class ScoutImportFamilyLedgerDto {
  @ApiProperty({ minimum: 0 })
  reconstructed!: number;

  @ApiProperty({ minimum: 0 })
  skipped!: number;

  @ApiProperty({ minimum: 0 })
  failed!: number;
}

/** S9 D-S9-7 histogram entry: one closed-catalogue reason code and how many identities carry it. */
export class ScoutImportReasonCountDto {
  @ApiProperty({
    description: 'Reason code from the closed S9 catalogue (never free text).',
    example: 'unresolved:no_native_client_principal',
  })
  code!: string;

  @ApiProperty({ minimum: 0, description: 'Identities of the family carrying this code.' })
  count!: number;
}

/**
 * S7-L §5 `families[]` entry. `staged_unique` is the distinct (source_platform, source_id)
 * count of staged rows for the family — the staged row count, because that wide identity is
 * the staging table's only key. Every native bucket is null until the slice that proves it
 * (S8-B provenance / S9 reconciliation / S10 observation) exists; null means "not yet known".
 *
 * S9-C (D-S9-5): when a reconciliation report applies to the run (a settled server run whose
 * reason code is not `reconciliation_not_performed`), `rejected` / `unresolved` are counted facts
 * and the optional fields below are present; otherwise they are absent and the entry is exactly
 * the S7-L shape. `created_native` / `already_present_verified` stay null in v1 (D-S9-4).
 */
export class ScoutImportFamilyDto {
  @ApiProperty({ description: 'Entity family.', example: 'clients' })
  family!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Observed by the extension (S10); null until known.',
  })
  observed_unique!: number | null;

  @ApiProperty({ minimum: 0, description: 'Distinct staged source identities for the family.' })
  staged_unique!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Native rows created (S9); null until known.',
  })
  created_native!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Verified already present (S9); null until known.',
  })
  already_present_verified!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Rejected by reconciliation (S9); null until known.',
  })
  rejected!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Unresolved by reconciliation (S9); null until known.',
  })
  unresolved!: number | null;

  @ApiProperty({ type: ScoutImportFamilyLedgerDto, description: 'Reconstruction ledger tally.' })
  ledger!: ScoutImportFamilyLedgerDto;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Canonical family the staged token resolves to (S9); null when unmapped or when the token ' +
      'resolves to different families across platforms. Present only when a report applies.',
    example: 'workouts',
  })
  canonical_family?: string | null;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Verified natively present (created or already present) identities (S9 D-S9-4). Present ' +
      'only when a report applies.',
  })
  native_present_verified?: number;

  @ApiPropertyOptional({
    description:
      "Completeness basis for the family (S9 D-S9-3): 'none' until a basis is recorded. Present " +
      'only when a report applies.',
    example: 'none',
  })
  completeness_basis?: string;

  @ApiPropertyOptional({
    enum: RELATIONSHIP_CLOSURES,
    description:
      'Relationship closure over the verified identities (S9 D-S9-5): not_applicable = no ' +
      'verified identity carries a declared edge. Present only when a report applies.',
  })
  relationship_closure?: RelationshipClosureCode;

  @ApiPropertyOptional({
    type: [ScoutImportReasonCountDto],
    description:
      'Closed-catalogue reason histogram over the staged identities (S9 D-S9-7), sorted by code. ' +
      'Present only when a report applies.',
  })
  reasons?: ScoutImportReasonCountDto[];

  @ApiPropertyOptional({
    isArray: true,
    enum: FAMILY_QUALIFIERS,
    description:
      'Family qualifiers (D-S9-5, closed enum, append-only); present only when a report applies.',
  })
  qualifiers?: FamilyQualifierCode[];
}

// 200 body for GET /api/scout/import/status. Evidence-only: `entity_counts` are
// persisted-row counts, never the extension's `total_estimated`. The `status`
// itself conveys the terminal class (partial/failed) — no free-text error text.
export class ScoutImportStatusResult {
  @ApiProperty({ description: 'The intent id that was read.' })
  intent_id!: string;

  @ApiProperty({ description: 'Proven lifecycle state.', enum: SCOUT_READ_STATUSES })
  status!: ScoutReadStatus;

  @ApiProperty({ type: [ScoutImportEntityCountDto], description: 'Committed counts per entity.' })
  entity_counts!: ScoutImportEntityCountDto[];

  // type/format explicit: the reflector cannot infer them from `string | null`
  // and would emit `type: object`, degrading a Date field in client codegen.
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Earliest evidence timestamp (ISO-8601): first committed entity, else ' +
      'lifecycle start, else latest progress snapshot. Null when none timestamped. ' +
      'For a settled run with zero committed entities and no snapshot this ' +
      'degenerates to the settle-time lifecycle start, so it may equal completed_at.',
  })
  started_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Settled at (ISO-8601); null while running.',
  })
  completed_at!: string | null;

  // ── S7-L additive lifecycle fields (decision §5). Legacy rows project
  // mode='legacy', phase=null, null clocks, execution_epoch=1, reason_code=null.

  @ApiProperty({
    description: '`server` for a run started via POST /scout/runs/start; `legacy` otherwise.',
    enum: RUN_MODES,
  })
  mode!: RunMode;

  @ApiProperty({
    description: 'Open-run phase of a server run; null on legacy rows and once terminal.',
    enum: RUN_PHASES,
    nullable: true,
  })
  phase!: RunPhase | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Server-owned start of a server run (written once at Start); null on legacy rows.',
  })
  accepted_start_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'accepted_start_at + SCOUT_RUN_DEADLINE_MS; enforced lazily. Null on legacy rows.',
  })
  deadline_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Last write accepted through the run gate; null on legacy rows.',
  })
  last_observed_at!: string | null;

  @ApiProperty({ description: 'Fence epoch of the run (1 until fenced).', minimum: 1 })
  execution_epoch!: number;

  @ApiProperty({
    description:
      "The extension's stored /complete claim (`success|partial|failed`); null while none. On a " +
      'server run this is INPUT to the arbiter, never the terminal itself.',
    enum: SCOUT_TERMINAL_STATUSES,
    nullable: true,
  })
  claimed_status!: ScoutTerminalStatus | null;

  @ApiProperty({
    description: 'Why the server run reached its terminal; null while open and on legacy rows.',
    enum: RUN_REASON_CODES,
    nullable: true,
  })
  reason_code!: RunReasonCode | null;

  @ApiProperty({
    type: [ScoutImportFamilyDto],
    description:
      'Per-family evidence: staged unique rows and the reconstruction ledger tally. Native ' +
      'buckets are null (= not yet known, never 0) until later slices fill them.',
  })
  families!: ScoutImportFamilyDto[];
}

/** 200 body: the settle call is acknowledged and echoes the intent id. */
export class ScoutCompleteResult {
  @ApiProperty({ description: 'Always true on a successful (idempotent) settle.', example: true })
  acknowledged!: true;

  @ApiProperty({
    description: 'The intent id that was settled.',
    example: 'intent_2026_07_09_abc123',
  })
  intent_id!: string;
}
