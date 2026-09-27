/**
 * S10-D D2 — the synthetic unseen source `s10_unseen`, no-database tier
 * (docs/decisions/2026-09-26-s10-induction.md D-S10-5; acceptance R39 composition half, R41 load
 * half). NEW SOURCE → CORE DIFF = 0: this source exists ONLY as the three data files
 *   src/scout/reconstruct/sources/s10_unseen.json            (S8-A mapping spec)
 *   src/scout/reconstruct/native/sources/s10_unseen.json     (S8-C native rule set)
 *   src/scout/induction/sources/s10_unseen.json              (S10-A induction manifest)
 * and every assertion below goes through the REPOSITORY-DEFAULT loaders and registries (no
 * injected spec, rule set or manifest) except where a case names its injection explicitly.
 *
 * The synthetic signer stands in for a SOURCE and is verified exactly as a real source key would
 * be: this proves the mechanism, never any real platform's completeness (Q1, Q2).
 *
 * The real-PG chain (declaration → staging → S8-G pass → native/evidence → observation →
 * evaluator → S9 verdict → settled basis → status) is s10-unseen.pg.spec.ts.
 */
import { createHash, createPrivateKey, sign, type KeyObject } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadSourceMappingSpecs,
  buildSourceMapperRegistry,
  resolveStagedFamily,
  SOURCE_SPECS_DIR,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import {
  buildNativeRuleRegistry,
  loadNativeRuleSets,
} from '../../../src/scout/reconstruct/native/native-rule-registry';
import { buildNativeFamilies } from '../../../src/scout/reconstruct/native/native-families';
import { planRun } from '../../../src/scout/reconstruct/orchestration/family-plan';
import { buildFamilyRegistry } from '../../../src/scout/reconstruct/families';
import {
  buildInductionRegistry,
  loadInductionManifests,
} from '../../../src/scout/induction/manifest-registry';
import { canonicalJson, mappingSpecDigest } from '../../../src/scout/induction/digest';
import { evaluateCoverage, type StoredObservation } from '../../../src/scout/induction/verify';
import {
  ReconciliationFactsService,
  resolveFamily,
  stagedPlatformFacts,
} from '../../../src/scout/reconciliation/facts.service';
import type { CoverageFact } from '../../../src/scout/reconciliation/types';
import type { Prisma } from '@prisma/client';

// ── Fixtures (test/fixtures/scout/s10_unseen) ───────────────────────────────────────────────
const FIXTURES = join(__dirname, '../../fixtures/scout/s10_unseen');
const readFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const ROWS = readFixture('staged-rows.json');
const STATEMENTS = readFixture('statements.json');
const KEYS = readFixture('signer-test-key.json');

const PLATFORM: string = ROWS.source_platform;
type Row = { token: string; source_id: string; payload: Record<string, unknown> };
const SET = ROWS.sets as Record<
  'base' | 'client_linked' | 'undeclared_family' | 'canonical_token',
  Row[]
>;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SCOPE = sha256(ROWS.account_scope_seed);
const privateKey = (pair: { private_key_pkcs8_b64: string }): KeyObject =>
  createPrivateKey({
    key: Buffer.from(pair.private_key_pkcs8_b64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

/** Independent reference identity digest (sorted `<utf8len>:<id>` concatenation), not digest.ts. */
function referenceIdDigest(ids: readonly string[]): string {
  const sorted = [...new Set(ids)]
    .map((id) => Buffer.from(id, 'utf8'))
    .sort((a, b) => Buffer.compare(a, b));
  return createHash('sha256')
    .update(Buffer.concat(sorted.map((b) => Buffer.concat([Buffer.from(`${b.length}:`), b]))))
    .digest('hex');
}
/** Independent canonical statement bytes: keys sorted by code point, compact JSON. */
function statementBytes(fields: Record<string, unknown>): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key];
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/** The on-disk mapping spec, read through the repository loader (never injected). */
const loadedSpec = () => {
  const spec = loadSourceMappingSpecs().find((s) => s.sourcePlatform === PLATFORM);
  if (spec === undefined) throw new Error('s10_unseen spec is not on disk');
  return spec;
};

/** Evidence for one family: ids = the staged ids the S9 partition groups into that family. */
function evidence(
  family: string,
  ids: readonly string[],
  opts: { challenge: Buffer; issuedAt: string; signer?: 'source' | 'observer' },
): Record<string, unknown> {
  const pair = KEYS[opts.signer ?? STATEMENTS.signers.verified];
  const statement = {
    account_scope_id_digest: SCOPE,
    challenge_b64: opts.challenge.toString('base64'),
    date_window: STATEMENTS.template.date_window,
    family,
    id_set_digest: referenceIdDigest(ids),
    issued_at: opts.issuedAt,
    observed_unique: new Set(ids).size,
    snapshot_ref_digest: sha256(STATEMENTS.template.snapshot_ref_seed),
    source_platform: PLATFORM,
    statement_version: STATEMENTS.template.statement_version,
    terminal: STATEMENTS.template.terminal,
  };
  const bytes = statementBytes(statement);
  return {
    evidence_version: STATEMENTS.evidence_version,
    source_platform: PLATFORM,
    account_scope_id_digest: SCOPE,
    family,
    basis_kind: STATEMENTS.basis_kind,
    mapping_spec_digest: mappingSpecDigest(loadedSpec()),
    statement_b64: bytes.toString('base64'),
    key_id: pair.key_id,
    signature_b64: sign(null, bytes, privateKey(pair)).toString('base64'),
  };
}

/** Staged ids per family through the SAME classifier S9-B/S10-C group with (`resolveFamily`). */
function idsByFamily(rows: readonly Row[]): Record<string, string[]> {
  const mappers = buildSourceMapperRegistry();
  const out: Record<string, string[]> = { clients: [], programs: [], workouts: [] };
  for (const row of rows) {
    const family = resolveFamily(mappers, PLATFORM, row.token);
    if (family !== null) (out[family] ??= []).push(row.source_id);
  }
  return out;
}

const CHALLENGE = Buffer.alloc(32, 0x5a);
const START = new Date('2026-09-26T10:00:00.000Z');
const ISSUED = '2026-09-26T10:00:01.000Z';
const RECEIVED = new Date('2026-09-26T10:00:02.000Z');
const RUN = {
  coach_id: 'coach-s10u',
  intent_id: 'intent-s10u',
  execution_epoch: 1,
  accepted_start_at: START,
};

/** evaluateCoverage over the DEFAULT registries (the S10-C settle-time composition, no DB). */
function coverage(
  rows: readonly Row[],
  families: readonly string[] = STATEMENTS.families,
  signer: 'source' | 'observer' = 'source',
) {
  const mappers = buildSourceMapperRegistry();
  const registry = ReconciliationFactsService.defaultRegistry(mappers, buildNativeRuleRegistry());
  const ids = idsByFamily(rows);
  const observations: StoredObservation[] = families.map((family) => ({
    coach_id: RUN.coach_id,
    intent_id: RUN.intent_id,
    execution_epoch: RUN.execution_epoch,
    received_at: RECEIVED,
    evidence: evidence(family, ids[family] ?? [], {
      challenge: CHALLENGE,
      issuedAt: ISSUED,
      signer,
    }),
  }));
  return evaluateCoverage({
    run: RUN,
    declaration: {
      challenge: CHALLENGE,
      platforms: [{ source_platform: PLATFORM, account_scope_id_digests: [SCOPE] }],
    },
    registry,
    observations,
    staged: stagedPlatformFacts(
      mappers,
      rows.map((r) => ({
        source_platform: PLATFORM,
        entity_type: r.token,
        source_id: r.source_id,
      })),
    ),
  });
}

describe('D-S10-5 zero core diff: the source exists only as data', () => {
  it('no TypeScript under src/ names the slug (gate check 5, re-proved in-suite)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && readFileSync(path, 'utf8').includes(PLATFORM))
          hits.push(path);
      }
    };
    walk(join(__dirname, '../../../src'));
    expect(hits).toEqual([]);
  });

  it('the three JSON artifacts are all present and loaded by the repository loaders', () => {
    expect(readdirSync(SOURCE_SPECS_DIR)).toContain(`${PLATFORM}.json`);
    expect(loadNativeRuleSets().map((s) => s.sourcePlatform)).toContain(PLATFORM);
    expect(loadInductionManifests().map((m) => m.sourcePlatform)).toContain(PLATFORM);
    expect(buildSourceMapperRegistry().has(PLATFORM)).toBe(true);
    expect(buildNativeRuleRegistry().has(PLATFORM)).toBe(true);
  });
});

describe('the synthetic spec shape the doc requires', () => {
  const spec = loadedSpec();

  it('declares clients, programs and workouts; leaves client_history undeclared', () => {
    expect(Object.keys(spec.families).sort()).toEqual(['clients', 'programs', 'workouts']);
    expect(spec.families.client_history).toBeUndefined();
  });

  it('two steps into workouts under sharedIdSpaces; programs has NO steps entry', () => {
    const into = (family: string) =>
      Object.entries(spec.steps)
        .filter(([, f]) => f === family)
        .map(([s]) => s)
        .sort();
    expect(into('workouts')).toHaveLength(2);
    expect(spec.sharedIdSpaces?.workouts).toEqual(into('workouts'));
    expect(into('programs')).toEqual([]);
  });

  it('the staged tokens resolve as the doc states (S8 seam vs the S9/S10 partition)', () => {
    const mappers = buildSourceMapperRegistry();
    for (const row of SET.base) {
      expect(resolveStagedFamily(mappers, PLATFORM, row.token).ok).toBe(true);
    }
    // Canonical-family token without a steps entry: unmapped at the S8 seam (the server pass
    // ledgers it `skipped unresolved_family:programs`) but counted in the programs partition (R27).
    expect(resolveStagedFamily(mappers, PLATFORM, 'programs')).toEqual({
      ok: false,
      reason: 'unresolved_family:programs',
    });
    expect(resolveFamily(mappers, PLATFORM, 'programs')).toBe('programs');
    // Undeclared family: unmapped in both.
    expect(resolveStagedFamily(mappers, PLATFORM, 'client_history').ok).toBe(false);
    expect(resolveFamily(mappers, PLATFORM, 'client_history')).toBeNull();
  });

  it('S8-G planner: members/routines/sessions planned; programs, client_history unmapped', () => {
    const groups = [...SET.base, ...SET.undeclared_family, ...SET.canonical_token].map((r) => ({
      source_platform: PLATFORM,
      entity_type: r.token,
      _count: { _all: 1 },
    }));
    const plan = planRun(groups, buildSourceMapperRegistry(), buildFamilyRegistry());
    expect(plan.ordered.map((p) => p.family)).toEqual(['clients', 'workouts']);
    expect(plan.unmapped.map((u) => u.token).sort()).toEqual(['client_history', 'programs']);
  });

  it('on-disk native rules: coach template native, client-linked evidence', () => {
    const native = buildNativeFamilies({
      sourceMappers: buildSourceMapperRegistry(),
      nativeRules: buildNativeRuleRegistry(),
    });
    const template = SET.base.find((r) => r.token !== 'u10-members')!;
    const linked = SET.client_linked[0];
    const row = (r: Row) => ({
      source_id: r.source_id,
      source_platform: PLATFORM,
      entity_type: r.token,
      payload: r.payload as Prisma.JsonValue,
    });
    const isTagged = (mapped: unknown): mapped is { mode: 'native' | 'evidence' } =>
      typeof mapped === 'object' && mapped !== null && 'mode' in mapped;
    const a = native.workouts.map(row(template));
    const b = native.workouts.map(row(linked));
    expect(a.ok && isTagged(a.mapped) && a.mapped.mode).toBe('native');
    expect(b.ok && isTagged(b.mapped) && b.mapped.mode).toBe('evidence');
    // The canonical-token programs row maps natively when dispatched directly (token === family);
    // only the server pass's planner leaves it unmapped (see the planner case above).
    const p = native.programs.map(row(SET.canonical_token[0]));
    expect(p.ok).toBe(true);
  });

  it('the default induction package binds the loaded spec digest and source key only', () => {
    const mappers = buildSourceMapperRegistry();
    const registry = ReconciliationFactsService.defaultRegistry(mappers, buildNativeRuleRegistry());
    const pkg = registry.packages.get(PLATFORM);
    expect(pkg).toBeDefined();
    expect(pkg!.specDigest).toBe(mappingSpecDigest(loadedSpec()));
    expect(pkg!.manifest.nativeRules).toBe('declared');
    expect(pkg!.manifest.verifiers.map((v) => v.key_id)).toEqual([KEYS.source.key_id]);
    expect(pkg!.manifest.verifiers.map((v) => v.key_id)).not.toContain(KEYS.observer.key_id);
    expect(canonicalJson(pkg!.manifest.basisKinds)).not.toBeNull();
  });
});

describe('R39 composition half — the S10-C evaluator over the default registries', () => {
  const known = (fact: CoverageFact | undefined): fact is Extract<CoverageFact, { known: true }> =>
    fact?.known === true && fact.covers_staged_identities === true;

  it('(a) all declared units signed by the source key → every family known and covering', () => {
    const facts = coverage(SET.base);
    expect(known(facts.clients)).toBe(true);
    expect(known(facts.programs)).toBe(true);
    expect(known(facts.workouts)).toBe(true);
    expect(known(facts.clients) && facts.clients.observed_unique).toBe(2);
    expect(known(facts.programs) && facts.programs.observed_unique).toBe(0); // proven empty set, never "absent"
    expect(known(facts.workouts) && facts.workouts.observed_unique).toBe(2); // two steps, one id space
  });

  it('(c)/(d) the client-linked and the undeclared rows do not unprove coverage', () => {
    const c = coverage([...SET.base, ...SET.client_linked]);
    expect(known(c.workouts)).toBe(true);
    expect(known(c.workouts) && c.workouts.observed_unique).toBe(3);
    const d = coverage([...SET.base, ...SET.undeclared_family]);
    expect(known(d.clients) && known(d.programs) && known(d.workouts)).toBe(true);
  });

  it('R27: the canonical-token programs row is counted in the programs digest', () => {
    const facts = coverage([...SET.base, ...SET.canonical_token]);
    expect(known(facts.programs)).toBe(true);
    expect(known(facts.programs) && facts.programs.observed_unique).toBe(1);
    // A statement that omits it no longer covers the staged programs set.
    const omitted = coverage([...SET.base, ...SET.canonical_token], ['clients', 'workouts']);
    expect(omitted.programs).toEqual({ known: false });
  });

  it('(e) one declared family unproven → that family unknown, the others still known', () => {
    const facts = coverage(SET.base, ['clients', 'workouts']);
    expect(facts.programs).toEqual({ known: false });
    expect(known(facts.clients) && known(facts.workouts)).toBe(true);
  });

  it('(f) extension-signed statements only → every family unknown', () => {
    const facts = coverage(SET.base, STATEMENTS.families, 'observer');
    expect(facts.clients).toEqual({ known: false });
    expect(facts.programs).toEqual({ known: false });
    expect(facts.workouts).toEqual({ known: false });
  });

  it("(b) nativeRules 'absent' is a consistent package only WITHOUT the rule set (V6)", () => {
    const specs = loadSourceMappingSpecs();
    const absent = loadInductionManifests().map((m) =>
      m.sourcePlatform === PLATFORM ? { ...m, nativeRules: 'absent' as const } : m,
    );
    const others = loadNativeRuleSets().filter((s) => s.sourcePlatform !== PLATFORM);
    expect(() =>
      buildInductionRegistry({ manifests: absent, specs, nativeRuleSets: others }),
    ).not.toThrow();
    expect(() =>
      buildInductionRegistry({ manifests: absent, specs, nativeRuleSets: loadNativeRuleSets() }),
    ).toThrow(/nativeRules 'absent'/);
  });
});

describe('R41 load half — two steps into one family without sharedIdSpaces fail at load', () => {
  const raw = JSON.parse(readFileSync(join(SOURCE_SPECS_DIR, `${PLATFORM}.json`), 'utf8'));

  it('the on-disk spec parses; the same spec minus sharedIdSpaces is refused', () => {
    expect(() => parseSourceMappingSpec(raw, 'd2')).not.toThrow();
    const { sharedIdSpaces: _dropped, ...undeclared } = raw;
    expect(() => parseSourceMappingSpec(undeclared, 'd2')).toThrow(/shared id space/);
  });

  it('a spec directory holding that undeclared fan-in fails the repository loader loudly', () => {
    const dir = mkdtempSync(join(tmpdir(), 's10d2-specs-'));
    const { sharedIdSpaces: _dropped, ...undeclared } = raw;
    writeFileSync(join(dir, `${PLATFORM}.json`), JSON.stringify(undeclared));
    expect(() => loadSourceMappingSpecs(dir)).toThrow(/shared id space/);
  });
});
