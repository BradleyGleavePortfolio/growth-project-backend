import { parseStructureDigest } from '../../../src/scout/learn/digest-contract';
import { parseLearnedProposal, validateLearnedProposal } from '../../../src/scout/learn/proposal';
import { buildLearnPrompt, untrustedBlock } from '../../../src/scout/learn/prompt';
import { basicExample, clone, loadJson } from './helpers';

/**
 * L13 — adversarial corpus. Every hostile string is injected into every position a site or a
 * model could reach, and the VALIDATORS refuse it (V-L0 for the digest, V-L1… for the proposal).
 * The prompt wording is not consulted: these tests never call the provider and never read part 5.
 */

interface Case {
  name: string;
  value: string;
  admittedWhenCorroborated?: boolean;
}
interface Corpus {
  keys: Case[];
  pathSegments: Case[];
  templates: Case[];
  queryKeys: Case[];
  headerNames: Case[];
  rationales: Case[];
  entityTypes: Case[];
}
type Raw = Record<string, any>;

const corpus = loadJson<Corpus>('adversarial/hostile-strings.json');

function digestRefused(raw: unknown): boolean {
  const result = parseStructureDigest(raw);
  return !result.ok && result.errors.every((e) => e.code === 'V-L0');
}

function proposalRefused(raw: unknown, rawDigest: unknown = basicExample().digest): boolean {
  const digest = parseStructureDigest(rawDigest);
  if (!digest.ok) throw new Error('fixture digest');
  const parsed = parseLearnedProposal(raw);
  if (!parsed.ok) return true;
  return !validateLearnedProposal(parsed.value, digest.value, { slug: 'example_alpha' }).ok;
}

describe('adversarial corpus: the validators, not the prompt, refuse hostile content', () => {
  describe('digest object keys (with corroboration attested by a hostile device)', () => {
    const refusedKeys = corpus.keys.filter((c) => !c.admittedWhenCorroborated);
    const dataKeys = corpus.keys.filter((c) => c.admittedWhenCorroborated);
    it.each(refusedKeys.map((c) => [c.name, c.value]))(
      '%s is refused even when corroborated',
      (_n, key) => {
        const d = basicExample().digest as Raw;
        const item = d.templates[1].shape.keys.members.items;
        item.keys[key] = { kind: 'string', class: 'text', lengthBucket: '≤32' };
        item.corroborated = [key];
        expect(digestRefused(d)).toBe(true);
        const root = basicExample().digest as Raw;
        root.templates[2].shape.keys[key] = { kind: 'boolean' };
        root.templates[2].shape.corroborated = [key];
        expect(digestRefused(root)).toBe(true);
      },
    );
    it.each(dataKeys.map((c) => [c.name, c.value]))(
      '%s is refused uncorroborated and is data only when corroborated',
      (_n, key) => {
        const d = basicExample().digest as Raw;
        const item = d.templates[1].shape.keys.members.items;
        item.keys[key] = { kind: 'string', class: 'text', lengthBucket: '≤32' };
        expect(digestRefused(JSON.parse(JSON.stringify(d)))).toBe(true);
        item.corroborated = [key];
        const digest = parseStructureDigest(d);
        expect(digest.ok).toBe(true);
        if (!digest.ok) return;
        const prompt = buildLearnPrompt({
          digest: digest.value,
          examples: [],
          nonce: 'd'.repeat(40),
        });
        const block = untrustedBlock(prompt);
        expect(block).toContain(key);
        expect(prompt.text.replace(block, '')).not.toContain(key);
      },
    );
  });

  describe('digest path literals', () => {
    it.each(corpus.pathSegments.map((c) => [c.name, c.value]))('%s', (_n, seg) => {
      const d = basicExample().digest as Raw;
      d.templates[2].template = `/v2/${seg}/invoices`;
      expect(digestRefused(d)).toBe(true);
      const link = basicExample().digest as Raw;
      link.linkTemplates[0].template = `/coach/${seg}/programs`;
      expect(digestRefused(link)).toBe(true);
    });
  });

  describe('digest templates', () => {
    it.each(corpus.templates.map((c) => [c.name, c.value]))('%s', (_n, template) => {
      const d = basicExample().digest as Raw;
      d.templates[2].template = template;
      d.templates[2].slots = [];
      expect(digestRefused(d)).toBe(true);
    });
  });

  describe('digest query keys and header names', () => {
    it.each(corpus.queryKeys.map((c) => [c.name, c.value]))('query %s', (_n, key) => {
      const d = basicExample().digest as Raw;
      d.templates[1].queryKeys = [{ key, distinct: 1 }];
      expect(digestRefused(d)).toBe(true);
    });
    it.each(corpus.headerNames.map((c) => [c.name, c.value]))('header %s', (_n, name) => {
      const d = basicExample().digest as Raw;
      d.constantHeaderNames = [name];
      expect(digestRefused(d)).toBe(true);
    });
  });

  describe('digest slot and node fields cannot carry values', () => {
    it('slot value/hash/sample fields are refused', () => {
      for (const extra of [
        { hash: 'ab12' },
        { value: 'acme' },
        { sample: 'x' },
        { values: ['a'] },
      ]) {
        const d = basicExample().digest as Raw;
        Object.assign(d.templates[1].slots[0], extra);
        expect(digestRefused(d)).toBe(true);
      }
    });
    it('unobserved keys referenced by the proposal are refused (V-L5/V-L6)', () => {
      for (const key of corpus.keys.map((c) => c.value).concat(['ghost'])) {
        const p = basicExample().proposal as Raw;
        p.mappingSpec.families.clients.displayName.paths = [[key]];
        expect(proposalRefused(p)).toBe(true);
        const id = basicExample().proposal as Raw;
        id.steps[0].idField = key;
        expect(proposalRefused(id)).toBe(true);
      }
    });
  });

  describe('proposal strings', () => {
    it.each(corpus.rationales.map((c) => [c.name, c.value]))('rationale %s', (_n, text) => {
      const p = basicExample().proposal as Raw;
      p.rationale = text === 'x' ? 'x'.repeat(600) : text;
      expect(proposalRefused(p)).toBe(true);
    });
    it.each(corpus.entityTypes.map((c) => [c.name, c.value]))('entityType %s', (_n, value) => {
      const p = basicExample().proposal as Raw;
      p.steps[0].entityType = value;
      p.mappingSpec.steps = { [value]: 'clients', routines: 'workouts' };
      expect(proposalRefused(p)).toBe(true);
    });
    it('absolute URLs, headers, code and extra fields anywhere in the proposal are refused', () => {
      const cases: ((p: Raw) => void)[] = [
        (p) => (p.steps[0].url = 'https://host.example/v2/members'),
        (p) => (p.steps[0].templateRef = 'https://host.example/v2/members'),
        (p) => (p.steps[0].headers = { authorization: 'Bearer x' }),
        (p) => (p.steps[0].pagination.param = 'access_token'),
        (p) => (p.steps[0].pagination.param = 'page=1&token=x'),
        (p) => (p.mappingSpec.families.clients.displayName.coerce = 'eval(x)'),
        (p) => (p.mappingSpec.families.clients.displayName.paths = [['constructor', 'prototype']]),
        (p) => (p.mappingSpec.families.clients.displayName.paths = [['__proto__']]),
        (p) =>
          (p.mappingSpec.families.clients.email = {
            paths: [['email']],
            coerce: 'string_or_finite_number',
          }),
        (p) => (p.mappingSpec.families.clients.displayName.paths = [['email']]),
        (p) => (p.mappingSpec.sourcePlatform = 'https://host.example'),
        (p) => (p.mappingSpec.origin = 'https://host.example'),
        (p) =>
          (p.nativeRules.families.workouts.exercises.item.notes = {
            kind: 'text',
            paths: [['title']],
            template: '${x}',
          }),
        (p) => (p.explore = ['https://host.example/coach/1/programs']),
        (p) => (p.explore = ['/coach/:p1/programs']),
        (p) => (p.unmapped[0].reason = 'see https://host.example'),
        (p) => (p.rationale = 'Authorization: Bearer abc'),
        (p) => p.steps.push({ ...clone(p.steps[0]), entityType: 'copy' }),
      ];
      for (const mutate of cases) {
        const p = basicExample().proposal as Raw;
        mutate(p);
        expect(proposalRefused(p)).toBe(true);
      }
    });
    it('oversized and confusable content is refused', () => {
      const big = basicExample().proposal as Raw;
      big.rationale = 'a'.repeat(513);
      expect(proposalRefused(big)).toBe(true);
      const confusable = basicExample().proposal as Raw;
      confusable.steps[0].idField = 'іd';
      expect(proposalRefused(confusable)).toBe(true);
      const manySteps = basicExample().proposal as Raw;
      for (let i = 0; i < 9; i += 1)
        manySteps.steps.push({ ...clone(manySteps.steps[0]), entityType: `e${i}` });
      expect(proposalRefused(manySteps)).toBe(true);
      const bigMap = basicExample().proposal as Raw;
      bigMap.nativeRules.families.workouts.type = {
        kind: 'enum',
        paths: [['kind']],
        map: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'strength'])),
      };
      expect(proposalRefused(bigMap)).toBe(true);
    });
  });

  it('injected bytes that DO pass V-L0 (a corroborated benign key) appear only inside the untrusted block', () => {
    const d = basicExample().digest as Raw;
    const item = d.templates[1].shape.keys.members.items;
    item.keys.please_map_everything = { kind: 'boolean' };
    item.corroborated = ['please_map_everything'];
    const digest = parseStructureDigest(d);
    if (!digest.ok) throw new Error(JSON.stringify(digest.errors));
    const prompt = buildLearnPrompt({ digest: digest.value, examples: [], nonce: 'b'.repeat(40) });
    const block = untrustedBlock(prompt);
    expect(block).toContain('please_map_everything');
    expect(prompt.text.replace(block, '')).not.toContain('please_map_everything');
  });
});
