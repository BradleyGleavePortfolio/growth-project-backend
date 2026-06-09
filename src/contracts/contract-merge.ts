/**
 * B5 — Merge-field rendering (spec §5.1).
 *
 * Resolves `{{token}}` merge fields against sample/real data. The
 * `{{*.signature_block}}` tokens are NOT substituted with data — they map to
 * provider signature ANCHORS (HelloSign text-tags) and are rewritten to the
 * provider's anchor syntax at render-to-provider time. Every OTHER unknown
 * token fails LOUDLY (returned as an error list), never silently rendered as
 * empty — a blank merge field in a legal document is a defect (spec §5.1).
 */

/** The full set of supported data merge tokens (spec §5.1 table). */
export const KNOWN_DATA_TOKENS = [
  'client.first_name',
  'client.last_name',
  'client.email',
  'coach.first_name',
  'coach.business_name',
  'package.name',
  'package.price',
  'package.duration',
  'today',
] as const;

/** Signature-anchor tokens — resolved to provider anchors, not data. */
export const SIGNATURE_BLOCK_TOKENS = [
  'client.signature_block',
  'coach.signature_block',
] as const;

export type MergeData = Partial<Record<(typeof KNOWN_DATA_TOKENS)[number], string>>;

export interface RenderResult {
  /** Rendered body with data tokens resolved and signature anchors mapped. */
  html: string;
  /** Tokens that could not be resolved (unknown OR missing data). */
  unknownTokens: string[];
  /** Whether both signature-block anchors were present. */
  hasClientSignatureBlock: boolean;
  hasCoachSignatureBlock: boolean;
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** HelloSign text-tag anchors for the two signers (spec §5.1). */
export const SIGNATURE_ANCHORS = {
  client: '[sig|req|signer1]',
  coach: '[sig|req|signer2]',
} as const;

/**
 * Render a template body. `signatureMode='anchor'` rewrites signature blocks
 * to provider anchors (for sending to the provider); `signatureMode='preview'`
 * renders human-readable placeholders (for test-render previews).
 */
export function renderTemplate(
  bodyMarkdown: string,
  data: MergeData,
  signatureMode: 'anchor' | 'preview' = 'anchor',
): RenderResult {
  const unknown = new Set<string>();
  let hasClientSig = false;
  let hasCoachSig = false;

  const html = bodyMarkdown.replace(TOKEN_RE, (_match, rawToken: string) => {
    const token = rawToken.trim();

    if (token === 'client.signature_block') {
      hasClientSig = true;
      return signatureMode === 'anchor'
        ? SIGNATURE_ANCHORS.client
        : '〔 Client signature 〕';
    }
    if (token === 'coach.signature_block') {
      hasCoachSig = true;
      return signatureMode === 'anchor'
        ? SIGNATURE_ANCHORS.coach
        : '〔 Coach signature 〕';
    }

    if ((KNOWN_DATA_TOKENS as readonly string[]).includes(token)) {
      const v = (data as Record<string, string | undefined>)[token];
      if (v === undefined || v === null || v === '') {
        // Known token but no data supplied → loud failure (defect).
        unknown.add(token);
        return _match;
      }
      return escapeHtml(v);
    }

    // Completely unknown token → loud failure.
    unknown.add(token);
    return _match;
  });

  return {
    html,
    unknownTokens: [...unknown],
    hasClientSignatureBlock: hasClientSig,
    hasCoachSignatureBlock: hasCoachSig,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Deterministic sample data for `test-render` previews (spec §3.4). */
export function sampleMergeData(): MergeData {
  return {
    'client.first_name': 'Alex',
    'client.last_name': 'Morgan',
    'client.email': 'alex.morgan@example.com',
    'coach.first_name': 'Jordan',
    'coach.business_name': 'Peak Form Coaching LLC',
    'package.name': '12-Week Transformation',
    'package.price': '$1,200.00',
    'package.duration': '12 weeks',
    today: new Date().toISOString().slice(0, 10),
  };
}
