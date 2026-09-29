import { canonicalJson } from '../../../src/scout/induction/digest';
import {
  CANONICAL_FAMILY_DESCRIPTIONS,
  ENTITY_FIELD_DESCRIPTIONS,
  EXERCISE_NATIVE_FIELDS,
  PAGINATION_STYLE_DESCRIPTIONS,
  PERSON_FIELD_DESCRIPTIONS,
  PROGRAM_NATIVE_FIELDS,
  WORKOUT_NATIVE_FIELDS,
  canonicalContract,
  ACCEPT_INTEGER_NUMBER_ID_FIELD,
  ID_FIELD_CLASS_TEXT,
  NONE_PROOF_TEXT,
} from '../../../src/scout/learn/canonical-contract';
import { STRUCTURAL_PATH_VOCABULARY } from '../../../src/scout/learn/contract-vocabulary';
import {
  PROMPT_TEMPLATE_VERSION,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  asciiJson,
  buildLearnPrompt,
  contractHash,
  describeCanonicalContract,
  outputSchemaHash,
  randomNonce,
  untrustedBlock,
} from '../../../src/scout/learn/prompt';
import { proposalJsonSchema } from '../../../src/scout/learn/proposal';
import { validateSchema } from '../../../src/scout/learn/schema';
import { basicExample, parsedBasic, promptOf, BASIC_SLUG } from './helpers';
import { DEVICE_OBLIGATIONS } from '../../../src/scout/learn/admission';

const NONCE = 'a'.repeat(48);

describe('learn prompt (D-L0-7.1 / 7.2, L11)', () => {
  it('renders part 2 from the canonical contract: every family, field, native field and vocabulary word appears', () => {
    const text = describeCanonicalContract();
    for (const f of CANONICAL_FAMILY_DESCRIPTIONS) {
      expect(text).toContain(`- ${f.family}:`);
      expect(text).toContain(f.description);
      for (const [field, meta] of Object.entries(f.fields)) {
        expect(text).toContain(`- ${field}:`);
        expect(text).toContain(meta.description);
      }
    }
    for (const table of [
      PROGRAM_NATIVE_FIELDS,
      WORKOUT_NATIVE_FIELDS,
      EXERCISE_NATIVE_FIELDS,
      PERSON_FIELD_DESCRIPTIONS,
      ENTITY_FIELD_DESCRIPTIONS,
    ])
      for (const [field, meta] of Object.entries(table)) {
        expect(text).toContain(`- ${field}:`);
        expect(text).toContain(meta.description);
      }
    for (const word of STRUCTURAL_PATH_VOCABULARY) expect(text).toContain(word);
    for (const [style, meta] of Object.entries(PAGINATION_STYLE_DESCRIPTIONS))
      expect(text).toContain(`- ${style}: ${meta}`);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('a contract change moves contractHash and the rendered text together; the hash is stable', () => {
    const base = canonicalContract();
    expect(contractHash(base)).toBe(contractHash(canonicalContract()));
    expect(contractHash()).toMatch(/^[0-9a-f]{64}$/);
    const changed = { ...base, identityRules: [...base.identityRules, 'Extra rule.'] };
    expect(contractHash(changed)).not.toBe(contractHash(base));
    expect(describeCanonicalContract(changed)).not.toBe(describeCanonicalContract(base));
    expect(describeCanonicalContract(changed)).toContain('Extra rule.');
  });

  it('part 3 is the generated schema; outputSchemaHash is stable and the schema validates the example', () => {
    expect(outputSchemaHash()).toBe(outputSchemaHash());
    expect(validateSchema(proposalJsonSchema(), basicExample().proposal)).toEqual([]);
    const prompt = promptOf({ digest: parsedBasic().digest, examples: [], nonce: NONCE });
    expect(prompt.outputSchemaHash).toBe(outputSchemaHash());
    expect(prompt.parts[2]).toContain(canonicalJson(prompt.outputSchema) as string);
    expect(prompt.parts[2]).toContain('"additionalProperties":false');
    expect(prompt.parts[2]).not.toMatch(/"type":"string"[^}]*"description"/);
  });

  it('builds six parts in order; the digest appears only inside the nonce-delimited block', () => {
    const { digest } = parsedBasic();
    const prompt = promptOf({ digest, examples: [], nonce: NONCE });
    expect(prompt.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION);
    expect(prompt.parts).toHaveLength(6);
    expect(prompt.parts[0]).toMatch(/^Goal:/);
    expect(prompt.parts[1]).toBe(describeCanonicalContract());
    expect(prompt.parts[3]).toBe('Examples: none.');
    expect(prompt.parts[4]).toMatch(/^Rules:/);
    expect(prompt.parts[5].startsWith(`${UNTRUSTED_BEGIN} ${NONCE}\n`)).toBe(true);
    expect(prompt.parts[5].endsWith(`\n${UNTRUSTED_END} ${NONCE}`)).toBe(true);
    expect(prompt.text).toBe(prompt.parts.join('\n\n'));
    const block = untrustedBlock(prompt);
    expect(JSON.parse(block)).toEqual(JSON.parse(canonicalJson(digest) as string));
    const before = prompt.text.slice(0, prompt.text.indexOf(UNTRUSTED_BEGIN));
    expect(before).not.toContain('/v2/coaches/:s1/members');
    expect(before).not.toContain(NONCE);
    // exactly one site-structure block; no example block without a coach example
    expect(prompt.text.split(`${UNTRUSTED_BEGIN} `)).toHaveLength(2);
    expect(prompt.hasCoachExample).toBe(false);
    expect(prompt.text).not.toContain('UNTRUSTED_EXAMPLE_PACKAGE_BEGIN ');
  });

  it('escapes every non-ASCII and control character in the untrusted block', () => {
    const raw = basicExample().digest as Record<string, any>;
    const item = raw.templates[1].shape.keys.members.items;
    item.keys.notes_body = { kind: 'string', class: 'text', lengthBucket: '≤256' };
    item.corroborated = ['notes_body'];
    const { parseStructureDigest } = jest.requireActual(
      '../../../src/scout/learn/digest-contract',
    ) as typeof import('../../../src/scout/learn/digest-contract');
    const digest = parseStructureDigest(raw);
    if (!digest.ok) throw new Error(JSON.stringify(digest.errors));
    const prompt = promptOf({ digest: digest.value, examples: [], nonce: NONCE });
    const block = untrustedBlock(prompt);
    expect(block).toMatch(/^[\x20-\x7e]*$/);
    expect(block).toContain('\\u2264');
    expect(asciiJson('"a\u200bb\n"')).toBe('"a\\u200bb\\u000a"');
  });

  it('validates examples through V-L0/V-L1/V-L2… before embedding them and caps them at 2 (r7: repository fixtures only)', () => {
    const { digest, raw } = parsedBasic();
    const example = { name: 'basic', digest: raw.digest, proposal: raw.proposal, slug: BASIC_SLUG };
    const prompt = promptOf({ digest, examples: [example], nonce: NONCE });
    expect(prompt.parts[3]).toMatch(/^Examples \(structure only, validated\):/);
    const bad = { ...example, proposal: { ...(raw.proposal as object), rationale: 'https://x' } };
    expect(() => buildLearnPrompt({ digest, examples: [bad], nonce: NONCE })).toThrow(/V-L1/);
    expect(() =>
      buildLearnPrompt({ digest, examples: [example, example, example], nonce: NONCE }),
    ).toThrow(/at most 2/);
    expect(promptOf({ digest, examples: [example, example], nonce: NONCE }).parts[3]).toContain(
      'Example proposal',
    );
  });

  it('requires a hex nonce; randomNonce satisfies it and differs per call', () => {
    const { digest } = parsedBasic();
    expect(() => buildLearnPrompt({ digest, examples: [], nonce: 'short' })).toThrow(/nonce/);
    const a = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(randomNonce()).not.toBe(a);
    expect(promptOf({ digest, examples: [], nonce: a }).nonce).toBe(a);
  });

  it('A-04 (fail-first on 3a684671): the prompt parses the RAW digest itself; an unparsed leaf never reaches part 6', () => {
    const raw = basicExample().digest as Record<string, any>;
    raw.templates[1].shape.keys.members.items.keys.display_name.value = 'sensitive sample';
    const built = buildLearnPrompt({ digest: raw, examples: [], nonce: NONCE });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.every((e) => e.code === 'V-L0')).toBe(true);
    expect(JSON.stringify(built.errors)).not.toContain('sensitive sample');
    // and a hand-built "digest" object with the slug or a hostname is refused the same way
    const hostile = { ...basicExample().digest, sourcePlatform: 'coach.example.com' };
    expect(buildLearnPrompt({ digest: hostile, examples: [], nonce: NONCE }).ok).toBe(false);
  });

  it('C2/B5/B4: identity, per-parent scope, none-proof and next_url confinement text are generated from the constants', () => {
    const text = describeCanonicalContract();
    expect(text).toContain(ID_FIELD_CLASS_TEXT);
    expect(ID_FIELD_CLASS_TEXT.includes('number class int')).toBe(ACCEPT_INTEGER_NUMBER_ID_FIELD);
    expect(text).toContain('idScope parent');
    expect(text).toContain(NONE_PROOF_TEXT);
    expect(text).toContain('authorized or contacted origin');
    for (const obligation of DEVICE_OBLIGATIONS) expect(text).toContain(obligation);
    expect(text).not.toContain('destination:');
    expect(text).toContain('unclassified');
  });

  it('instruction parts contain no source data and no vendor or host names', () => {
    const { digest } = parsedBasic();
    const prompt = promptOf({ digest, examples: [], nonce: NONCE });
    const instructions = prompt.parts.slice(0, 5).join('\n');
    expect(instructions).not.toMatch(/https?:\/\//);
    expect(instructions).not.toContain('example_alpha');
    // Outside the generated schema (whose regex patterns name the forbidden characters), no
    // `@` and no digit run in the instruction parts.
    const prose = [prompt.parts[0], prompt.parts[1], prompt.parts[3], prompt.parts[4]].join('\n');
    expect(prose).not.toMatch(/@|[0-9]{4}/);
  });
});
