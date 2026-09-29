import { parseInductionManifest } from '../../../src/scout/induction/parse';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { parseNativeRuleSet } from '../../../src/scout/reconstruct/native/native-rules';
import type {
  RegistryDb,
  RunPackage,
  RunPackageSource,
} from '../../../src/scout/reconstruct/source-registry.provider';

/**
 * L2a r2 — one synthetic learned package (a hostname-shaped slug, as D-L0-5 defines for a learned
 * source) for the DI and settle-level specs. It lives only under `test/`: no file under `src/**`
 * names it. Same shape as the L06 package in `source-registry.provider.spec.ts`.
 */
export const COACH = 'coach-l2a-r2';
/** The run whose pin carries the learned package. */
export const PINNED = '6a1e2d3c-4b5a-4978-8899-aabbccddee01';
/** Another run of the same coach, with no pin. */
export const UNPINNED = '6a1e2d3c-4b5a-4978-8899-aabbccddee02';
export const LEARNED = 'app.l2a-r2-learned.example';
export const TOKEN = {
  clients: 'members',
  client_history: 'journal',
  workouts: 'sessions',
} as const;

export const PACKAGE: RunPackage = {
  spec: parseSourceMappingSpec(
    {
      specVersion: 1,
      sourcePlatform: LEARNED,
      steps: {
        [TOKEN.clients]: 'clients',
        [TOKEN.client_history]: 'client_history',
        [TOKEN.workouts]: 'workouts',
      },
      families: {
        clients: { displayName: { paths: [['profile', 'name']], coerce: 'string' } },
        client_history: {
          clientSourceId: { paths: [['member_id']], coerce: 'string' },
          label: { paths: [['headline']], coerce: 'string' },
        },
        workouts: {
          clientSourceId: { paths: [['member_id']], coerce: 'string' },
          label: { paths: [['headline']], coerce: 'string' },
        },
      },
    },
    'l2a-r2:learned-spec',
  ),
  nativeRuleSet: parseNativeRuleSet(
    {
      specVersion: 1,
      sourcePlatform: LEARNED,
      families: {
        workouts: {
          type: { kind: 'enum', paths: [['kind']], map: { lift: 'strength' }, default: 'strength' },
        },
      },
    },
    'l2a-r2:learned-rules',
  ),
  manifest: parseInductionManifest(
    {
      manifestVersion: 1,
      sourcePlatform: LEARNED,
      expectedFamilies: ['client_history', 'clients', 'workouts'],
      basisKinds: {
        client_history: ['source_signed_enumeration'],
        clients: ['source_signed_enumeration'],
        workouts: ['source_signed_enumeration'],
      },
      verifiers: [
        {
          key_id: 'l2a-r2-key-1',
          alg: 'ed25519',
          public_key_b64: Buffer.alloc(32, 1).toString('base64'),
        },
      ],
      nativeRules: 'declared',
    },
    'l2a-r2:learned-manifest',
  ),
};

/** One lookup a {@link RecordingSource} answered: the handle it was asked on and the run key. */
export interface Lookup {
  readonly db: RegistryDb;
  readonly key: string;
}

export type RecordingSource = RunPackageSource & { readonly lookups: Lookup[] };

/**
 * A `RunPackageSource` that answers with `answer(n)` on its n-th lookup (1-based) for
 * (COACH, PINNED) and `null` for every other run, recording every lookup and its handle.
 */
export function recordingSource(
  answer: (n: number) => RunPackage | null = () => PACKAGE,
): RecordingSource {
  const lookups: Lookup[] = [];
  return {
    lookups,
    forRun: (db, coachId, intentId) => {
      lookups.push({ db, key: `${coachId}/${intentId}` });
      const n = lookups.filter((l) => l.key === `${COACH}/${PINNED}`).length;
      return Promise.resolve(coachId === COACH && intentId === PINNED ? answer(n) : null);
    },
  };
}
