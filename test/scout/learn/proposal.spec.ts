import { NATIVE_RULE_FIELDS } from '../../../src/scout/reconstruct/native/native-rules';
import type { SourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { parseStructureDigest, structureKeyString } from '../../../src/scout/learn/digest-contract';
import {
  ACCEPT_INTEGER_NUMBER_ID_FIELD,
  PROPOSAL_MAX_RATIONALE_CHARS,
  deriveInductionManifest,
  parseLearnedProposal,
  proposalJsonSchema,
  validateLearnedProposal,
  type LearnedProposalV1,
} from '../../../src/scout/learn/proposal';
import {
  CONTRACT_NATIVE_FIELDS,
  nativeFieldTablesMatchInterpreter,
} from '../../../src/scout/learn/canonical-contract';
import { validateSchema } from '../../../src/scout/learn/schema';
import { basicExample, clone, codesOf, parsedBasic } from './helpers';

type Raw = Record<string, any>;

function validateRaw(
  rawProposal: unknown,
  rawDigest: unknown = basicExample().digest,
  slug = 'example_alpha',
) {
  const digest = parseStructureDigest(rawDigest);
  if (!digest.ok) throw new Error(`digest: ${JSON.stringify(digest.errors)}`);
  const proposal = parseLearnedProposal(rawProposal);
  if (!proposal.ok) return proposal;
  return validateLearnedProposal(proposal.value, digest.value, { slug });
}

function expectCode(
  result: { ok: boolean; errors?: readonly { code: string; path: string }[] },
  code: string,
  path?: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codesOf(result)).toContain(code);
  if (path) expect(result.errors!.some((e) => e.code === code && e.path.includes(path))).toBe(true);
}

describe('LearnedProposalV1 (D-L0-4): V-L1 parser', () => {
  it('accepts the basic example', () => {
    const { proposal } = parsedBasic();
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(proposal.steps).toHaveLength(3);
  });

  it('refuses non-JSON, non-objects, unknown keys at every level and missing keys', () => {
    expectCode(parseLearnedProposal(undefined), 'V-L1');
    expectCode(parseLearnedProposal('{}'), 'V-L1');
    const p = basicExample().proposal as Raw;
    expectCode(parseLearnedProposal({ ...clone(p), origin: 'https://x' }), 'V-L1', 'origin');
    const step = clone(p);
    step.steps[0].headers = { authorization: 'x' };
    expectCode(parseLearnedProposal(step), 'V-L1', 'headers');
    const spec = clone(p);
    spec.mappingSpec.families.clients.email = {
      paths: [['email']],
      coerce: 'string_or_finite_number',
    };
    expectCode(parseLearnedProposal(spec), 'V-L1', 'email');
    const { rationale: _r, ...missing } = clone(p);
    expectCode(parseLearnedProposal(missing), 'V-L1', 'rationale');
    expectCode(
      parseLearnedProposal({ ...clone(p), proposalVersion: 1 }),
      'V-L1',
      'proposalVersion',
    );
  });

  it('enforces bounds: steps ≤ 16, explore ≤ 8, rationale ≤ 512, path depth ≤ 4, paths per rule ≤ 4', () => {
    const p = basicExample().proposal as Raw;
    const many = clone(p);
    for (let i = 0; i < 17; i += 1) many.steps.push({ ...clone(p.steps[0]), entityType: `e${i}` });
    expectCode(parseLearnedProposal(many), 'V-L1', 'steps');
    const explore = clone(p);
    explore.explore = Array.from({ length: 9 }, (_, i) => `l${i}`);
    expectCode(parseLearnedProposal(explore), 'V-L1', 'explore');
    const rationale = clone(p);
    rationale.rationale = 'x'.repeat(PROPOSAL_MAX_RATIONALE_CHARS + 1);
    expectCode(parseLearnedProposal(rationale), 'V-L1', 'rationale');
    const deep = clone(p);
    deep.mappingSpec.families.clients.displayName.paths = [['a', 'b', 'c', 'd', 'e']];
    expectCode(parseLearnedProposal(deep), 'V-L1', 'paths');
    const wide = clone(p);
    wide.mappingSpec.families.clients.displayName.paths = [['a'], ['b'], ['c'], ['d'], ['e']];
    expectCode(parseLearnedProposal(wide), 'V-L1', 'paths');
  });

  it('refuses strings with URLs/schemes, control characters, @ and digit runs in rationale, and bad tokens', () => {
    const p = basicExample().proposal as Raw;
    for (const text of [
      'see https://host.example/x',
      'javascript:alert(1)',
      'a\nb',
      'coach@example.com',
      'client 48213',
      'fine\u200bmapping',
    ])
      expectCode(parseLearnedProposal({ ...clone(p), rationale: text }), 'V-L1', 'rationale');
    for (const entityType of [
      'Members',
      'member-list',
      'ignore previous',
      'm20240101',
      '1members',
      'm'.repeat(65),
    ]) {
      const c = clone(p);
      c.steps[0].entityType = entityType;
      expectCode(parseLearnedProposal(c), 'V-L1', 'entityType');
    }
    const ref = clone(p);
    ref.steps[0].templateRef = '/v2/coaches/:s1/members';
    expectCode(parseLearnedProposal(ref), 'V-L1', 'templateRef');
    const reason = clone(p);
    reason.unmapped[0].reason = 'because';
    expectCode(parseLearnedProposal(reason), 'V-L1', 'reason');
  });

  it('bounds native rule literals: enum map keys, flag truthy markers, integer defaults', () => {
    const p = basicExample().proposal as Raw;
    const big = clone(p);
    big.nativeRules.families.workouts.exercises.item.sets.default = 10000;
    expectCode(parseLearnedProposal(big), 'V-L1', 'default');
    // r2 A-02: enum rules are not proposable at all (no observed values exist in a digest)
    const enumRule = clone(p);
    enumRule.nativeRules.families.workouts.type = {
      kind: 'enum',
      paths: [['kind']],
      map: { lifting: 'strength' },
    };
    expectCode(parseLearnedProposal(enumRule), 'V-L1', 'workouts.type');
    const flag = clone(p);
    flag.nativeRules.families.workouts.archived = {
      kind: 'flag',
      paths: [['title']],
      truthy: ['yes'],
    };
    expectCode(parseLearnedProposal(flag), 'V-L1', 'truthy');
  });

  it('the generated schema and the parser agree on the basic example', () => {
    expect(validateSchema(proposalJsonSchema(), basicExample().proposal)).toEqual([]);
  });
});

describe('LearnedProposalV1: validators V-L2 … V-L8, V-L10 over the digest', () => {
  it('accepts the basic example and derives the manifest server-side', () => {
    const { validated } = parsedBasic();
    expect(validated.manifest).toEqual({
      manifestVersion: 1,
      sourcePlatform: 'example_alpha',
      expectedFamilies: ['clients', 'workouts'],
      basisKinds: { clients: [], workouts: [] },
      verifiers: [],
      nativeRules: 'declared',
    });
    expect(validated.steps.map((s) => s.family)).toEqual(['clients', 'workouts', 'notes']);
    expect(validated.steps.map((s) => s.mappedFamily)).toEqual(['clients', 'workouts', null]);
    expect(validated.unmapped[0].reason).toBe('out_of_scope_billing');
  });

  it('V-L2: the landed mapping-spec parser is the authority; slug must match', () => {
    const p = basicExample().proposal as Raw;
    const bad = clone(p);
    bad.mappingSpec.steps.ghost = 'programs';
    const result = validateRaw(bad);
    expect(codesOf(result).some((c) => c === 'V-L1' || c === 'V-L2' || c === 'V-L4')).toBe(true);
    const slug = clone(p);
    slug.mappingSpec.sourcePlatform = 'example_beta';
    expectCode(validateRaw(slug), 'V-L2', 'sourcePlatform');
    const noStep = clone(p);
    noStep.mappingSpec.steps = {};
    expect(validateRaw(noStep).ok).toBe(false);
  });

  it('V-L3: native rules re-parsed by the landed parser; slug and family subset', () => {
    const p = basicExample().proposal as Raw;
    const slug = clone(p);
    slug.nativeRules.sourcePlatform = 'example_beta';
    expectCode(validateRaw(slug), 'V-L3');
    // rule family ⊄ spec families is V-L7's (registry) refusal, not repeated in V-L3
    const family = clone(p);
    family.nativeRules.families.programs = { weeks: { kind: 'integer', paths: [['weeks']] } };
    expectCode(validateRaw(family), 'V-L7');
    const none = clone(p);
    none.nativeRules = null;
    const ok = validateRaw(none);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.manifest.nativeRules).toBe('absent');
  });

  it('V-L4: steps ↔ mappingSpec.steps is a bijection', () => {
    const p = basicExample().proposal as Raw;
    const renamed = clone(p);
    renamed.steps[1].entityType = 'workouts_alt';
    expectCode(validateRaw(renamed), 'V-L4');
    const dup = clone(p);
    dup.steps[1].entityType = 'members';
    expectCode(validateRaw(dup), 'V-L4');
  });

  it('V-L5: templateRef is a collection template, itemsPath a collectionPath, idField an id-class key', () => {
    const p = basicExample().proposal as Raw;
    const single = clone(p);
    single.steps[0].templateRef = 't2';
    expectCode(validateRaw(single), 'V-L5', 'templateRef');
    const unknown = clone(p);
    unknown.steps[0].templateRef = 't9';
    expectCode(validateRaw(unknown), 'V-L5', 'templateRef');
    const path = clone(p);
    path.steps[1].itemsPath = ['meta'];
    expectCode(validateRaw(path), 'V-L5', 'itemsPath');
    const id = clone(p);
    id.steps[1].idField = 'display_name';
    expectCode(validateRaw(id), 'V-L5', 'idField');
    const email = clone(p);
    email.steps[1].idField = 'email';
    expectCode(validateRaw(email), 'V-L5', 'idField');
    const ghost = clone(p);
    ghost.steps[1].idField = 'ghost';
    expectCode(validateRaw(ghost), 'V-L5', 'idField');
  });

  it('V-L5 (flagged divergence): an integer number id is accepted iff ACCEPT_INTEGER_NUMBER_ID_FIELD', () => {
    const d = basicExample().digest as Raw;
    d.templates[1].shape.keys.members.items.keys.id = { kind: 'number', class: 'int' };
    const result = validateRaw(basicExample().proposal, d);
    expect(result.ok).toBe(ACCEPT_INTEGER_NUMBER_ID_FIELD);
    d.templates[1].shape.keys.members.items.keys.id = { kind: 'number', class: 'float' };
    expectCode(validateRaw(basicExample().proposal, d), 'V-L5', 'idField');
  });

  it('V-L5: pagination param must be a query key; cursor nextPath resolves to a string; page has no nextPath', () => {
    const p = basicExample().proposal as Raw;
    const param = clone(p);
    param.steps[0].pagination.param = 'status';
    expectCode(validateRaw(param), 'V-L5', 'pagination.param');
    // a pagination WORD is accepted only when the template signals the matching class (B-A2)
    const word = clone(p);
    word.steps[0].pagination.param = 'cursor';
    expect(validateRaw(word).ok).toBe(true);
    const noSignal = basicExample().digest as Raw;
    noSignal.templates[1].paginationSignals = ['next_link_key'];
    expectCode(validateRaw(word, noSignal), 'V-L5', 'pagination.param');
    const next = clone(p);
    next.steps[0].pagination.nextPath = ['meta', 'ghost'];
    expectCode(validateRaw(next), 'V-L5', 'nextPath');
    const noNext = clone(p);
    delete noNext.steps[0].pagination.nextPath;
    expectCode(validateRaw(noNext), 'V-L5', 'nextPath');
    const mixed = clone(p);
    mixed.steps[1].pagination.nextPath = ['meta', 'next'];
    expectCode(validateRaw(mixed), 'V-L5', 'nextPath');
    const start = clone(p);
    start.steps[0].pagination.start = 1;
    expectCode(validateRaw(start), 'V-L5', 'start');
  });

  it('V-L5 (reset directive 4 + r2 direction 4): next_url and none styles; offset is not a style', () => {
    const p = basicExample().proposal as Raw;
    const d = basicExample().digest as Raw;
    p.steps[1].pagination = { style: 'offset', param: 'page', start: 0 };
    expectCode(validateRaw(p, d), 'V-L1', 'style');
    // next_url: nextPath must resolve to a url-class string; no param
    const u = basicExample().digest as Raw;
    u.templates[1].shape.keys.meta.keys.next = {
      kind: 'string',
      class: 'url',
      lengthBucket: '≤256',
    };
    const q = basicExample().proposal as Raw;
    q.steps[0].pagination = { style: 'next_url', nextPath: ['meta', 'next'] };
    expect(validateRaw(q, u).ok).toBe(true);
    q.steps[0].pagination = { style: 'cursor', param: 'after', nextPath: ['meta', 'next'] };
    expectCode(validateRaw(q, u), 'V-L5', 'nextPath');
    q.steps[0].pagination = { style: 'next_url', param: 'after', nextPath: ['meta', 'next'] };
    expectCode(validateRaw(q, u), 'V-L5', 'param');
    q.steps[0].pagination = { style: 'next_url', nextPath: ['meta', 'next'] };
    expectCode(validateRaw(q, basicExample().digest), 'V-L5', 'nextPath');
    // none (B-A2, fail-first on 3a684671): a CLAIM needing positive proof from the signals
    const n = basicExample().proposal as Raw;
    n.steps[1].pagination = { style: 'none' };
    expectCode(validateRaw(n), 'V-L5', 'style'); // routines signal page_param + total_count_key
    const withSignals = (signals: string[]) => {
      const dd = basicExample().digest as Raw;
      dd.templates[4].queryKeys = [];
      dd.templates[4].paginationSignals = signals;
      return dd;
    };
    expect(validateRaw(n, withSignals(['single_response'])).ok).toBe(true);
    expect(
      validateRaw(n, withSignals(['single_response', 'total_count_key', 'total_equals_count'])).ok,
    ).toBe(true);
    // P1a: no signal at all is NOT proof (single_response missing)
    expectCode(validateRaw(n, withSignals([])), 'V-L5', 'style');
    // P1b: a next-link class present anywhere refuses none
    expectCode(validateRaw(n, withSignals(['next_link_key', 'single_response'])), 'V-L5', 'style');
    expectCode(validateRaw(n, withSignals(['link_header', 'single_response'])), 'V-L5', 'style');
    // P1c: a total count without the equals-count proof refuses none; a token-named key too
    expectCode(
      validateRaw(n, withSignals(['single_response', 'total_count_key'])),
      'V-L5',
      'style',
    );
    expectCode(
      validateRaw(n, withSignals(['single_response', 'token_named_key'])),
      'V-L5',
      'style',
    );
    n.steps[1].pagination = { style: 'none', param: 'page' };
    expectCode(validateRaw(n, withSignals(['single_response'])), 'V-L5', 'param');
    // the digest itself refuses inconsistent signals
    expect(parseStructureDigest(withSignals(['total_equals_count'])).ok).toBe(false);
    const variants = basicExample().digest as Raw;
    variants.templates[4].queryKeys = [{ key: 'page', distinct: '3+' }];
    variants.templates[4].paginationSignals = ['page_param', 'single_response'];
    expect(parseStructureDigest(variants).ok).toBe(false);
    // null is no longer a pagination value
    const nul = basicExample().proposal as Raw;
    nul.steps[1].pagination = null;
    expectCode(validateRaw(nul), 'V-L1', 'pagination');
  });

  it('V-L5: forEach names an earlier collectAs and the template has exactly one :p', () => {
    const p = basicExample().proposal as Raw;
    const unknown = clone(p);
    unknown.steps[1].forEach = 'ghost_ids';
    expectCode(validateRaw(unknown), 'V-L5', 'forEach');
    const missing = clone(p);
    delete missing.steps[1].forEach;
    expectCode(validateRaw(missing), 'V-L5', 'templateRef');
    const later = clone(p);
    [later.steps[0], later.steps[1]] = [later.steps[1], later.steps[0]];
    expectCode(validateRaw(later), 'V-L5', 'forEach');
    const onNoParam = clone(p);
    onNoParam.steps[0].forEach = 'member_ids';
    expectCode(validateRaw(onNoParam), 'V-L5', 'forEach');
  });

  it('V-L6: every mapping and native path resolves in the item shape of a feeding step; contact classes refused', () => {
    const p = basicExample().proposal as Raw;
    const ghost = clone(p);
    ghost.mappingSpec.families.clients.displayName.paths = [['ghost']];
    expectCode(validateRaw(ghost), 'V-L6', 'displayName');
    const email = clone(p);
    email.mappingSpec.families.clients.displayName.paths = [['email']];
    expectCode(validateRaw(email), 'V-L6', 'displayName');
    const text = clone(p);
    text.mappingSpec.families.workouts.clientSourceId.paths = [['title']];
    expectCode(validateRaw(text), 'V-L6', 'clientSourceId');
    const otherStep = clone(p);
    otherStep.mappingSpec.families.workouts.label.paths = [['display_name']];
    expectCode(validateRaw(otherStep), 'V-L6', 'label');
    const native = clone(p);
    native.nativeRules.families.workouts.exercises.paths = [['title']];
    expectCode(validateRaw(native), 'V-L6', 'exercises');
    const item = clone(p);
    item.nativeRules.families.workouts.exercises.item.sets.paths = [['ghost']];
    expectCode(validateRaw(item), 'V-L6', 'sets');
    const top = clone(p);
    top.nativeRules.families.workouts.archived = {
      kind: 'flag',
      paths: [['ghost']],
      truthy: [true],
    };
    expectCode(validateRaw(top), 'V-L6', 'archived');
    const okTop = clone(p);
    okTop.nativeRules.families.workouts.durationEstimateMinutes = {
      kind: 'integer',
      paths: [['sets_total']],
    };
    // sets_total does not exist in the fixture either
    expectCode(validateRaw(okTop), 'V-L6', 'durationEstimateMinutes');
  });

  it('V-L7: the derived manifest passes S10 V1-V6 and buildInductionRegistry with the spec and rules', () => {
    const { validated } = parsedBasic();
    expect(deriveInductionManifest(validated.mappingSpec, validated.nativeRules)).toEqual(
      validated.manifest,
    );
    expect(Object.keys(validated.manifest.basisKinds)).toEqual(validated.manifest.expectedFamilies);
  });

  it('V-L8: explore refs must be linkTemplates refs; round 2 forbids explore', () => {
    const p = basicExample().proposal as Raw;
    const bad = clone(p);
    bad.explore = ['l7'];
    expectCode(validateRaw(bad), 'V-L8', 'explore');
    const d = basicExample().digest as Raw;
    d.round = 2;
    const digest = parseStructureDigest(d);
    const proposal = parseLearnedProposal(basicExample().proposal);
    if (!digest.ok || !proposal.ok) throw new Error('fixture');
    expectCode(
      validateLearnedProposal(proposal.value, digest.value, {
        slug: 'example_alpha',
        round1StepKeys: [],
      }),
      'V-L8',
      'explore',
    );
  });

  it('V-L10: collection templates partition into steps ∪ unmapped, each exactly once', () => {
    const p = basicExample().proposal as Raw;
    const missing = clone(p);
    missing.unmapped = [];
    expectCode(validateRaw(missing), 'V-L10');
    const twice = clone(p);
    twice.unmapped.push({ templateRef: 't1', reason: 'unknown' });
    expectCode(validateRaw(twice), 'V-L10');
    const single = clone(p);
    single.unmapped.push({ templateRef: 't2', reason: 'unknown' });
    expectCode(validateRaw(single), 'V-L10');
  });

  it('V-L10 round 2: every round-1 step (by template key) must still be a step', () => {
    const { validated, raw } = parsedBasic();
    const round1Keys = validated.steps.map((s) => structureKeyString(s.structureKey));
    const d = clone(raw.digest) as Raw;
    d.round = 2;
    const p = clone(raw.proposal) as Raw;
    p.explore = [];
    const digest = parseStructureDigest(d);
    const proposal = parseLearnedProposal(p);
    if (!digest.ok || !proposal.ok) throw new Error('fixture');
    expect(
      validateLearnedProposal(proposal.value, digest.value, {
        slug: 'example_alpha',
        round1StepKeys: round1Keys,
      }).ok,
    ).toBe(true);
    // B2 (fail-first on 3a684671): round 2 without the round-1 keys is refused, never fail-open
    expectCode(
      validateLearnedProposal(proposal.value, digest.value, { slug: 'example_alpha' }),
      'V-L10',
      'round1StepKeys',
    );
    const dropped = clone(p);
    dropped.steps.splice(1, 1);
    delete dropped.mappingSpec.steps.routines;
    delete dropped.mappingSpec.families.workouts;
    dropped.nativeRules = null;
    dropped.unmapped.push({ templateRef: 't4', reason: 'unknown' });
    const parsedDropped = parseLearnedProposal(dropped);
    if (!parsedDropped.ok) throw new Error(JSON.stringify(parsedDropped.errors));
    expectCode(
      validateLearnedProposal(parsedDropped.value, digest.value, {
        slug: 'example_alpha',
        round1StepKeys: round1Keys,
      }),
      'V-L10',
      'steps',
    );
  });

  it('a slug mismatch between run and digest is refused before anything else', () => {
    const result = validateRaw(basicExample().proposal, basicExample().digest, 'example_beta');
    expect(result.ok).toBe(false);
  });

  it('never throws on hostile input (total)', () => {
    const digest = parseStructureDigest(basicExample().digest);
    if (!digest.ok) throw new Error('fixture');
    for (const raw of [null, 1, 'x', [], {}, { proposalVersion: 1 }, { steps: 'x' }])
      expect(() => parseLearnedProposal(raw)).not.toThrow();
    const hostile: LearnedProposalV1 = {
      ...parsedBasic().proposal,
      mappingSpec: JSON.parse('{"specVersion":1}') as SourceMappingSpec,
    };
    expect(() =>
      validateLearnedProposal(hostile, digest.value, { slug: 'example_alpha' }),
    ).not.toThrow();
    expect(validateLearnedProposal(hostile, digest.value, { slug: 'example_alpha' }).ok).toBe(
      false,
    );
  });
});

describe('canonical contract tables are bound to the interpreters', () => {
  it('native field tables equal NATIVE_RULE_FIELDS', () => {
    expect(nativeFieldTablesMatchInterpreter()).toBe(true);
    expect(CONTRACT_NATIVE_FIELDS).toEqual([...NATIVE_RULE_FIELDS].sort());
  });
});
