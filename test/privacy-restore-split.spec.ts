// #611 fix round 6 (operator ruling OR-114-1; GPT-6.1 Sol B-611-5 / B-611-6).
// The draft restore runbook in docs/privacy/vendor-deletion-and-backups.md
// replayed AI-consent withdrawals "first" from a projection without
// copy_sha256, which can turn a person's final "no" into a live grant. It is
// split out of #611 into the T4 follow-up (backend issue #662). These tests
// pin that:
//  - the document carries no restore procedure, only the requirement and the
//    pointer to the follow-up;
//  - the public pages promise no restore procedure, while the backup
//    age-out wording they do publish stays in place;
//  - the Sentry section matches mobile main after #330 (id only).
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderHelpPage } from '../src/public-pages/help-pages.html';
import { renderTrustPage, type TrustPage } from '../src/public-pages/trust-pages.html';

const DOC = readFileSync(join(__dirname, '../docs/privacy/vendor-deletion-and-backups.md'), 'utf8');
const README = readFileSync(join(__dirname, '../src/public-pages/README.md'), 'utf8');
const FOLLOW_UP_URL = 'https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/662';
const TRUST_PAGES: TrustPage[] = ['privacy', 'consumer-health', 'terms', 'security', 'status'];

function visibleText(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  return body
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&(?:quot|#39|lt|gt|amp);/g, (m) =>
      m === '&quot;' ? '"' : m === '&#39;' ? "'" : m === '&lt;' ? '<' : m === '&gt;' ? '>' : '&',
    )
    .replace(/\s+/g, ' ');
}

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe('#611 restore runbook split (B-611-5, B-611-6)', () => {
  it('the vendor document carries no restore procedure of record', () => {
    // The unsafe draft steps are gone.
    expect(DOC).not.toMatch(/withdrawals first/i);
    expect(DOC).not.toMatch(/re-append/i);
    expect(DOC).not.toMatch(/FROM "AiProcessingConsentEvent"/);
    expect(DOC).not.toMatch(/Before reopening traffic:/);
    expect(DOC).not.toMatch(/restore-without-resurrection procedure/i);
    const restore = section(DOC, '### 1.2 ');
    expect(restore).toMatch(/no restore procedure/i);
    // No numbered steps or SQL in the restore section.
    expect(restore).not.toMatch(/^\s*\d+\.\s/m);
    expect(restore).not.toMatch(/SELECT\s/i);
  });

  it('states the AI-consent-preserving requirement and points to the T4 follow-up', () => {
    const restore = section(DOC, '### 1.2 ');
    expect(restore).toMatch(
      /before the app or any job reads the restored data, every erasure, chat delete, AI-consent withdrawal and scheduled deletion recorded after the restore point is re-applied/,
    );
    expect(restore).toMatch(/Traffic reopens only after that/);
    expect(restore).toMatch(/never synthesize a grant/);
    expect(restore).toMatch(/original order, version and copy hash/);
    expect(restore).toMatch(/fail closed/);
    expect(restore).toContain(FOLLOW_UP_URL);
    expect(restore).toMatch(/separate T4 work/);
    expect(DOC).toMatch(/Restoring a database backup is out of scope/);
    expect(README).toMatch(/backend issue #662/);
    expect(README).not.toMatch(/restore-without-resurrection procedure/);
  });

  it('the public pages promise no restore procedure but keep the backup age-out wording', () => {
    const pages = [
      ...TRUST_PAGES.map((p) => visibleText(renderTrustPage(p))),
      visibleText(renderHelpPage('delete-account')),
    ];
    for (const text of pages) {
      expect(text).not.toMatch(/\brestor(e|es|ed|ing)\b/i);
    }
    const privacy = visibleText(renderTrustPage('privacy'));
    expect(privacy).toMatch(/never kept more than six months after a confirmed deletion request/);
    const health = visibleText(renderTrustPage('consumer-health'));
    expect(health).toMatch(/never kept more than six months after a confirmed deletion request/);
    // The age-out facts that make that wording true stay in the document.
    expect(DOC).toMatch(/### 1\.1 Our own database dumps/);
    expect(DOC).toMatch(/Never keep any dump for more than 90 days/);
  });

  it('the Sentry section matches mobile after #330 (id only, no email)', () => {
    const sentry = section(DOC, '## 6. Sentry');
    expect(sentry).not.toMatch(/id and email/i);
    expect(sentry).toMatch(/only the opaque user \*\*id\*\*/);
    expect(sentry).toMatch(/mobile #330/);
  });
});
