import * as fs from 'fs';
import * as path from 'path';
import { SUPPORT_EMAIL } from '../src/public-pages/trust-pages.html';
import {
  SUPPORT_EMAIL as HELP_SUPPORT_EMAIL,
  renderHelpPage,
} from '../src/public-pages/help-pages.html';
import { renderDownloadPage, renderSignupPage } from '../src/public-pages/public-pages.html';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';

// S-ERRORS (owner ruling 2026-10-01 14:19 PDT): one support email everywhere.
// SUPPORT_EMAIL in src/public-pages/trust-pages.html.ts is the only support
// contact the backend may publish. This guard fails the build if any other
// email address appears anywhere under src/ (code, HTML templates, READMEs),
// unless it is a reserved placeholder domain or listed in ALLOWED below with
// the reason it is not a support contact.

const OWNER_SUPPORT_EMAIL = 'Bradleyapple1031@gmail.com';

// Addresses that may appear in src/ because they are NOT support contacts.
// Every entry needs a reason. An entry that no longer appears in src/ fails
// the stale-entry test below, so the list cannot silently grow.
const ALLOWED: Record<string, string> = {
  'noreply@growthprojectapp.com':
    'Outbound sender (From) on the Resend-verified domain for every email (B-EMAILFROM-126); replies are not read.',
  'no-reply@thegrowthproject.app':
    'Outbound sender named in the data-export README; not a contact address.',
  'contracts@trygrowthproject.com':
    'Fallback party identity on a generated coaching contract when the coach record has no email; not presented as support.',
  'x@evil.com':
    'Code comment describing the URL host-hijack vector the ActiveCampaign adapter blocks.',
};

// RFC 2606 / RFC 6761 reserved names: they cannot receive mail, so they are
// test data, placeholders or tombstones, never a published contact.
const RESERVED_DOMAIN = /(^|\.)(example\.(com|org|net)|invalid|test|example|localhost)$/i;

// Addresses the owner retired. Named so a regression reads clearly in CI.
const RETIRED = [
  'hello@trygrowthproject.com',
  'Bradley@Bradleytgpcoaching.com',
  'hello@thegrowthproject.app',
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const SCANNED_EXT = new Set(['.ts', '.js', '.md', '.html', '.json', '.txt', '.hbs']);

function isTestFile(file: string): boolean {
  return (
    /\.(spec|test)\.[jt]s$/.test(file) ||
    file.split(path.sep).includes('__tests__') ||
    file.split(path.sep).includes('__mocks__')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCANNED_EXT.has(path.extname(entry.name)) && !isTestFile(full)) out.push(full);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  address: string;
}

/** Every address in `text` that is not the support email, a reserved placeholder, or allowlisted. */
export function disallowedAddresses(text: string, file = '<inline>'): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((lineText, i) => {
    for (const m of lineText.matchAll(EMAIL)) {
      const address = m[0].replace(/\.+$/, '');
      const domain = address.slice(address.lastIndexOf('@') + 1);
      if (address.toLowerCase() === SUPPORT_EMAIL.toLowerCase()) continue;
      if (RESERVED_DOMAIN.test(domain)) continue;
      if (Object.keys(ALLOWED).some((a) => a.toLowerCase() === address.toLowerCase())) continue;
      hits.push({ file, line: i + 1, address });
    }
  });
  return hits;
}

describe('support email guard (S-ERRORS, one support email)', () => {
  const files = walk(SRC_ROOT);
  const corpus = files.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));

  it('SUPPORT_EMAIL is the owner-ruled address and the help pages reuse it', () => {
    expect(SUPPORT_EMAIL).toBe(OWNER_SUPPORT_EMAIL);
    expect(HELP_SUPPORT_EMAIL).toBe(SUPPORT_EMAIL);
  });

  it('scans a real source tree (the guard cannot pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('public-pages', 'trust-pages.html.ts')))).toBe(
      true,
    );
  });

  it('no other email address appears under src/ unless reserved or allowlisted with a reason', () => {
    const hits = corpus.flatMap(({ f, text }) =>
      disallowedAddresses(text, path.relative(SRC_ROOT, f)),
    );
    expect(hits).toEqual([]);
  });

  it('no retired support address remains anywhere under src/', () => {
    const found = corpus.flatMap(({ f, text }) =>
      RETIRED.filter((r) => text.toLowerCase().includes(r.toLowerCase())).map(
        (r) => `${path.relative(SRC_ROOT, f)}: ${r}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('every allowlist entry is still used (no stale exceptions)', () => {
    const all = corpus.map(({ text }) => text.toLowerCase()).join('\n');
    const stale = Object.keys(ALLOWED).filter((a) => !all.includes(a.toLowerCase()));
    expect(stale).toEqual([]);
  });

  it('the detector flags a planted support address and a retired one (negative control)', () => {
    expect(disallowedAddresses('email support@tgp-help.com today')).toEqual([
      { file: '<inline>', line: 1, address: 'support@tgp-help.com' },
    ]);
    expect(disallowedAddresses("const a = 'hello@trygrowthproject.com';")).toHaveLength(1);
    expect(disallowedAddresses(`mailto:${OWNER_SUPPORT_EMAIL.toUpperCase()}`)).toEqual([]);
    expect(disallowedAddresses('jane@example.com and gone@tombstone.invalid')).toEqual([]);
  });

  it('every rendered public page that offers email uses only SUPPORT_EMAIL', () => {
    const pages = [
      renderDownloadPage('ios'),
      renderDownloadPage('android'),
      renderSignupPage('GP-A1B2C3'),
      renderSignupPage(null),
      renderTrustPage('privacy'),
      renderTrustPage('terms'),
      renderTrustPage('security'),
      renderTrustPage('status'),
      ...(['index', 'setup', 'first-client', 'tour', 'faq', 'support', 'contact'] as const).map(
        (p) => renderHelpPage(p),
      ),
    ];
    for (const html of pages) {
      expect(disallowedAddresses(html)).toEqual([]);
      for (const m of html.matchAll(/mailto:([^?"'&\s]+)/g)) {
        expect(decodeURIComponent(m[1]).toLowerCase()).toBe(SUPPORT_EMAIL.toLowerCase());
      }
    }
    expect(renderSignupPage('GP-A1B2C3')).toContain(`mailto:${SUPPORT_EMAIL}`);
    expect(renderTrustPage('privacy')).toContain(SUPPORT_EMAIL);
  });
});
