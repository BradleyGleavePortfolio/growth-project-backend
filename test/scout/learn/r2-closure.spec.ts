import { canonicalJson } from '../../../src/scout/induction/digest';
import { parseStructureDigest } from '../../../src/scout/learn/digest-contract';
import {
  applyLearnedPackage,
  buildLearnedPackage,
  canonicalPackageJson,
  parseLearnedPackage,
} from '../../../src/scout/learn/package';
import {
  UNMAPPED_REASONS,
  parseLearnedProposal,
  proposalJsonSchema,
  validateLearnedProposal,
} from '../../../src/scout/learn/proposal';
import { FAMILY_LABELS } from '../../../src/scout/learn/contract-vocabulary';
import { NATIVE_RULE_KINDS } from '../../../src/scout/learn/canonical-contract';
import { BASIC_SLUG, basicExample, codesOf, parsedBasic, REF } from './helpers';

type Raw = Record<string, any>;

function validateRaw(rawProposal: unknown, rawDigest: unknown = basicExample().digest) {
  const digest = parseStructureDigest(rawDigest);
  if (!digest.ok) throw new Error(`digest: ${JSON.stringify(digest.errors)}`);
  const proposal = parseLearnedProposal(rawProposal);
  if (!proposal.ok) return proposal;
  return validateLearnedProposal(proposal.value, digest.value, { slug: BASIC_SLUG });
}

function stored(): Raw {
  return JSON.parse(canonicalJson(buildLearnedPackage(parsedBasic().validated)) as string);
}

describe('r2 closure: every test here fails on 3a684671', () => {
  it('A-02: an enum map and a string flag marker (model-invented source values) are refused at V-L1', () => {
    expect(NATIVE_RULE_KINDS).not.toContain('enum');
    const enumRule = basicExample().proposal as Raw;
    enumRule.nativeRules.families.workouts.type = {
      kind: 'enum',
      paths: [['title']],
      map: { 'Alice Smith': 'strength' },
    };
    const r1 = validateRaw(enumRule);
    expect(r1.ok).toBe(false);
    expect(codesOf(r1)).toEqual(['V-L1']);
    const flag = basicExample().proposal as Raw;
    flag.nativeRules.families.workouts.archived = {
      kind: 'flag',
      paths: [['title']],
      truthy: ['Alice Smith'],
    };
    const r2 = validateRaw(flag);
    expect(r2.ok).toBe(false);
    expect(codesOf(r2)).toEqual(['V-L1']);
    flag.nativeRules.families.workouts.archived.truthy = [true, 1];
    expect(validateRaw(flag).ok).toBe(true);
    expect(JSON.stringify(proposalJsonSchema())).not.toContain('"enum"}');
  });

  it('direction 2: destination is not an AI field; family is a closed label with unclassified; unsupported_coaching_data is gone', () => {
    expect(UNMAPPED_REASONS).not.toContain('unsupported_coaching_data');
    expect(FAMILY_LABELS).toContain('unclassified');
    const p = basicExample().proposal as Raw;
    p.steps[2].destination = { kind: 'preserve', family: 'notes' };
    expect(codesOf(validateRaw(p))).toEqual(['V-L1']);
    const q = basicExample().proposal as Raw;
    q.steps[2].family = 'unclassified';
    expect(validateRaw(q).ok).toBe(true);
    const bad = basicExample().proposal as Raw;
    bad.steps[2].family = 'coach_notes_custom';
    expect(codesOf(validateRaw(bad))).toEqual(['V-L1']);
    // a classification-only family may not carry a mapping entry; a mapped family must
    const cross = basicExample().proposal as Raw;
    cross.mappingSpec.steps.notes = 'client_history';
    cross.mappingSpec.families.client_history = {
      clientSourceId: { paths: [['id']], coerce: 'string_or_finite_number' },
      label: { paths: [['body']], coerce: 'string_or_finite_number' },
    };
    expect(codesOf(validateRaw(cross))).toContain('V-L4');
    const mismatch = basicExample().proposal as Raw;
    mismatch.steps[0].family = 'programs';
    expect(codesOf(validateRaw(mismatch))).toContain('V-L4');
  });

  it('direction 3: forEach needs idScope; parentEdge must point at an earlier step through an id-class key; timestampField is iso_date', () => {
    const p = basicExample().proposal as Raw;
    delete p.steps[1].idScope;
    expect(codesOf(validateRaw(p))).toEqual(['V-L5']);
    const edge = basicExample().proposal as Raw;
    edge.steps[1].parentEdge = { field: 'title', toStep: 'members' };
    expect(codesOf(validateRaw(edge))).toEqual(['V-L5']);
    edge.steps[1].parentEdge = { field: 'member_id', toStep: 'notes' };
    expect(codesOf(validateRaw(edge))).toEqual(['V-L5']);
    const ts = basicExample().proposal as Raw;
    ts.steps[0].timestampField = 'display_name';
    expect(codesOf(validateRaw(ts))).toEqual(['V-L5']);
    // the package carries idScope and parentEdge
    const pkg = buildLearnedPackage(parsedBasic().validated);
    expect(pkg.steps[1].step.idScope).toBe('global');
    expect(pkg.steps[1].step.parentEdge).toEqual({ field: 'member_id', toStep: 'members' });
  });

  it('B6/M4: a stray native-rule family fails at V-L7 alone (the landed registry is the check)', () => {
    const p = basicExample().proposal as Raw;
    p.nativeRules.families.programs = { weeks: { kind: 'integer', paths: [['title']] } };
    const result = validateRaw(p);
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['V-L7']);
  });

  describe('A-03/B1: the stored-package reader is not authoritative', () => {
    it('refuses value-bearing step fields, a tampered manifest, verifiers, and steps outside the grammar', () => {
      const email = stored();
      email.steps[1].step.pagination.param = 'jane.doe@example.com';
      expect(parseLearnedPackage(email).ok).toBe(false);
      const path = stored();
      path.steps[0].step.itemsPath = ['Jane Doe', 'members'];
      expect(parseLearnedPackage(path).ok).toBe(false);
      const collect = stored();
      collect.steps[0].step.collectAs = { name: 'x' };
      expect(parseLearnedPackage(collect).ok).toBe(false);
      const manifest = stored();
      manifest.manifest.expectedFamilies = ['clients'];
      manifest.manifest.basisKinds = { clients: [] };
      const m = parseLearnedPackage(manifest);
      expect(m.ok).toBe(false);
      const verifiers = stored();
      verifiers.manifest.verifiers = [{ family: 'clients', kind: 'count' }];
      expect(parseLearnedPackage(verifiers).ok).toBe(false);
      const basis = stored();
      basis.manifest.basisKinds = { clients: ['source_total'], workouts: [] };
      expect(parseLearnedPackage(basis).ok).toBe(false);
      const family = stored();
      family.steps[2].step.family = 'anything';
      expect(parseLearnedPackage(family).ok).toBe(false);
      const ref = stored();
      ref.steps[0].step.templateRef = 't1';
      expect(parseLearnedPackage(ref).ok).toBe(false);
      const order = stored();
      [order.steps[0], order.steps[1]] = [order.steps[1], order.steps[0]];
      expect(parseLearnedPackage(order).ok).toBe(false);
      const origin = stored();
      origin.steps[0].key.origin = 'coach.example.com';
      expect(parseLearnedPackage(origin).ok).toBe(false);
      const foreignOrigin = stored();
      foreignOrigin.steps[0].key.origin = 'app.:d';
      expect(parseLearnedPackage(foreignOrigin).ok).toBe(false);
      const rules = stored();
      rules.nativeRules.families.programs = { weeks: { kind: 'integer', paths: [['title']] } };
      const r = parseLearnedPackage(rules);
      expect(r.ok).toBe(false);
    });

    it('applies a package to the current digest by structure key (match mode) and re-runs V-L4…V-L10', () => {
      const { validated, digest } = parsedBasic();
      const pkg = buildLearnedPackage(validated);
      const applied = applyLearnedPackage(pkg, digest, { slug: BASIC_SLUG });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.value.absentSteps).toEqual([]);
      expect(applied.value.keypathGrowth).toBe(0);
      expect(applied.value.validated.steps.map((s) => s.step.templateRef)).toEqual([
        REF.members,
        REF.routines,
        REF.notes,
        REF.invoices,
      ]);
      // B3: a sparser account (optional key absent) still applies
      const sparse = basicExample().digest as Raw;
      delete sparse.templates[1].shape.keys.members.items.keys.active;
      const sparseDigest = parseStructureDigest(sparse);
      if (!sparseDigest.ok) throw new Error('fixture');
      expect(applyLearnedPackage(pkg, sparseDigest.value, { slug: BASIC_SLUG }).ok).toBe(true);
      // a digest whose item lost the mapped display_name key: match mode binds nothing, still ok
      const noName = basicExample().digest as Raw;
      delete noName.templates[1].shape.keys.members.items.keys.display_name;
      const noNameDigest = parseStructureDigest(noName);
      if (!noNameDigest.ok) throw new Error('fixture');
      expect(applyLearnedPackage(pkg, noNameDigest.value, { slug: BASIC_SLUG }).ok).toBe(true);
      // r7 D-L0-3 (supersedes the r2 assertion here): a digest with MORE structure than the
      // step still matches BY IDENTITY; the extra key binds nothing and is counted as growth
      const richer = basicExample().digest as Raw;
      richer.templates[1].shape.keys.members.items.keys.tags = {
        kind: 'array',
        lengthBucket: '2-9',
        items: { kind: 'string', class: 'text', lengthBucket: '≤32' },
      };
      richer.templates[1].shape.keys.members.items.corroborated = ['tags'];
      const richerDigest = parseStructureDigest(richer);
      if (!richerDigest.ok) throw new Error(JSON.stringify(richerDigest.errors));
      const grown = applyLearnedPackage(pkg, richerDigest.value, { slug: BASIC_SLUG });
      expect(grown.ok).toBe(true);
      if (grown.ok) expect(grown.value.keypathGrowth).toBe(1);
      // the wrong-class case is still refused in match mode
      const wrongClass = basicExample().digest as Raw;
      wrongClass.templates[1].shape.keys.members.items.keys.display_name.class = 'email_like';
      const wrongDigest = parseStructureDigest(wrongClass);
      if (!wrongDigest.ok) throw new Error('fixture');
      expect(applyLearnedPackage(pkg, wrongDigest.value, { slug: BASIC_SLUG }).ok).toBe(false);
      // a package step absent from the digest is an explore target, not a miss
      const fewer = basicExample().digest as Raw;
      fewer.templates.splice(3, 1);
      fewer.templates[3].ref = 't3';
      fewer.templates[4].ref = 't4';
      const fewerDigest = parseStructureDigest(fewer);
      if (!fewerDigest.ok) throw new Error(JSON.stringify(fewerDigest.errors));
      const partial = applyLearnedPackage(pkg, fewerDigest.value, { slug: BASIC_SLUG });
      expect(partial.ok).toBe(true);
      if (partial.ok)
        expect(partial.value.absentSteps.map((s) => s.key.template)).toEqual(['/v2/notes']);
      // round 2 without round-1 keys is refused through the same path (B2)
      const r2 = basicExample().digest as Raw;
      r2.round = 2;
      const r2Digest = parseStructureDigest(r2);
      if (!r2Digest.ok) throw new Error('fixture');
      expect(applyLearnedPackage(pkg, r2Digest.value, { slug: BASIC_SLUG }).ok).toBe(false);
      expect(applyLearnedPackage(pkg, digest, { slug: 'example_beta' }).ok).toBe(false);
    });
  });

  it('A-05: a __proto__ key is refused by V-L0 and can never vanish from a round-trip', () => {
    const d = basicExample().digest as Raw;
    const item = d.templates[1].shape.keys.members.items;
    item.keys = JSON.parse(
      '{"__proto__":{"kind":"boolean"},"id":' + JSON.stringify(item.keys.id) + '}',
    );
    item.corroborated = ['__proto__'];
    const result = parseStructureDigest(d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => /prototype/.test(e.detail))).toBe(true);
    for (const name of ['constructor', 'prototype']) {
      const dd = basicExample().digest as Raw;
      dd.templates[1].shape.keys.members.items.keys[name] = { kind: 'boolean' };
      dd.templates[1].shape.keys.members.items.corroborated = [name];
      expect(parseStructureDigest(dd).ok).toBe(false);
    }
    // an accepted digest round-trips byte-for-byte (no key is silently dropped)
    const ok = parseStructureDigest(basicExample().digest);
    if (!ok.ok) throw new Error('fixture');
    expect(canonicalJson(ok.value)).toBe(canonicalJson(basicExample().digest));
  });

  it('A-01: the digest carries no slug, no hostname and no semantic query key or header name', () => {
    const d = basicExample().digest as Raw;
    d.templates[1].queryKeys.push({ key: 'AliceSmith', distinct: 1 });
    expect(parseStructureDigest(d).ok).toBe(false);
    const h = basicExample().digest as Raw;
    h.constantHeaderNames.push('X-Tenant-AliceSmith');
    expect(parseStructureDigest(h).ok).toBe(false);
    const o = basicExample().digest as Raw;
    o.origins[1].template = 'alice.example.com';
    expect(parseStructureDigest(o).ok).toBe(false);
    const missingOrigin = basicExample().digest as Raw;
    missingOrigin.templates[4].originRef = 'o5';
    expect(parseStructureDigest(missingOrigin).ok).toBe(false);
    const pkgText = canonicalPackageJson(buildLearnedPackage(parsedBasic().validated));
    if (pkgText.ok) expect(pkgText.value).not.toMatch(/example\.com|AliceSmith/);
  });
});
