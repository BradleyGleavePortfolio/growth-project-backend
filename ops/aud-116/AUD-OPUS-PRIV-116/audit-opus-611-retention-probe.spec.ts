/**
 * AUD-OPUS-PRIV-116 probe (audit only, never merged) for backend #611 @ 5eac8f21.
 *
 * B-611-10: /help/delete-account "What we keep, and for how long" must list every
 * item the Privacy Policy says is kept after deletion (closed-account record,
 * provider id while removal retries, 30-day one-way code) and the round-7
 * post-deletion facts (Anthropic 30 days, de-identified aggregates).
 * B-611-11: the deploy runbook step that creates database dumps must carry the
 * published 30-day / 90-day limits.
 *
 * Expected at 5eac8f21: the control tests pass, the help-page and runbook tests fail.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';
import { renderHelpPage } from '../src/public-pages/help-pages.html';

function visibleText(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const map: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
  return body
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => map[m] ?? m)
    .replace(/\s+/g, ' ');
}

const privacy = visibleText(renderTrustPage('privacy'));
const help = visibleText(renderHelpPage('delete-account'));
const keep = help.slice(help.indexOf('What we keep, and for how long'), help.indexOf('How long it takes'));
const RUNBOOK = readFileSync(join(__dirname, '..', 'docs', 'deploy-runbook.md'), 'utf8');
const dumpStep = RUNBOOK.slice(
  RUNBOOK.indexOf('Take a reference dump before any deploy'),
  RUNBOOK.indexOf('4. **Deploy.**'),
);

describe('AUD-OPUS-PRIV-116 probe #611 retention consistency', () => {
  it('control: the Privacy Policy lists the kept closed-account record, provider id, one-way code, Anthropic and de-identified data', () => {
    expect(privacy).toMatch(/a closed-account record with no name, contact details or profile/);
    expect(privacy).toMatch(/we also keep that provider’s account ID/);
    expect(privacy).toMatch(/one-way code made from it, for 30 days/);
    expect(privacy).toMatch(/Anthropic deletes what it receives within 30 days/);
    expect(privacy).toMatch(/de-identified, aggregated information/);
  });

  it('B-611-10a: /help/delete-account "What we keep" lists the closed-account record', () => {
    expect(keep).toMatch(/closed-account record/i);
  });

  it('B-611-10b: /help/delete-account "What we keep" lists the provider id while removal retries and the 30-day one-way code', () => {
    expect(keep).toMatch(/sign-in provider/i);
    expect(keep).toMatch(/one-way code/i);
  });

  it('B-611-10c: /help/delete-account "What we keep" carries the Anthropic 30-day sentence and the de-identified clause', () => {
    expect(keep).toMatch(/Anthropic deletes what it receives within 30 days/);
    expect(keep).toMatch(/de-identified/i);
  });

  it('B-611-11: the runbook dump step carries the published 30-day / 90-day limits', () => {
    expect(dumpStep.length).toBeGreaterThan(100);
    expect(dumpStep).toMatch(/30 days/);
    expect(dumpStep).toMatch(/90 days/);
  });
});
