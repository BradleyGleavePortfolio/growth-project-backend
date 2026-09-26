import type { CanonicalFamily } from '../../src/scout/reconstruct/mapping-spec';
import type { InductionManifestV1 } from '../../src/scout/induction/contract';
import { canonicalJson, sha256Hex } from '../../src/scout/induction/digest';
import type { InductionRegistry } from '../../src/scout/induction/manifest-registry';

// S10-B synthetic fixtures (unit specs + the real-PG worker). Every value is synthetic: platform
// slugs, scope digests and statements are generated here and name no real source, coach or client.
// The signature is 64 zero bytes: storage never verifies (the S10-C evaluator does), so a stored
// row proves nothing — exactly the D-S10-2 posture this slice must keep.

export const PLATFORM_A = 'synthetic-src-a';
export const PLATFORM_B = 'synthetic-src-b';
export const SCOPE_1 = sha256Hex('synthetic-scope-1');
export const SCOPE_2 = sha256Hex('synthetic-scope-2');
export const SPEC_DIGEST = sha256Hex('synthetic-mapping-spec');
export const ZERO_CHALLENGE = Buffer.alloc(32, 7);

export interface EvidenceSpec {
  platform?: string;
  scope?: string;
  family?: CanonicalFamily;
  challenge?: Buffer;
  observedUnique?: number;
  keyId?: string;
}

/** One raw (JSON-shaped) ObservationEvidenceV1 whose statement parses under S10-A. */
export function rawEvidence(spec: EvidenceSpec = {}): Record<string, unknown> {
  const platform = spec.platform ?? PLATFORM_A;
  const scope = spec.scope ?? SCOPE_1;
  const family = spec.family ?? 'clients';
  const statement = {
    account_scope_id_digest: scope,
    challenge_b64: (spec.challenge ?? ZERO_CHALLENGE).toString('base64'),
    date_window: null,
    family,
    id_set_digest: sha256Hex(`synthetic-ids-${platform}-${family}`),
    issued_at: '2026-09-26T00:00:00Z',
    observed_unique: spec.observedUnique ?? 3,
    snapshot_ref_digest: sha256Hex(`synthetic-snapshot-${platform}`),
    source_platform: platform,
    statement_version: 1,
    terminal: 'end_of_list',
  };
  const text = canonicalJson(statement);
  if (text === null) throw new Error('synthetic statement is not canonical');
  return {
    evidence_version: 1,
    source_platform: platform,
    account_scope_id_digest: scope,
    family,
    basis_kind: 'source_signed_enumeration',
    mapping_spec_digest: SPEC_DIGEST,
    statement_b64: Buffer.from(text, 'utf8').toString('base64'),
    key_id: spec.keyId ?? 'synthetic-key-1',
    signature_b64: Buffer.alloc(64).toString('base64'),
  };
}

/** An in-memory InductionRegistry: each platform gets a manifest listing `families`. */
export function syntheticRegistry(
  platforms: Readonly<Record<string, readonly CanonicalFamily[]>>,
): InductionRegistry {
  const packages = new Map<string, { manifest: InductionManifestV1; specDigest: string }>();
  const specFamilies = new Map<string, readonly CanonicalFamily[]>();
  for (const [platform, families] of Object.entries(platforms)) {
    const sorted = [...families].sort();
    const basisKinds: Partial<Record<CanonicalFamily, readonly 'source_signed_enumeration'[]>> = {};
    for (const family of sorted) basisKinds[family] = ['source_signed_enumeration'];
    packages.set(platform, {
      manifest: {
        manifestVersion: 1,
        sourcePlatform: platform,
        expectedFamilies: sorted,
        basisKinds,
        verifiers: [
          {
            key_id: 'synthetic-key-1',
            alg: 'ed25519',
            public_key_b64: Buffer.alloc(32).toString('base64'),
          },
        ],
        nativeRules: 'absent',
      },
      specDigest: SPEC_DIGEST,
    });
    specFamilies.set(platform, sorted);
  }
  return { packages, specFamilies };
}
