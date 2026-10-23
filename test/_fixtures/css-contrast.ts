// MUTED-TEXT (owner #166-9 op 1; FX-1136 #168-13): WCAG contrast of a rule's text colour against
// the page background, both read from the page's own <style> block.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The value of `prop` in the top-level rule for `selector` (one rule per line).
export function cssValue(html: string, selector: string, prop: string): string | undefined {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\n  ${sel} \\{(?:[^}]*?;)? ${prop}: (#[0-9A-Fa-f]{6});`).exec(html)?.[1];
}

// Each selector's colour against the page paper (html, body background).
export function contrastOnPaper(html: string, selectors: string[]): Record<string, number> {
  const paper = cssValue(html, 'html, body', 'background');
  if (!paper) throw new Error('page background not found');
  const out: Record<string, number> = {};
  for (const sel of selectors) {
    const color = cssValue(html, sel, 'color');
    if (!color) throw new Error(`no color for ${sel}`);
    out[sel] = Math.round(contrastRatio(color, paper) * 100) / 100;
  }
  return out;
}
