import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseStructureDigest,
  type StructureDigestV1,
} from '../../../src/scout/learn/digest-contract';
import {
  parseLearnedProposal,
  validateLearnedProposal,
  type LearnedProposalV1,
  type ValidatedProposal,
} from '../../../src/scout/learn/proposal';
import {
  buildLearnPrompt,
  type LearnPrompt,
  type LearnPromptInput,
} from '../../../src/scout/learn/prompt';

/** The basic example's slug: server-side context, never in the digest (r5). */
export const BASIC_SLUG = 'example_alpha';

export const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'scout', 'learn');

export function loadJson<T = unknown>(relative: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, relative), 'utf8')) as T;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface BasicExample {
  digest: Record<string, unknown>;
  proposal: Record<string, unknown>;
}

export function basicExample(): BasicExample {
  return clone(loadJson<BasicExample>('examples/basic.json'));
}

export function parsedBasic(): {
  raw: BasicExample;
  digest: StructureDigestV1;
  proposal: LearnedProposalV1;
  validated: ValidatedProposal;
} {
  const raw = basicExample();
  const digest = parseStructureDigest(raw.digest);
  if (!digest.ok) throw new Error(`basic digest: ${JSON.stringify(digest.errors)}`);
  const proposal = parseLearnedProposal(raw.proposal);
  if (!proposal.ok) throw new Error(`basic proposal: ${JSON.stringify(proposal.errors)}`);
  const validated = validateLearnedProposal(proposal.value, digest.value, { slug: BASIC_SLUG });
  if (!validated.ok) throw new Error(`basic validation: ${JSON.stringify(validated.errors)}`);
  return { raw, digest: digest.value, proposal: proposal.value, validated: validated.value };
}

export function codesOf(result: { ok: boolean; errors?: readonly { code: string }[] }): string[] {
  return result.ok ? [] : [...new Set((result.errors ?? []).map((e) => e.code))];
}

/** Walk every string (keys and values) of a JSON value. */
export function everyString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) everyString(v, visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k);
      everyString(v, visit);
    }
  }
}

/** Build a prompt that must succeed (the digest passes V-L0). */
export function promptOf(input: LearnPromptInput): LearnPrompt {
  const built = buildLearnPrompt(input);
  if (!built.ok) throw new Error(`prompt: ${JSON.stringify(built.errors)}`);
  return built.value;
}

/** The refs of the basic example: routines moved to t4 when the notes template (t3) was added. */
export const REF = Object.freeze({
  invoices: 't0',
  members: 't1',
  me: 't2',
  notes: 't3',
  routines: 't4',
});
