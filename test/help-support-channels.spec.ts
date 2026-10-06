import { renderHelpPage, SUPPORT_EMAIL } from '../src/public-pages/help-pages.html';

describe('public help support channels', () => {
  it('describes the in-app support route with email as an alternative', () => {
    const html = renderHelpPage('contact');
    expect(html).toContain('Settings');
    expect(html).toContain('Support');
    expect(html).toContain('in-app support chat');
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(html).not.toContain('There is no chat or phone line.');
    expect(html).not.toContain('Email is the only support channel today');
  });

  it('does not promise a phone line or round-the-clock response', () => {
    const html = renderHelpPage('contact');
    expect(html).toContain('There is no phone line.');
    expect(renderHelpPage('support')).toContain('We do not run a 24/7 desk.');
  });
});
