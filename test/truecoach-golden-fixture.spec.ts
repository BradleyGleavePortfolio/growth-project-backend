import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

// D1 — TrueCoach golden fixture: provenance + deterministic byte pin.
//
// Provenance (do not paraphrase these SHAs — they are the audit trail):
//   source repo   : BradleyGleavePortfolio/tgp-importer-extension (PR-C1c)
//   merged main   : 4f116836ddb5449524dd51e995a7e4c012f79493
//   PR #7 head    : 0ea894ec2fb16e6a08bb9b4556cbab4250a07e63
//   source path   : test/fixtures/cdp-traces/truecoach-clients.json
//   source blob   : 826fc5124a1cb6d45c9fbb87b5d3437974b8c3c2 (git blob sha1)
//
// The file at test/fixtures/truecoach/clients.golden.json is a byte-for-byte
// copy of that recorded chrome.debugger CDP trace. Because the bytes are
// identical, `git hash-object` on the committed file reproduces the source
// blob sha1 above — that identity IS the provenance proof. This spec pins the
// bytes with sha256 (git's blob sha1 is a weak primitive and is not recomputed
// in code per the crypto-standards rule) so any silent drift fails loudly at
// CI time rather than at import-replay time.
//
// Scope: D1 proves the fixture and its provenance ONLY. It deliberately does
// not import any mapper/reconstruction/auth service — that production behavior
// lands with IMPORTER-F, not here.

const GOLDEN_PATH = join(
  __dirname,
  'fixtures',
  'truecoach',
  'clients.golden.json',
);

// Deterministic byte pin of the exact recorded bytes.
const EXPECTED_SHA256 =
  'af0387fea53dac5a9622c7de6d142c53986b6f4995784eccd6c51f204557e71f';
const EXPECTED_BYTE_LENGTH = 2668;

// Hard scope boundary: billing/payment/card/vault/subscription instruments are
// OUT OF SCOPE for the importer and must never be captured in a client fixture.
const FORBIDDEN_BILLING_TOKENS = [
  'card',
  'cardnumber',
  'cvv',
  'cvc',
  'iban',
  'routing',
  'account_number',
  'payment_method',
  'paymentmethod',
  'payment_profile',
  'vault',
  'stripe',
  'subscription',
  'billing',
  'sk_live',
  'pk_live',
  'credit_card',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const rawBytes = readFileSync(GOLDEN_PATH);
const rawText = rawBytes.toString('utf8');

describe('TrueCoach golden fixture (D1 provenance + byte pin)', () => {
  it('matches the recorded byte length from extension PR-C1c', () => {
    expect(rawBytes.byteLength).toBe(EXPECTED_BYTE_LENGTH);
  });

  it('matches the deterministic sha256 byte pin', () => {
    const digest = createHash('sha256').update(rawBytes).digest('hex');
    expect(digest).toBe(EXPECTED_SHA256);
  });

  it('parses as JSON with the recorded CDP-trace shape', () => {
    const parsed: unknown = JSON.parse(rawText);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(isRecord(parsed.responseBody)).toBe(true);
    if (!isRecord(parsed.responseBody)) return;
    expect(typeof parsed.responseBody.body).toBe('string');
  });

  it('carries the recorded client payload, not synthesized data', () => {
    const parsed: unknown = JSON.parse(rawText);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    expect(isRecord(parsed.responseBody)).toBe(true);
    if (!isRecord(parsed.responseBody)) return;
    expect(typeof parsed.responseBody.body).toBe('string');
    if (typeof parsed.responseBody.body !== 'string') return;
    const payload: unknown = JSON.parse(parsed.responseBody.body);
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload)) return;
    expect(Array.isArray(payload.clients)).toBe(true);
  });

  it('captures no billing/payment/card/vault instruments (hard boundary)', () => {
    const haystack = rawText.toLowerCase();
    const hits = FORBIDDEN_BILLING_TOKENS.filter((token) =>
      haystack.includes(token),
    );
    expect(hits).toEqual([]);
  });
});
