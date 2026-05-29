import type { ThankYouDropRow, ThankYouViewModel } from './thank-you.service';

// PR-15A — SSR HTML renderer for the public storefront thank-you page.
// Mirrors invite-landing's style language (quiet luxury palette,
// `noindex,nofollow`, no client JS). All buyer-supplied / coach-supplied
// strings funnel through escapeHtml; no innerHTML interpolation.

export function renderThankYouPage(vm: ThankYouViewModel): string {
  const unlockedItems = vm.unlocked
    .map((d) => renderDropRow(d, /*delivered*/ true))
    .join('');
  const upcomingItems = vm.upcoming
    .map((d) => renderDropRow(d, /*delivered*/ false))
    .join('');

  const unlockedBlock = vm.unlocked.length
    ? `<section class="block"><h2>Unlocked now</h2><ul>${unlockedItems}</ul></section>`
    : '';
  const upcomingBlock = vm.upcoming.length
    ? `<section class="block"><h2>Coming up</h2><ul>${upcomingItems}</ul></section>`
    : '';

  const emptyBlock =
    !vm.unlocked.length && !vm.upcoming.length
      ? `<section class="block calm"><p>Your coach is finalising your deliverables. You'll get a push as soon as the first item unlocks.</p></section>`
      : '';

  const receiptRow = vm.amountFormatted
    ? `<p class="receipt"><span>Paid</span><strong>${escapeHtml(vm.amountFormatted)}</strong></p>`
    : '';
  const nextChargeRow =
    vm.isRecurring && vm.nextChargeAt
      ? `<p class="receipt"><span>Next charge</span><strong>${escapeHtml(
          formatDate(vm.nextChargeAt),
        )}</strong></p>`
      : vm.isRecurring
        ? `<p class="receipt"><span>Plan</span><strong>Recurring</strong></p>`
        : '';

  const body = `
<main class="card">
  <p class="kicker">Purchase confirmed</p>
  <h1>Thanks for joining ${escapeHtml(vm.packageName)}.</h1>
  <div class="summary">
    <p class="package">${escapeHtml(vm.packageName)}</p>
    ${receiptRow}
    ${nextChargeRow}
  </div>
  ${unlockedBlock}
  ${upcomingBlock}
  ${emptyBlock}
  <p class="alt">Open the Growth Project app to start your deliverables.</p>
</main>`;

  return baseDocument({
    title: `Thanks · ${vm.packageName}`,
    body,
  });
}

function renderDropRow(d: ThankYouDropRow, delivered: boolean): string {
  const title = d.display_title ?? defaultTitleForType(d.asset_type);
  const caption = (() => {
    if (d.display_caption) return d.display_caption;
    if (delivered) return 'Ready in your app.';
    return upcomingCaption(d);
  })();
  const badge = delivered
    ? `<span class="badge delivered">Delivered</span>`
    : `<span class="badge upcoming">Upcoming</span>`;
  return `<li>
    <div class="row">
      <div class="row-text">
        <p class="row-title">${escapeHtml(title)}</p>
        <p class="row-caption">${escapeHtml(caption)}</p>
      </div>
      ${badge}
    </div>
  </li>`;
}

function defaultTitleForType(assetType: string): string {
  switch (assetType) {
    case 'workout_program':
    case 'workout_plan':
      return 'Workout';
    case 'meal_plan':
      return 'Meal plan';
    case 'pdf':
      return 'Document';
    case 'video':
      return 'Video';
    case 'auto_message':
      return 'Coach message';
    default:
      return 'Deliverable';
  }
}

function upcomingCaption(d: ThankYouDropRow): string {
  if (d.cadence_kind === 'on_completion') return 'Unlocks when you complete the prior step.';
  if (d.cadence_kind === 'on_milestone') return 'Unlocks when you hit your next milestone.';
  if (d.fire_at) {
    return `Unlocks ${formatDate(d.fire_at)}`;
  }
  return 'Unlocks soon.';
}

function formatDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function escapeHtml(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseDocument(opts: { title: string; body: string }): string {
  // Palette mirrors invite-landing.service.ts (quiet-luxury direction)
  // for storefront cohesion: warm off-white background, ink-black serif
  // for headlines, soft sans for body, single accent colour reserved
  // for the primary CTA. noindex,nofollow because thank-you URLs are
  // session-scoped and not meant to be shared.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { --accent: #1F1B16; --ink: #1F1B16; --paper: #FAF7F2; --muted: #6B6259; --line: #E7E1D6; --soft: #F1ECE1; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.5; min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; }
  .card { width: 100%; max-width: 520px; background: #FFFFFF; border: 1px solid var(--line); border-radius: 18px; padding: 36px 28px; }
  .kicker { margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; color: var(--muted); }
  h1 { margin: 0 0 16px; font-family: "Playfair Display", "Iowan Old Style", Georgia, "Times New Roman", serif; font-weight: 500; font-size: 26px; line-height: 1.2; }
  h2 { margin: 24px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 600; }
  .summary { background: var(--soft); border-radius: 12px; padding: 16px 18px; margin: 12px 0 4px; }
  .summary .package { margin: 0 0 8px; font-size: 17px; font-weight: 500; }
  .receipt { margin: 4px 0; display: flex; justify-content: space-between; font-size: 14px; color: var(--muted); }
  .receipt strong { color: var(--ink); font-weight: 500; }
  .block { margin-top: 18px; }
  .block ul { list-style: none; padding: 0; margin: 0; }
  .block li { border-top: 1px solid var(--line); padding: 14px 2px; }
  .block li:first-child { border-top: 0; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .row-text { flex: 1; min-width: 0; }
  .row-title { margin: 0 0 2px; font-size: 15px; font-weight: 500; }
  .row-caption { margin: 0; font-size: 13px; color: var(--muted); }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .badge.delivered { color: #2D5A3D; border-color: #C9DFC9; background: #F0F7F0; }
  .badge.upcoming { color: var(--muted); }
  .calm p { color: var(--muted); font-size: 14px; margin: 8px 0; }
  .alt { margin-top: 24px; font-size: 13px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
${opts.body}
</body>
</html>`;
}
