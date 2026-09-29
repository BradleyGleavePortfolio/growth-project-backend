import { parseStructureDigest } from '../../../src/scout/learn/digest-contract';
import { structureFingerprint } from '../../../src/scout/learn/fingerprint';
import { buildLearnedPackage, packageDigest } from '../../../src/scout/learn/package';
import { buildLearnPrompt } from '../../../src/scout/learn/prompt';
import { parseLearnedProposal, validateLearnedProposal } from '../../../src/scout/learn/proposal';
import { basicExample, parsedBasic } from './helpers';

/**
 * L14 (metamorphic, D-L0-8 "no vendor names"): a vendor/tenant word placed anywhere a site or a
 * model can put it either (a) is refused as a non-vocabulary literal / uncorroborated key, or (b)
 * when admitted as DATA (a corroborated key, a slug), changes nothing but that data — no branch
 * in the validators, the fingerprint material, the package, or the prompt's instruction parts
 * depends on the word. The word below is a stand-in for any vendor name.
 */
const VENDOR = 'zorvex';
type Raw = Record<string, any>;

describe('metamorphic: a vendor word cannot change core behaviour except via data', () => {
  it('as a path literal it is refused, whatever the case or position', () => {
    for (const template of [
      `/${VENDOR}/clients`,
      `/v2/${VENDOR}/clients`,
      `/v2/clients/${VENDOR}`,
      `/v2/${VENDOR.toUpperCase()}/clients`,
    ]) {
      const d = basicExample().digest as Raw;
      d.templates[2].template = template;
      expect(parseStructureDigest(d).ok).toBe(false);
    }
  });

  it('as an uncorroborated key it is refused; corroborated it is admitted as data with identical fingerprint and behaviour', () => {
    const base = parsedBasic();
    const d = basicExample().digest as Raw;
    const item = d.templates[1].shape.keys.members.items;
    item.keys[VENDOR] = { kind: 'boolean' };
    expect(parseStructureDigest(JSON.parse(JSON.stringify(d))).ok).toBe(false);
    item.corroborated = [VENDOR];
    const digest = parseStructureDigest(d);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    // the fingerprint is kinds-only: the added boolean changes structure, the NAME does not
    const renamed = JSON.parse(JSON.stringify(d)) as Raw;
    const renamedItem = renamed.templates[1].shape.keys.members.items;
    renamedItem.keys.flag = renamedItem.keys[VENDOR];
    delete renamedItem.keys[VENDOR];
    renamedItem.corroborated = ['flag'];
    const renamedDigest = parseStructureDigest(renamed);
    if (!renamedDigest.ok) throw new Error(JSON.stringify(renamedDigest.errors));
    expect(structureFingerprint(digest.value)).toBe(structureFingerprint(renamedDigest.value));
    // the same proposal validates identically against both
    const proposal = parseLearnedProposal(basicExample().proposal);
    if (!proposal.ok) throw new Error('fixture');
    const a = validateLearnedProposal(proposal.value, digest.value, { slug: 'example_alpha' });
    const b = validateLearnedProposal(proposal.value, renamedDigest.value, {
      slug: 'example_alpha',
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(packageDigest(buildLearnedPackage(a.value))).toEqual(
      packageDigest(buildLearnedPackage(b.value)),
    );
    expect(packageDigest(buildLearnedPackage(a.value))).not.toEqual(
      packageDigest(buildLearnedPackage(base.validated)),
    );
    // the prompt differs only inside the untrusted block
    const nonce = 'c'.repeat(40);
    const pa = buildLearnPrompt({ digest: digest.value, examples: [], nonce });
    const pb = buildLearnPrompt({ digest: renamedDigest.value, examples: [], nonce });
    expect(pa.parts.slice(0, 5)).toEqual(pb.parts.slice(0, 5));
    expect(pa.contractHash).toBe(pb.contractHash);
    expect(pa.outputSchemaHash).toBe(pb.outputSchemaHash);
  });

  it('as the slug it is data: the fingerprint, contract hash and schema hash do not move; only slug-bearing fields do', () => {
    const base = parsedBasic();
    const d = basicExample().digest as Raw;
    d.sourcePlatform = VENDOR;
    const p = basicExample().proposal as Raw;
    p.mappingSpec.sourcePlatform = VENDOR;
    p.nativeRules.sourcePlatform = VENDOR;
    const digest = parseStructureDigest(d);
    const proposal = parseLearnedProposal(p);
    if (!digest.ok || !proposal.ok) throw new Error('fixture');
    const validated = validateLearnedProposal(proposal.value, digest.value, { slug: VENDOR });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(structureFingerprint(digest.value)).toBe(structureFingerprint(base.digest));
    const pkg = buildLearnedPackage(validated.value);
    const basePkg = buildLearnedPackage(base.validated);
    expect({ ...pkg, sourcePlatform: 0, mappingSpec: 0, nativeRules: 0, manifest: 0 }).toEqual({
      ...basePkg,
      sourcePlatform: 0,
      mappingSpec: 0,
      nativeRules: 0,
      manifest: 0,
    });
    expect(JSON.stringify(pkg).split(VENDOR).length - 1).toBe(4);
    // and the slug is refused wherever it is not the run's slug
    expect(
      validateLearnedProposal(proposal.value, digest.value, { slug: 'example_alpha' }).ok,
    ).toBe(false);
  });

  it('as an entityType, collectAs or rationale word it is plain data', () => {
    const p = basicExample().proposal as Raw;
    p.steps[0].entityType = VENDOR;
    p.mappingSpec.steps = { [VENDOR]: 'clients', routines: 'workouts' };
    p.rationale = `${VENDOR} roster and routines`;
    const digest = parseStructureDigest(basicExample().digest);
    const proposal = parseLearnedProposal(p);
    if (!digest.ok || !proposal.ok)
      throw new Error(JSON.stringify(proposal.ok ? '' : proposal.errors));
    const validated = validateLearnedProposal(proposal.value, digest.value, {
      slug: 'example_alpha',
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.value.steps[0].family).toBe('clients');
  });

  it('the source tree names no vendor: only the vocabulary and admission words are literals', () => {
    // scripts/vendor-name-guard.mjs is the authority; this asserts the learn module has no
    // capitalised brand-like identifier in its exported vocabulary or admission words.
    const { STRUCTURAL_PATH_VOCABULARY } = jest.requireActual(
      '../../../src/scout/learn/contract-vocabulary',
    ) as typeof import('../../../src/scout/learn/contract-vocabulary');
    const { STRUCTURAL_KEY_VOCABULARY } = jest.requireActual(
      '../../../src/scout/learn/admission',
    ) as typeof import('../../../src/scout/learn/admission');
    for (const w of [...STRUCTURAL_PATH_VOCABULARY, ...STRUCTURAL_KEY_VOCABULARY])
      expect(w).not.toContain(VENDOR);
  });
});
