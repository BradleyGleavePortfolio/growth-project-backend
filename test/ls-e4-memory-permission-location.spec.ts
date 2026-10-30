import { renderTrustPage, type TrustPage } from '../src/public-pages/trust-pages.html';

function visibleText(page: TrustPage): string {
  return renderTrustPage(page)
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('LS-E4 B1: every policy describes the one-box Roman permission location truthfully', () => {
  it.each(['privacy', 'consumer-health'] as TrustPage[])(
    '%s does not claim Roman permission is given in the consultation',
    (page) => {
      const text = visibleText(page);
      // A new one-box agreement grants no Roman permission. Its first Roman
      // permission is requested later, as the updated policy itself states.
      // FR-E4B (agent 186): anchor follows the approved phrase B (185-W4, 10-30).
      expect(text).toContain('the app asks for it when you first open Roman');
      expect(text).not.toMatch(/Roman permission you give in the consultation/);
    },
  );
});
