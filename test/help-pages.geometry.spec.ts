// FIX-1126-R1 (LS1126-B1): a real-browser layout check for every /help route.
// Each page is laid out in headless Chrome at phone widths (iPhone 390, Android
// 360, and 300 / 277 = those two at 130% text) and must never be wider than the
// screen: no sideways scroll from the contact table or a long URL.
// CI runners ship Google Chrome; set CHROME_BIN to point at another build.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderHelpPage, type HelpPage } from '../src/public-pages/help-pages.html';

const PAGES: HelpPage[] = [
  'index', 'setup', 'first-client', 'tour', 'faq', 'support', 'contact', 'delete-account',
];
const WIDTHS = [390, 360, 300, 277];
const CHROME = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// One Chrome run: every page x width in its own same-origin srcdoc frame; the
// harness writes each frame's document width and viewport width into #out.
function measure(): Array<[string, number, number]> {
  const frames = PAGES.flatMap((p) =>
    WIDTHS.map(
      (w) =>
        `<iframe data-k="${p}@${w}" style="width:${w}px;height:800px;border:0;display:block" srcdoc="${attr(renderHelpPage(p))}"></iframe>`,
    ),
  ).join('');
  const script = `addEventListener('load',function(){document.getElementById('out').textContent=JSON.stringify(
    [].map.call(document.querySelectorAll('iframe'),function(f){return [f.dataset.k,f.contentDocument.documentElement.scrollWidth,f.contentWindow.innerWidth];}));});`;
  const dir = mkdtempSync(join(tmpdir(), 'help-geometry-'));
  try {
    const file = join(dir, 'harness.html');
    writeFileSync(file, `<!doctype html><html><body style="margin:0"><pre id="out"></pre>${frames}<script>${script}</script></body></html>`);
    const dom = execFileSync(
      CHROME as string,
      ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'profile')}`,
        '--virtual-time-budget=10000', '--dump-dom', `file://${file}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const json = /<pre id="out">([^<]*)<\/pre>/.exec(dom)?.[1] ?? '';
    return JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// In CI a missing browser fails the suite; locally without Chrome it skips.
(CHROME || process.env.CI ? describe : describe.skip)('help pages fit a phone screen (browser layout)', () => {
  it('no /help route is wider than the screen at 390, 360, 300 or 277 px', () => {
    expect(CHROME).toBeDefined();
    const rows = measure();
    expect(rows).toHaveLength(PAGES.length * WIDTHS.length);
    const tooWide = rows.filter(([, docWidth, viewport]) => docWidth > viewport);
    expect(tooWide).toEqual([]);
    // The frames really are phone-sized (a broken harness would pass the check above).
    expect(rows.map(([, , viewport]) => viewport)).toEqual(PAGES.flatMap(() => WIDTHS));
  }, 90_000);
});
