import { randomBytes } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { isFenceReason, runConflict } from '../lifecycle/reason-codes';
import { ScoutLifecycleService, type Tx } from '../lifecycle/lifecycle.service';
import { loadNativeRuleSets } from '../reconstruct/native/native-rule-registry';
import { loadSourceMappingSpecs } from '../reconstruct/source-mapper-registry';
import { CHALLENGE_BYTES, type ObservationEvidenceV1 } from './contract';
import { canonicalJson, sha256Hex } from './digest';
import {
  buildInductionRegistry,
  loadInductionManifests,
  type InductionRegistry,
} from './manifest-registry';
import { unitKey, type ParsedEvidence } from './parse';
import {
  declarationPairKeys,
  normalizeDeclaration,
  observationConflict,
  withinDeclaredCardinality,
  type NormalizedDeclaration,
  type ScoutRunDeclarationResult,
  type ScoutRunObservationResult,
} from './observation.dto';

/** Injection token of the optional test/composition seam (same pattern as S9-B's facts options). */
export const OBSERVATION_SERVICE_OPTIONS = Symbol('OBSERVATION_SERVICE_OPTIONS');

export interface ObservationServiceOptions {
  /** The induction registry; default: the on-disk manifests, mapping specs and native rule sets. */
  readonly registry?: InductionRegistry;
  /** Challenge source; default `crypto.randomBytes(32)`. Must return exactly 32 bytes. */
  readonly challenge?: () => Buffer;
  /** Server clock for `declared_at` / `received_at`; default `new Date()`. */
  readonly now?: () => Date;
}

/** The run row as read under `FOR NO KEY UPDATE` (mode = 'server' only). */
interface LockedRun {
  execution_epoch: number;
  terminal_status: string | null;
  fenced_at: Date | null;
  fence_reason: string | null;
  phase: string | null;
  open_before_deadline: boolean;
}

/** Thrown inside the transaction when the run is absent or past its deadline; rolls back. */
class RunNotWritable extends Error {
  constructor(readonly kind: 'absent' | 'expired') {
    super('scout run not writable');
    this.name = 'RunNotWritable';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row JSON of one validated evidence object (a fresh literal: the Prisma JSON input shape). */
function evidenceJson(e: ObservationEvidenceV1): Prisma.InputJsonObject {
  return {
    evidence_version: e.evidence_version,
    source_platform: e.source_platform,
    account_scope_id_digest: e.account_scope_id_digest,
    family: e.family,
    basis_kind: e.basis_kind,
    mapping_spec_digest: e.mapping_spec_digest,
    statement_b64: e.statement_b64,
    key_id: e.key_id,
    signature_b64: e.signature_b64,
  };
}

/**
 * S10-B — the run declaration and the observation evidence (docs/decisions/2026-09-26-s10-induction.md
 * D-S10-2, D-S10-4 "Routes"). Both writes run in ONE interactive transaction that first locks the
 * run row `FOR NO KEY UPDATE` (the `lifecycle.service.ts` lock statement), so a declaration racing
 * the first ingest (whose §3.1 gate UPDATEs the same row) and an observation racing `/complete`
 * serialise on one row: used, or refused with a code — never partial (R32). Open `mode='server'`
 * runs only. coach_id is always the bearer; epoch, clock, challenge and digests are server-bound.
 *
 * It writes only the two S10 tables; it never touches a run column, a terminal field, the settle
 * path or the facts (S10-C), and imports no notification, drip, email, messaging, workout-builder,
 * AI or billing module (D-S10-6 invariant 5).
 */
@Injectable()
export class ObservationService {
  private registryCache: InductionRegistry | undefined;
  private readonly challenge: () => Buffer;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: ScoutLifecycleService,
    @Optional() @Inject(OBSERVATION_SERVICE_OPTIONS) options?: ObservationServiceOptions,
  ) {
    this.registryCache = options?.registry;
    this.challenge = options?.challenge ?? (() => randomBytes(CHALLENGE_BYTES));
    this.now = options?.now ?? (() => new Date());
  }

  /** Loaded once, fail loud (D-S10-1 V1-V6), exactly like the mapper and native registries. */
  get registry(): InductionRegistry {
    this.registryCache ??= buildInductionRegistry({
      manifests: loadInductionManifests(),
      specs: loadSourceMappingSpecs(),
      nativeRuleSets: loadNativeRuleSets(),
    });
    return this.registryCache;
  }

  // ── POST /api/scout/runs/declaration ─────────────────────────────────────────

  /**
   * One atomic transaction under the run lock inserts the whole declared set or nothing. Exact
   * replay (order ignored) → the ORIGINAL challenge, no row; any changed, removed or appended
   * platform/scope → `declaration_conflict` (before or after ingest); a first declaration once a
   * staged row or a claim exists → `declaration_after_ingest`.
   */
  async declare(
    coachId: string,
    intentId: string,
    platforms: unknown,
  ): Promise<ScoutRunDeclarationResult> {
    const declaration = normalizeDeclaration(platforms);
    if (declaration === null) {
      throw new BadRequestException(
        'platforms must be a non-empty list of unique canonical slugs, each with a non-empty unique list of 64-hex scope digests',
      );
    }
    const wanted = declarationPairKeys(declaration);
    return this.underRunLock(coachId, intentId, async (tx) => {
      const existing = await tx.scoutRunDeclaration.findMany({
        where: { coach_id: coachId, intent_id: intentId },
        select: {
          source_platform: true,
          account_scope_id_digest: true,
          challenge: true,
          declared_at: true,
        },
      });
      if (existing.length > 0) {
        const held = existing
          .map((r) => JSON.stringify([r.source_platform, r.account_scope_id_digest]))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const same = held.length === wanted.length && held.every((k, i) => k === wanted[i]);
        if (!same) throw observationConflict('declaration_conflict');
        const first = existing[0];
        return {
          intent_id: intentId,
          challenge_b64: Buffer.from(first.challenge).toString('base64'),
          declared_at: first.declared_at.toISOString(),
        };
      }
      const [staged, claim] = await Promise.all([
        tx.scoutIngestEntity.findFirst({
          where: { coach_id: coachId, intent_id: intentId },
          select: { id: true },
        }),
        tx.scoutImportCompletion.findUnique({
          where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
          select: { id: true },
        }),
      ]);
      if (staged !== null || claim !== null) throw observationConflict('declaration_after_ingest');
      const challenge = this.challenge();
      if (challenge.length !== CHALLENGE_BYTES) throw new Error('challenge source is not 32 bytes');
      const declaredAt = this.now();
      await this.insertDeclaration(tx, coachId, intentId, declaration, challenge, declaredAt);
      return {
        intent_id: intentId,
        challenge_b64: challenge.toString('base64'),
        declared_at: declaredAt.toISOString(),
      };
    });
  }

  /** Row-by-row inside the caller's transaction: any failure rolls every row back. */
  private async insertDeclaration(
    tx: Tx,
    coachId: string,
    intentId: string,
    declaration: NormalizedDeclaration,
    challenge: Buffer,
    declaredAt: Date,
  ): Promise<void> {
    for (const p of declaration.platforms) {
      for (const scope of p.account_scope_id_digests) {
        await tx.scoutRunDeclaration.create({
          data: {
            coach_id: coachId,
            intent_id: intentId,
            source_platform: p.source_platform,
            account_scope_id_digest: scope,
            challenge: new Uint8Array(challenge),
            declared_at: declaredAt,
          },
          select: { source_platform: true },
        });
      }
    }
  }

  // ── POST /api/scout/runs/observation ─────────────────────────────────────────

  /**
   * Only after a declaration and before the claim; binds the epoch read under the lock. Every
   * entry must name a declared (platform, scope), a platform with an induction manifest and a
   * family in its `expectedFamilies`, else `observation_not_declared`. An identical entry (same
   * `evidence_digest` for the unit at this epoch) is a replay: no row. A different one →
   * `observation_conflict`. All-or-nothing: any refusal rolls the whole upload back.
   */
  async observe(
    coachId: string,
    intentId: string,
    observations: readonly ParsedEvidence[],
  ): Promise<ScoutRunObservationResult> {
    const registry = this.registry;
    return this.underRunLock(coachId, intentId, async (tx, run) => {
      const claim = await tx.scoutImportCompletion.findUnique({
        where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
        select: { id: true },
      });
      if (claim !== null || run.phase === 'reconciling') {
        throw observationConflict('observation_after_claim');
      }
      const declared = await tx.scoutRunDeclaration.findMany({
        where: { coach_id: coachId, intent_id: intentId },
        select: { source_platform: true, account_scope_id_digest: true },
      });
      if (declared.length === 0) throw observationConflict('declaration_missing');
      if (!withinDeclaredCardinality(observations.length, declared.length)) {
        throw new BadRequestException(
          'observations exceed 4 families × the declared scopes of this run',
        );
      }
      const declaredPairs = new Set(
        declared.map((d) => JSON.stringify([d.source_platform, d.account_scope_id_digest])),
      );
      const epoch = run.execution_epoch;
      const stored = await tx.scoutRunObservation.findMany({
        where: { coach_id: coachId, intent_id: intentId, execution_epoch: epoch },
        select: {
          source_platform: true,
          account_scope_id_digest: true,
          family: true,
          evidence_digest: true,
        },
      });
      const storedDigest = new Map(
        stored.map((s) => [
          unitKey(s.source_platform, s.account_scope_id_digest, s.family),
          s.evidence_digest,
        ]),
      );
      const receivedAt = this.now();
      let inserted = 0;
      let replayed = 0;
      for (const item of observations) {
        const e = item.evidence;
        const pkg = registry.packages.get(e.source_platform);
        if (
          !declaredPairs.has(JSON.stringify([e.source_platform, e.account_scope_id_digest])) ||
          pkg === undefined ||
          !pkg.manifest.expectedFamilies.includes(e.family)
        ) {
          throw observationConflict('observation_not_declared');
        }
        const canonical = canonicalJson(evidenceJson(e));
        if (canonical === null)
          throw new BadRequestException('observation evidence is not canonical');
        const digest = sha256Hex(canonical);
        const held = storedDigest.get(
          unitKey(e.source_platform, e.account_scope_id_digest, e.family),
        );
        if (held !== undefined) {
          if (held !== digest) throw observationConflict('observation_conflict');
          replayed += 1;
          continue;
        }
        await tx.scoutRunObservation.create({
          data: {
            coach_id: coachId,
            intent_id: intentId,
            execution_epoch: epoch,
            source_platform: e.source_platform,
            account_scope_id_digest: e.account_scope_id_digest,
            family: e.family,
            basis_kind: e.basis_kind,
            evidence: evidenceJson(e),
            evidence_digest: digest,
            received_at: receivedAt,
          },
          select: { id: true },
        });
        inserted += 1;
      }
      return { intent_id: intentId, execution_epoch: epoch, stored: inserted, replayed };
    });
  }

  // ── The run lock and the refusals shared by both routes ─────────────────────

  /**
   * Lock the open server run (`FOR NO KEY UPDATE`, the lifecycle lock statement), refuse a fenced
   * (`run_fenced`) or terminal (`run_terminal`) run inside the transaction, then run `body`.
   * An absent server row or an open run past its deadline rolls back and is classified after
   * the transaction: legacy → `legacy_run`; unknown to this coach → uniform 404; owned intent
   * without a run → `run_not_started`; past deadline → the lifecycle fences `timed_out` and the
   * answer is `run_fenced` (`classifyClosed` / `closedConflict`, unedited).
   */
  private async underRunLock<T>(
    coachId: string,
    intentId: string,
    body: (tx: Tx, run: LockedRun) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedRun[]>`
          SELECT execution_epoch, terminal_status, fenced_at, fence_reason, phase,
                 (deadline_at > (now() AT TIME ZONE 'UTC')) AS open_before_deadline
            FROM "ScoutImport"
           WHERE coach_id = ${coachId} AND intent_id = ${intentId} AND mode = 'server'
           FOR NO KEY UPDATE`;
        const run = rows[0];
        if (run === undefined) throw new RunNotWritable('absent');
        if (run.fenced_at !== null) {
          const reason = run.fence_reason;
          throw runConflict('run_fenced', isFenceReason(reason) ? reason : undefined);
        }
        if (run.terminal_status !== null) throw runConflict('run_terminal');
        if (run.open_before_deadline !== true) throw new RunNotWritable('expired');
        return body(tx, run);
      });
    } catch (err) {
      if (!(err instanceof RunNotWritable)) throw err;
      if (err.kind === 'expired') {
        throw ScoutLifecycleService.closedConflict(
          await this.lifecycle.classifyClosed(coachId, intentId),
        );
      }
      throw await this.absentRun(coachId, intentId);
    }
  }

  /** No open server row under the lock: legacy, foreign/unknown (404) or not started. */
  private async absentRun(coachId: string, intentId: string): Promise<Error> {
    const row = await this.prisma.scoutImport.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: { mode: true },
    });
    if (row !== null && row.mode !== 'server') return runConflict('legacy_run');
    if (row !== null) return runConflict('run_not_started');
    if (!UUID_RE.test(intentId)) return new NotFoundException();
    const intent = await this.prisma.importIntent.findUnique({
      where: { id_coach_id: { id: intentId, coach_id: coachId } },
      select: { id: true },
    });
    return intent === null ? new NotFoundException() : runConflict('run_not_started');
  }
}
