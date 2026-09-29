import { canonicalJson } from '../../../src/scout/induction/digest';
import { CANONICAL_FAMILIES } from '../../../src/scout/reconstruct/mapping-spec';
import {
  CANONICAL_FAMILY_DESCRIPTIONS,
  canonicalContract,
} from '../../../src/scout/learn/canonical-contract';
import {
  MUTATING_VERB_VOCABULARY,
  STRUCTURAL_PATH_VOCABULARY,
  VOCABULARY_VERSION,
  contractVocabulary,
  isMutatingToken,
  mutatingTokenRefusal,
} from '../../../src/scout/learn/contract-vocabulary';
import {
  FAMILY_CATALOGUE_SOURCE,
  FAMILY_LABELS,
  familyCatalogue,
  isFamilyLabel,
} from '../../../src/scout/learn/family-catalogue';
import {
  DIGEST_MAX_NON_GET_DATA_ORIGINS,
  checkUnionDigest,
  identityMatches,
  keyPathGrowth,
  observedIdentities,
  parseStructureDigest,
  structureKeyOf,
  type StructureDigestV1,
} from '../../../src/scout/learn/digest-contract';
import {
  applyLearnedPackage,
  buildLearnedPackage,
  packageStepKeys,
  parseLearnedPackage,
} from '../../../src/scout/learn/package';
import {
  UNMAPPED_REASONS,
  parseLearnedProposal,
  proposalJsonSchema,
  validateLearnedProposal,
} from '../../../src/scout/learn/proposal';
import {
  COACH_EXAMPLE_SLUG_PLACEHOLDER,
  PROMPT_MAX_EXAMPLES,
  PROMPT_TEMPLATE_VERSION,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  UNTRUSTED_EXAMPLE_BEGIN,
  UNTRUSTED_EXAMPLE_END,
  buildLearnPrompt,
  redactPackageSlug,
  untrustedBlock,
  untrustedExampleBlock,
} from '../../../src/scout/learn/prompt';
import { checkIdentityConformance, droppedFamilies } from '../../../src/scout/learn/conformance';
import { BASIC_SLUG, REF, basicExample, clone, codesOf, parsedBasic, promptOf } from './helpers';

/**
 * r3 of PR #591 — the six items D-L0-9 (L0 r7 `e79e6578`) lists as owed by L1 before it is
 * r7-conformant, each proven by behaviour here: (1) `out_of_scope_billing` deleted; (2)
 * `nonGetDataOrigins`; (3) family labels from the catalogue binding (FAM-C1 surface, carries
 * `billing_schedule`); (4) coach-derived few-shot INSIDE the nonce block; (5)
 * `MUTATING_VERB_VOCABULARY` + V-L5 token check; (6) V-L10 union rule and the identity /
 * key-path match of D-L0-3 (round-2 monotone rule, `template_absent` never a refusal, key-path
 * growth). Plus C0 per family (D-L0-4) as a pure function for L2c.
 */

type Raw = Record<string, any>;
const NONCE = 'c'.repeat(40);

/** FAM-0 r9 D-FAM-1 catalogue table (0924fc15), family column, transcribed for the pin test. */
const FAM0_R9_D_FAM_1 = [
  'clients',
  'client_profile',
  'programs',
  'workouts',
  'exercises',
  'workout_assignments',
  'workout_logs',
  'client_history',
  'messages',
  'food_logs',
  'water_logs',
  'nutrition_targets',
  'meal_plans',
  'checkins',
  'body_weights',
  'body_measurements',
  'habits',
  'coaching_sessions',
  'notes',
  'goals',
  'forms',
  'form_responses',
  'media',
  'billing_history',
  'billing_schedule',
  'unclassified',
];

/** Route a raw (digest, proposal) pair through V-L0/V-L1/V-L2… with an optional context. */
function validateRaw(
  proposal: unknown,
  digest: unknown,
  context: Partial<Parameters<typeof validateLearnedProposal>[2]> = {},
) {
  const d = parseStructureDigest(digest);
  if (!d.ok) throw new Error(`digest: ${JSON.stringify(d.errors)}`);
  const p = parseLearnedProposal(proposal);
  if (!p.ok) return p;
  return validateLearnedProposal(p.value, d.value, { slug: BASIC_SLUG, ...context });
}

function parsedDigest(raw: unknown): StructureDigestV1 {
  const d = parseStructureDigest(raw);
  if (!d.ok) throw new Error(`digest: ${JSON.stringify(d.errors)}`);
  return d.value;
}

/** The basic digest as a round-2 union (same observations, `round: 2`). */
function unionOfBasic(): Raw {
  const u = basicExample().digest as Raw;
  u.round = 2;
  return u;
}

describe('owed item 1: out_of_scope_billing is deleted; billing is a family (D-L0-4, D10)', () => {
  it('UNMAPPED_REASONS has no billing reason; V-L1 refuses it; the schema enum agrees', () => {
    expect(UNMAPPED_REASONS).toEqual([
      'out_of_scope_account_settings',
      'out_of_scope_ui_config',
      'unknown',
    ]);
    const p = basicExample().proposal as Raw;
    p.unmapped[0].reason = 'out_of_scope_billing';
    const parsed = parseLearnedProposal(p);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.some((e) => e.path.includes('reason'))).toBe(true);
    const schema = JSON.stringify(proposalJsonSchema());
    expect(schema).not.toContain('out_of_scope_billing');
    expect(schema).toContain('billing_history');
    expect(schema).toContain('billing_schedule');
  });

  it('the repository example maps the invoices collection as a billing_history step (classification only)', () => {
    const { validated } = parsedBasic();
    const invoices = validated.steps.find((s) => s.step.templateRef === REF.invoices);
    expect(invoices?.family).toBe('billing_history');
    expect(invoices?.mappedFamily).toBeNull();
    expect(validated.unmapped.map((u) => u.reason)).toEqual(['out_of_scope_ui_config']);
  });

  it('a billing_schedule step validates as classification only, with no mappingSpec entry', () => {
    const p = basicExample().proposal as Raw;
    const invoices = p.steps.find((s: Raw) => s.templateRef === REF.invoices);
    invoices.family = 'billing_schedule';
    expect(validateRaw(p, basicExample().digest).ok).toBe(true);
    // a classification-only family with a mappingSpec.steps entry is a V-L4 refusal
    p.mappingSpec.steps.invoices = 'billing_schedule';
    expect(validateRaw(p, basicExample().digest).ok).toBe(false);
  });
});

describe('owed item 2: nonGetDataOrigins (D-L0-2)', () => {
  it('is a required non-negative integer count, bounded; frozen on the parsed digest', () => {
    const ok = parsedDigest(basicExample().digest);
    expect(ok.nonGetDataOrigins).toBe(0);
    const three = basicExample().digest as Raw;
    three.nonGetDataOrigins = 3;
    expect(parsedDigest(three).nonGetDataOrigins).toBe(3);
    for (const bad of [undefined, -1, 1.5, '3', null, DIGEST_MAX_NON_GET_DATA_ORIGINS + 1, [3]]) {
      const d = basicExample().digest as Raw;
      if (bad === undefined) delete d.nonGetDataOrigins;
      else d.nonGetDataOrigins = bad;
      const result = parseStructureDigest(d);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.every((e) => e.code === 'V-L0')).toBe(true);
    }
  });

  it('every shared vector digest carries it (X2 mirrors the fixture byte for byte)', () => {
    const { vectors } = JSON.parse(
      JSON.stringify(
        require('../../fixtures/scout/learn/fingerprint-vectors.json') as { vectors: Raw[] },
      ),
    ) as { vectors: Raw[] };
    for (const v of vectors) expect(v.digest.nonGetDataOrigins).toBe(0);
  });
});

describe('owed item 3: family labels come from the catalogue binding (FAM-C1 surface; V-L4)', () => {
  it('the interim table equals FAM-0 r9 D-FAM-1 exactly (sorted, distinct, carries billing_schedule)', () => {
    expect([...FAMILY_LABELS]).toEqual([...FAM0_R9_D_FAM_1].sort());
    expect(FAMILY_LABELS).toContain('billing_schedule');
    expect(new Set(FAMILY_LABELS).size).toBe(FAM0_R9_D_FAM_1.length);
    for (const f of CANONICAL_FAMILIES) expect(isFamilyLabel(f)).toBe(true);
    expect(isFamilyLabel('billing')).toBe(false);
    expect(isFamilyLabel('destination')).toBe(false);
  });

  it('exposes one catalogue surface; vocabulary, contract and prompt schema all read it', () => {
    const cat = familyCatalogue();
    expect(cat.source).toBe(FAMILY_CATALOGUE_SOURCE);
    expect(cat.labels).toBe(FAMILY_LABELS);
    expect(cat.catchAll).toBe('unclassified');
    expect(cat.mappedFamilies).toEqual([...CANONICAL_FAMILIES].sort());
    expect(contractVocabulary().familyLabels).toEqual(FAMILY_LABELS);
    expect(canonicalContract().familyCatalogue).toEqual(cat);
    // every label has exactly one description in the rendered contract (compile-bound)
    expect(CANONICAL_FAMILY_DESCRIPTIONS.map((f) => f.family)).toEqual([...FAMILY_LABELS]);
    const schema = proposalJsonSchema() as Raw;
    expect(schema.properties.steps.items.properties.family.enum).toEqual([...FAMILY_LABELS]);
  });

  it('destination is never proposed: a step carrying one is refused at V-L1', () => {
    const p = basicExample().proposal as Raw;
    p.steps[0].destination = { kind: 'native' };
    expect(codesOf(parseLearnedProposal(p))).toEqual(['V-L1']);
  });
});

describe('owed item 5: MUTATING_VERB_VOCABULARY and the V-L5 token check (D-L0-6.2)', () => {
  it('is closed, sorted, lower-case, vendor-neutral and carries every D-L0-6.2 word', () => {
    expect(VOCABULARY_VERSION).toBe(3);
    expect([...MUTATING_VERB_VOCABULARY].sort()).toEqual([...MUTATING_VERB_VOCABULARY]);
    expect(new Set(MUTATING_VERB_VOCABULARY).size).toBe(MUTATING_VERB_VOCABULARY.length);
    for (const w of MUTATING_VERB_VOCABULARY) expect(w).toMatch(/^[a-z]+$/);
    const recordWords = [
      'logout',
      'signout',
      'delete',
      'remove',
      'destroy',
      'cancel',
      'send',
      'create',
      'update',
      'archive',
      'unarchive',
      'unsubscribe',
      'subscribe',
      'reset',
      'revoke',
      'accept',
      'decline',
      'approve',
      'reject',
      'assign',
      'complete',
      'confirm',
      'submit',
      'dismiss',
      'toggle',
      'set',
      'mark',
      'read',
      'unread',
      'seen',
      'ack',
      'acknowledge',
      'view',
      'viewed',
      'open',
      'opened',
      'track',
      'visit',
      'notify',
      'action',
      'operation',
      'op',
      'command',
      'cmd',
      'event',
    ];
    for (const w of recordWords) expect(isMutatingToken(w)).toBe(true);
    expect(contractVocabulary().mutatingVerbs).toEqual(MUTATING_VERB_VOCABULARY);
    // the words that are also structural path words are exactly these: admitted as literals by
    // V-L0, refused as step templates by V-L5
    const overlap = MUTATING_VERB_VOCABULARY.filter((w) => STRUCTURAL_PATH_VOCABULARY.includes(w));
    expect(overlap).toEqual(['archive', 'event', 'set', 'view']);
  });

  it('mutatingTokenRefusal splits on separators and camel-case, skips :p/:s markers, reads query keys', () => {
    expect(mutatingTokenRefusal(['v2', 'notes'], ['page'])).toBeNull();
    expect(mutatingTokenRefusal(['v2', 'notes', 'archive'], [])).toMatch(/archive/);
    expect(mutatingTokenRefusal(['v2', 'notes-archive'], [])).toMatch(/archive/);
    expect(mutatingTokenRefusal(['v2', 'notesArchive'], [])).toMatch(/archive/);
    expect(mutatingTokenRefusal(['v2', ':s1', ':p1'], [])).toBeNull();
    expect(mutatingTokenRefusal(['v2', 'items'], ['mark_read'])).toMatch(/query key .*mark/);
    expect(mutatingTokenRefusal(['api', 'action'], ['operation'])).toMatch(/action/);
    // plurals and neighbours are not the verb
    expect(mutatingTokenRefusal(['v2', 'events', 'sets', 'views', 'archived'], [])).toBeNull();
  });

  it('V-L5: a step on a template naming a mutating verb is refused; the same template may be unmapped', () => {
    const d = basicExample().digest as Raw;
    // notes → /v2/notes/archive keeps the canonical order (':d' GET '/v2/notes/archive' sorts after '/v2/notes'... same slot)
    d.templates[3].template = '/v2/notes/archive';
    const p = basicExample().proposal as Raw;
    const asStep = validateRaw(p, d);
    expect(asStep.ok).toBe(false);
    if (!asStep.ok) {
      expect(asStep.errors.map((e) => e.code)).toContain('V-L5');
      expect(asStep.errors.some((e) => /mutating/.test(e.detail))).toBe(true);
    }
    const unmapped = clone(p);
    unmapped.steps = unmapped.steps.filter((s: Raw) => s.templateRef !== REF.notes);
    unmapped.unmapped.push({ templateRef: REF.notes, reason: 'unknown' });
    expect(validateRaw(unmapped, d).ok).toBe(true);
  });

  it('the strict package reader refuses a stored step on a mutating template (never drives a request)', () => {
    const { validated } = parsedBasic();
    const pkg = JSON.parse(JSON.stringify(buildLearnedPackage(validated))) as Raw;
    const notes = pkg.steps.find((s: Raw) => s.key.template === '/v2/notes');
    notes.key.template = '/v2/notes/set';
    const result = parseLearnedPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.code === 'V-L5')).toBe(true);
  });

  it('the mirror fixture carries the vocabulary and the device obligation names it', () => {
    const mirror = require('../../fixtures/scout/learn/contract-vocabulary.json') as Raw;
    expect(mirror.mutatingVerbs).toEqual(MUTATING_VERB_VOCABULARY);
    const rules = require('../../fixtures/scout/learn/admission-rules.json') as Raw;
    expect(rules.deviceObligations.some((r: string) => r.includes('mutating verb'))).toBe(true);
  });
});

describe('owed item 6: identity / key-path match and the round-2 rules (D-L0-3, V-L10)', () => {
  it('identity ignores key paths; growth counts the digest keys the step never recorded', () => {
    const base = parsedDigest(basicExample().digest);
    const members = base.templates.find((t) => t.ref === REF.members)!;
    const full = structureKeyOf(base, members);
    const richer = basicExample().digest as Raw;
    richer.templates[1].shape.keys.members.items.keys.tags = { kind: 'boolean' };
    richer.templates[1].shape.keys.members.items.corroborated = ['tags'];
    const grown = structureKeyOf(
      parsedDigest(richer),
      parsedDigest(richer).templates.find((t) => t.ref === REF.members)!,
    );
    expect(identityMatches(full, grown)).toBe(true);
    expect(keyPathGrowth(full, grown)).toBe(1);
    expect(keyPathGrowth(grown, full)).toBe(0);
    const other = { ...full, method: 'HEAD' as const };
    expect(identityMatches(full, other)).toBe(false);
  });

  it('observedIdentities lists every template identity with key paths only (names, never kinds or values)', () => {
    const base = parsedDigest(basicExample().digest);
    const observed = observedIdentities(base);
    expect(observed).toHaveLength(base.templates.length);
    for (const key of observed) {
      expect(Object.keys(key).sort()).toEqual(['keyPaths', 'method', 'origin', 'template']);
      expect(JSON.stringify(key)).not.toMatch(/kind|class|Bucket|distinct/);
    }
  });

  describe('round-2 monotone observation rule (ii): digest_not_union', () => {
    const round1 = observedIdentities(parsedDigest(basicExample().digest));

    it('accepts the true union: same identities, superset key paths, new explore templates', () => {
      const same = checkUnionDigest(round1, parsedDigest(unionOfBasic()));
      expect(same.ok).toBe(true);
      if (same.ok) expect(same.value.keyPathGrowth).toBe(0);
      // key-path growth: the roster re-observed with an extra admitted key
      const grown = unionOfBasic();
      grown.templates[1].shape.keys.members.items.keys.tags = { kind: 'boolean' };
      grown.templates[1].shape.keys.members.items.corroborated = ['tags'];
      const g = checkUnionDigest(round1, parsedDigest(grown));
      expect(g.ok).toBe(true);
      if (g.ok) expect(g.value.keyPathGrowth).toBe(1);
      // a new explore-discovered template is additive
      const more = unionOfBasic();
      const extra = clone(more.templates[3]);
      extra.template = '/v2/programs';
      extra.discoveredBy = 'explore';
      extra.ref = 't4';
      more.templates.splice(4, 0, extra);
      more.templates[5].ref = 't5';
      more.templates[6].ref = 't6';
      expect(checkUnionDigest(round1, parsedDigest(more)).ok).toBe(true);
    });

    it('refuses a digest that lost a round-1 identity or re-observed one with fewer key paths', () => {
      const lost = unionOfBasic();
      lost.templates.splice(3, 1); // notes gone
      lost.templates[3].ref = 't3';
      lost.templates[4].ref = 't4';
      const l = checkUnionDigest(round1, parsedDigest(lost));
      expect(l.ok).toBe(false);
      if (!l.ok) expect(l.errors.every((e) => e.code === 'digest_not_union')).toBe(true);
      const fewer = unionOfBasic();
      delete fewer.templates[1].shape.keys.members.items.keys.active;
      const f = checkUnionDigest(round1, parsedDigest(fewer));
      expect(f.ok).toBe(false);
      if (!f.ok) expect(f.errors[0].detail).toMatch(/fewer key paths/);
      // a round-1 digest is not a union
      const r1 = checkUnionDigest(round1, parsedDigest(basicExample().digest));
      expect(r1.ok).toBe(false);
    });
  });

  describe('round-2 match (iii) and the V-L10 union rule: template_absent is never a refusal', () => {
    it('sparse account: the round-1 package has a notes step the union never shows → re-pin, notes absent, everything else moves', () => {
      const { validated } = parsedBasic();
      const pkg = buildLearnedPackage(validated);
      const round1Keys = packageStepKeys(pkg);
      const union = unionOfBasic();
      union.templates.splice(3, 1); // the habits/notes page issued no request this run
      union.templates[3].ref = 't3';
      union.templates[4].ref = 't4';
      const applied = applyLearnedPackage(pkg, parsedDigest(union), {
        slug: BASIC_SLUG,
        round1StepKeys: round1Keys,
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.value.absentSteps.map((s) => s.key.template)).toEqual(['/v2/notes']);
      expect(applied.value.validated.steps.map((s) => s.step.entityType)).toEqual([
        'members',
        'routines',
        'invoices',
      ]);
      expect(applied.value.keypathGrowth).toBe(0);
    });

    it('key-path growth in round 2: same identity, superset key paths → re-pin with growth counted', () => {
      const { validated } = parsedBasic();
      const pkg = buildLearnedPackage(validated);
      const union = unionOfBasic();
      const item = union.templates[1].shape.keys.members.items;
      item.keys.tags = { kind: 'boolean' };
      item.keys.level = { kind: 'number', class: 'int' };
      item.corroborated = ['tags', 'level'];
      const applied = applyLearnedPackage(pkg, parsedDigest(union), {
        slug: BASIC_SLUG,
        round1StepKeys: packageStepKeys(pkg),
      });
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.value.keypathGrowth).toBe(2);
        expect(applied.value.absentSteps).toEqual([]);
      }
    });

    it('a fresh round-2 proposal may drop a round-1 step whose identity is NOT in the union, never one that is', () => {
      const { validated } = parsedBasic();
      const round1Keys = validated.steps.map((s) => s.structureKey);
      // (a) notes absent from the union: dropping the notes step is fine
      const union = unionOfBasic();
      union.templates.splice(3, 1);
      union.templates[3].ref = 't3';
      union.templates[4].ref = 't4';
      const p = basicExample().proposal as Raw;
      p.explore = [];
      p.steps = p.steps.filter((s: Raw) => s.entityType !== 'notes');
      for (const s of p.steps) if (s.templateRef === REF.routines) s.templateRef = 't4';
      p.unmapped = [{ templateRef: 't3', reason: 'out_of_scope_ui_config' }];
      expect(validateRaw(p, union, { round1StepKeys: round1Keys }).ok).toBe(true);
      // (b) invoices IS in the union: unmapping it instead of keeping the step is a V-L10 refusal
      const drops = clone(p);
      drops.steps = drops.steps.filter((s: Raw) => s.entityType !== 'invoices');
      drops.unmapped.push({ templateRef: REF.invoices, reason: 'unknown' });
      const refused = validateRaw(drops, union, { round1StepKeys: round1Keys });
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(
          refused.errors.some(
            (e) => e.code === 'V-L10' && /identity is in the union/.test(e.detail),
          ),
        ).toBe(true);
      // (c) round 2 without the round-1 keys is still refused (no fail-open)
      expect(codesOf(validateRaw(p, union))).toEqual(['V-L10']);
    });

    it('when two package entries share an identity, the one whose key paths include the digest wins', () => {
      const { validated } = parsedBasic();
      const pkg = JSON.parse(JSON.stringify(buildLearnedPackage(validated))) as Raw;
      // a second, richer unmapped entry with the invoices identity (a `:q` variant recorded later)
      const invoices = pkg.steps.find((s: Raw) => s.key.template === '/v2/billing/invoices');
      pkg.unmapped.push({
        key: { ...invoices.key, keyPaths: [...invoices.key.keyPaths, 'invoices[].paid'] },
        reason: 'unknown',
      });
      const parsed = parseLearnedPackage(pkg);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const applied = applyLearnedPackage(parsed.value, parsedDigest(basicExample().digest), {
        slug: BASIC_SLUG,
      });
      expect(applied.ok).toBe(true);
      if (applied.ok)
        expect(applied.value.validated.steps.some((s) => s.step.entityType === 'invoices')).toBe(
          true,
        );
    });
  });
});

describe('owed item 4: the coach-derived few-shot example lives inside the nonce block (D-L0-7.1 part 6, D-L0-7.2)', () => {
  const COACH_SLUG = 'coach_host_example';

  /** A package this coach learned earlier, under its own slug (never the fixture slug). */
  function coachPackage(mutate: (pkg: Raw) => void = () => undefined): Raw {
    const raw = basicExample();
    (raw.proposal as Raw).mappingSpec.sourcePlatform = COACH_SLUG;
    (raw.proposal as Raw).nativeRules.sourcePlatform = COACH_SLUG;
    const digest = parseStructureDigest(raw.digest);
    const proposal = parseLearnedProposal(raw.proposal);
    if (!digest.ok || !proposal.ok) throw new Error('fixture');
    const validated = validateLearnedProposal(proposal.value, digest.value, { slug: COACH_SLUG });
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    const pkg = JSON.parse(JSON.stringify(buildLearnedPackage(validated.value))) as Raw;
    mutate(pkg);
    return pkg;
  }

  it('part 4 holds repository fixtures only (≤ 2); the coach package is part 6, after the digest, delimited by the same nonce', () => {
    expect(PROMPT_MAX_EXAMPLES).toBe(2);
    expect(PROMPT_TEMPLATE_VERSION).toBe('scout-learn-prompt/2.1.0');
    const { digest } = parsedBasic();
    const prompt = promptOf({
      digest,
      examples: [],
      coachExample: { kind: 'accepted', package: coachPackage() },
      nonce: NONCE,
    });
    expect(prompt.hasCoachExample).toBe(true);
    expect(prompt.parts[3]).toBe('Examples: none.');
    const part6 = prompt.parts[5];
    expect(part6.startsWith(`${UNTRUSTED_BEGIN} ${NONCE}\n`)).toBe(true);
    expect(part6.endsWith(`\n${UNTRUSTED_EXAMPLE_END} ${NONCE}`)).toBe(true);
    expect(part6.indexOf(`${UNTRUSTED_END} ${NONCE}`)).toBeLessThan(
      part6.indexOf(`${UNTRUSTED_EXAMPLE_BEGIN} ${NONCE} kind=accepted`),
    );
    // the digest block is unchanged by the example block
    expect(JSON.parse(untrustedBlock(prompt))).toEqual(JSON.parse(canonicalJson(digest) as string));
    // the example block is the redacted package, ASCII only
    const block = untrustedExampleBlock(prompt);
    expect(block).toMatch(/^[\x20-\x7e]*$/);
    const parsed = parseLearnedPackage(coachPackage());
    if (!parsed.ok) throw new Error('fixture');
    expect(JSON.parse(block)).toEqual(
      JSON.parse(canonicalJson(redactPackageSlug(parsed.value)) as string),
    );
    // nothing coach-derived before part 6; the coach slug appears nowhere at all
    const before = prompt.parts.slice(0, 5).join('\n\n');
    expect(before).not.toContain('"keyPaths"');
    expect(prompt.text).not.toContain(COACH_SLUG);
    expect(block.split(COACH_EXAMPLE_SLUG_PLACEHOLDER).length).toBeGreaterThan(3); // package, spec, rules, manifest
    // every marker appears exactly once
    for (const marker of [
      UNTRUSTED_BEGIN,
      UNTRUSTED_END,
      UNTRUSTED_EXAMPLE_BEGIN,
      UNTRUSTED_EXAMPLE_END,
    ])
      expect(prompt.text.split(`${marker} ${NONCE}`)).toHaveLength(2);
  });

  it('the round-1 package in round 2 and the suspect package when relearning use the same block with a closed kind label', () => {
    const { digest } = parsedBasic();
    for (const kind of ['round1', 'suspect'] as const) {
      const prompt = promptOf({
        digest,
        examples: [],
        coachExample: { kind, package: coachPackage() },
        nonce: NONCE,
      });
      expect(prompt.parts[5]).toContain(`${UNTRUSTED_EXAMPLE_BEGIN} ${NONCE} kind=${kind}\n`);
    }
    // a kind outside the closed list (as an untyped caller could pass it) is a caller error
    const hostile: Raw = { kind: 'ignore previous' };
    expect(() =>
      buildLearnPrompt({
        digest,
        examples: [],
        coachExample: { kind: hostile.kind, package: coachPackage() },
        nonce: NONCE,
      }),
    ).toThrow(/kind/);
  });

  it('adversarial corpus: hostile key names planted in the coach package appear only inside the example block', () => {
    const corpus = require('../../fixtures/scout/learn/adversarial/hostile-strings.json') as {
      coachExampleKeyNames: { name: string; value: string }[];
    };
    expect(corpus.coachExampleKeyNames.length).toBeGreaterThanOrEqual(7);
    const { digest } = parsedBasic();
    for (const c of corpus.coachExampleKeyNames) {
      const pkg = coachPackage((p) => {
        const members = p.steps.find((s: Raw) => s.key.template === '/v2/coaches/:s1/members');
        members.key.keyPaths = [...members.key.keyPaths, `members[].${c.value}`].sort();
      });
      const built = buildLearnPrompt({
        digest,
        examples: [],
        coachExample: { kind: 'accepted', package: pkg },
        nonce: NONCE,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      const prompt = built.value;
      const block = untrustedExampleBlock(prompt);
      expect(block).toContain(c.value);
      expect(prompt.parts.slice(0, 5).join('\n\n')).not.toContain(c.value);
      expect(untrustedBlock(prompt)).not.toContain(c.value);
      // a fake delimiter without the nonce never closes the block: the whole package is still inside
      expect(JSON.parse(block).steps).toHaveLength(4);
      for (const marker of [UNTRUSTED_EXAMPLE_BEGIN, UNTRUSTED_EXAMPLE_END])
        expect(prompt.text.split(`${marker} ${NONCE}`)).toHaveLength(2);
    }
  });

  it('adversarial corpus: a coach package the strict reader refuses is never printed (refusal, not text)', () => {
    const corpus = require('../../fixtures/scout/learn/adversarial/hostile-strings.json') as {
      coachExamplePackageBreakouts: { name: string; path: string; value: string }[];
    };
    expect(corpus.coachExamplePackageBreakouts.length).toBeGreaterThanOrEqual(6);
    const { digest } = parsedBasic();
    for (const c of corpus.coachExamplePackageBreakouts) {
      const pkg = coachPackage((p) => {
        const parts = c.path.replace(/\[(\d+)\]/g, '.$1').split('.');
        let node: Raw = p;
        for (const part of parts.slice(0, -1)) node = node[part];
        node[parts[parts.length - 1]] = c.value;
      });
      const built = buildLearnPrompt({
        digest,
        examples: [],
        coachExample: { kind: 'suspect', package: pkg },
        nonce: NONCE,
      });
      expect(built.ok).toBe(false);
      if (built.ok) throw new Error(`${c.name} was printed`);
      expect(built.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(built.errors)).not.toContain(c.value.split('\n')[0].slice(0, 12));
    }
  });

  it('a coach package whose text collides with the nonce is a caller error, never printed', () => {
    const { digest } = parsedBasic();
    const nonce = 'members'.padEnd(32, '0'); // not hex → rejected as a nonce anyway
    expect(() =>
      buildLearnPrompt({
        digest,
        examples: [],
        coachExample: { kind: 'accepted', package: coachPackage() },
        nonce,
      }),
    ).toThrow(/nonce/);
    // a hex nonce that appears inside the package bytes: the collision is detected
    const pkg = coachPackage((p) => {
      const members = p.steps.find((s: Raw) => s.key.template === '/v2/coaches/:s1/members');
      members.key.keyPaths = [
        ...members.key.keyPaths,
        'members[].abcdefabcdefabcdefabcdefabcdefab',
      ].sort();
    });
    expect(() =>
      buildLearnPrompt({
        digest,
        examples: [],
        coachExample: { kind: 'accepted', package: pkg },
        nonce: 'abcdefabcdefabcdefabcdefabcdefab',
      }),
    ).toThrow(/collides/);
  });
});

describe('C0 identity conformance per family (D-L0-4; pure, for L2c)', () => {
  it('drops only the failing family; the others proceed; counts and trigger are per family', () => {
    const outcomes = checkIdentityConformance(
      [
        { family: 'clients', rawItems: 10, distinctRawIds: 10, duplicateIds: 0, syntheticIds: 0 },
        { family: 'workouts', rawItems: 30, distinctRawIds: 28, duplicateIds: 2, syntheticIds: 0 },
        { family: 'workouts', rawItems: 5, distinctRawIds: 5, duplicateIds: 0, syntheticIds: 0 },
        { family: 'notes', rawItems: 4, distinctRawIds: 4, duplicateIds: 0, syntheticIds: 0 },
      ],
      [
        { family: 'clients', unionDistinctIds: 10, stagedDistinctIdentities: 10 },
        { family: 'workouts', unionDistinctIds: 33, stagedDistinctIdentities: 33 },
        { family: 'notes', unionDistinctIds: 4, stagedDistinctIdentities: 3 }, // one row lost
      ],
    );
    expect(outcomes.map((o) => [o.family, o.outcome])).toEqual([
      ['clients', 'passed'],
      ['notes', 'dropped'],
      ['workouts', 'passed'],
    ]);
    const notes = outcomes.find((o) => o.family === 'notes')!;
    expect(notes.failures).toEqual(['staged_mismatch']);
    expect(notes.identityConflicts).toBe(3);
    expect(notes.trigger).toBe('conformance_identity');
    expect(outcomes.find((o) => o.family === 'workouts')?.stepCount).toBe(2);
    expect(droppedFamilies(outcomes)).toEqual(['notes']);
  });

  it('partition, synthetic ids and staged mismatch are each a failure; a zero-item family with no rows passes', () => {
    const [partition] = checkIdentityConformance(
      [{ family: 'habits', rawItems: 9, distinctRawIds: 7, duplicateIds: 1, syntheticIds: 0 }],
      [{ family: 'habits', unionDistinctIds: 7, stagedDistinctIdentities: 7 }],
    );
    expect(partition.failures).toEqual(['items_not_partitioned']);
    const [synthetic] = checkIdentityConformance(
      [{ family: 'habits', rawItems: 9, distinctRawIds: 8, duplicateIds: 1, syntheticIds: 1 }],
      [{ family: 'habits', unionDistinctIds: 8, stagedDistinctIdentities: 8 }],
    );
    expect(synthetic.failures).toEqual(['synthetic_ids']);
    const [empty] = checkIdentityConformance(
      [{ family: 'habits', rawItems: 0, distinctRawIds: 0, duplicateIds: 0, syntheticIds: 0 }],
      [{ family: 'habits', unionDistinctIds: 0, stagedDistinctIdentities: 0 }],
    );
    expect(empty.outcome).toBe('passed');
  });

  it('is total and fails closed: missing or malformed evidence drops that family without a structural trigger when it had no raw items', () => {
    const outcomes = checkIdentityConformance(
      [
        {
          family: 'goals',
          rawItems: -1 as number,
          distinctRawIds: 0,
          duplicateIds: 0,
          syntheticIds: 0,
        },
      ],
      [{ family: 'forms', unionDistinctIds: 2, stagedDistinctIdentities: 2 }],
    );
    const forms = outcomes.find((o) => o.family === 'forms')!;
    const goals = outcomes.find((o) => o.family === 'goals')!;
    expect(forms.outcome).toBe('passed'); // counts without steps: nothing contradicts
    expect(goals.outcome).toBe('dropped');
    expect(goals.failures).toEqual(['malformed_counts', 'evidence_missing']);
    expect(goals.trigger).toBeNull();
    // staged rows exist but the engine reported nothing: dropped, no trigger (zero raw items)
    const [ghost] = checkIdentityConformance(
      [],
      [{ family: 'media', unionDistinctIds: 0, stagedDistinctIdentities: 5 }],
    );
    expect(ghost.outcome).toBe('dropped');
    expect(ghost.identityConflicts).toBe(5);
    expect(ghost.trigger).toBeNull();
    expect(checkIdentityConformance([], [])).toEqual([]);
  });
});
