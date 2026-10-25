import { APP_STORE_URL_DEFAULT, PAY_PAGE_COPY, doc, esc } from './pay-page.html';

// GC-2 — what /p/:token/done shows after Stripe sends the buyer back (card or
// wallet). Same document, tokens and classes as the pay page; the few extra
// rules below are this page's only additions (tick, spinner, numbered steps).
// Every value is escaped. The only script is the failed/cancelled one that
// drops that attempt's spent key from the pay page's tab storage (FR-1155 B2).

export const PAY_DONE_COPY = {
  brand: 'TGP Fitness',
  paidH: 'Payment received',
  paidLine: (amount: string, pkg: string, coach: string) => `You paid ${amount} for ${pkg} with ${coach}.`,
  stepEmail: (email: string) => `Open the email we're sending to ${email} and tap Confirm my email.`,
  stepApp: 'Download the TGP Fitness app.',
  existingNext: 'Open the TGP Fitness app and log in as usual. The package shows under Your plans.',
  confirmingH: 'Confirming your payment',
  confirming: 'This usually takes a few seconds. This page checks again by itself.',
  slowH: 'Your payment is still being confirmed',
  slow: (email: string) => `You don't need to pay again. When it goes through, we'll email ${email}.`,
  checkAgain: 'Check again',
  failedH: "Your payment didn't go through",
  failedReason: "The payment wasn't finished.",
  failedNothing: 'Nothing was charged. You can pay again on the pay page.',
  tryAgain: 'Try again',
  cancelledH: 'This payment was cancelled',
  cancelled: 'Nothing was charged. To buy this package, start again on the pay page.',
  backToPay: 'Back to the pay page',
  // FR-1155 (B1): a paid payment that was later fully refunded or disputed.
  refundedH: 'This payment was refunded',
  refunded: 'The money goes back to the card or wallet you paid with.',
  disputedH: 'This payment is disputed',
  disputed: 'Your bank is reviewing a dispute on this payment. It decides the outcome and lets you know.',
  // FR-1155R3 (agent 174), FR1155-W5 (needs owner): a dispute not known to be still under review.
  disputedOutcome: 'A dispute was opened on this payment. Your bank decides the outcome and lets you know.',
  unknown: "We couldn't find this payment. If you paid, check your email: we send the next steps there.",
  unavailable: "We couldn't check your payment just now. Reload this page in a minute to see if it went through.",
} as const;

export type PayDoneView =
  | {
      kind: 'paid';
      buyer: 'new' | 'existing';
      email: string;
      coach: string;
      packageName: string;
      amountCents: number | null;
    }
  | { kind: 'confirming'; email: string; again: boolean; checkUrl: string }
  | { kind: 'failed'; reason: string | null; payUrl: string; spent: SpentKey }
  | { kind: 'cancelled'; payUrl: string; spent: SpentKey }
  | { kind: 'refunded' }
  /** open: the dispute row of this charge shows the bank still reviewing. */
  | { kind: 'disputed'; open: boolean }
  | { kind: 'unknown' }
  | { kind: 'unavailable' };

/** The attempt whose key is spent: the pay page's tab storage entry and its key's tag. */
export interface SpentKey {
  token: string;
  tag: number;
}

/** The pay page keeps each tab's attempt as tgp-pay:<token> = {k: idempotency key, h} (pay-page.html.ts key()). */
export const PAY_KEY_PREFIX = 'tgp-pay:';

/** 32-bit tag of an idempotency key: the same arithmetic as the script below, so the key itself stays off the page. */
export function payKeyTag(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return h;
}

// B2 — Stripe's redirect skips the pay page's say(), so the spent key would
// be replayed by Try again ("This checkout link has expired"). Drop it only
// while it is still this attempt's key; a newer attempt's key stays.
function forgetSpentKey(s: SpentKey, nonce: string): string {
  const k = JSON.stringify(PAY_KEY_PREFIX + s.token).replace(/</g, '\\u003c');
  return `<script nonce="${nonce}">(function(){try{var K=${k},s=JSON.parse(sessionStorage.getItem(K)),h=0,i;if(!s||typeof s.k!=='string')return;for(i=0;i<s.k.length;i++)h=(h*31+s.k.charCodeAt(i))|0;if(h===${s.tag | 0})sessionStorage.removeItem(K)}catch(_){}})()</script>`;
}

const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const EXTRA_CSS = `.tick{display:block;width:3.5rem;height:3.5rem;margin:.5rem 0 1rem}.tick circle{fill:var(--forest);stroke:var(--gold);stroke-width:2}
.tick path{fill:none;stroke:var(--on);stroke-width:4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:40;stroke-dashoffset:0;animation:d .5s ease-out .15s both}
@keyframes d{from{stroke-dashoffset:40}}.wait{display:block;width:2.5rem;height:2.5rem;margin:.5rem 0 1rem;border:3px solid var(--line);border-top-color:var(--forest);border-radius:50%;animation:s 1s linear infinite}
.done p{margin:.5rem 0 0}.done h2{margin-top:1.5rem}.steps{margin:0;padding:0;list-style:none;counter-reset:n}
.steps li{position:relative;padding:.25rem 0 .75rem 2.25rem;counter-increment:n;overflow-wrap:anywhere}.steps li::before{content:counter(n);position:absolute;left:0;top:.125rem;width:1.5rem;height:1.5rem;border-radius:50%;border:1px solid var(--gold);color:var(--forest);display:grid;place-items:center;font:600 .8125rem/1 var(--serif)}
.done .btn{padding:.5rem 1rem;text-align:center}.steps .btn{margin:.75rem 0 0}.done .who{margin-top:1rem}.done .who strong{overflow-wrap:anywhere}a.link{display:inline-block;margin-top:1rem;min-height:2.75rem;padding:.5rem 0;color:var(--forest);text-decoration:underline;text-underline-offset:.2em}
@media (prefers-reduced-motion:reduce){.tick path,.wait{animation:none}}`;

function store(appStoreUrl: string): string {
  const href = /^https:\/\//i.test(appStoreUrl) ? appStoreUrl : APP_STORE_URL_DEFAULT;
  return `<a class="btn" href="${esc(href)}">${PAY_PAGE_COPY.appStore}</a>`;
}

const TICK =
  '<svg class="tick" viewBox="0 0 56 56" aria-hidden="true" focusable="false"><circle cx="28" cy="28" r="26"/><path d="M17 29l7 7 15-16"/></svg>';

function body(v: PayDoneView, appStoreUrl: string): string {
  switch (v.kind) {
    case 'paid': {
      const who = `<p class="who"><span>${PAY_PAGE_COPY.loginWith}</span><strong>${esc(v.email)}</strong></p>`;
      const line =
        v.amountCents !== null
          ? `<p>${esc(PAY_DONE_COPY.paidLine(usd(v.amountCents), v.packageName, v.coach))}</p>`
          : '';
      const next =
        v.buyer === 'new'
          ? `<ol class="steps"><li>${esc(PAY_DONE_COPY.stepEmail(v.email))}</li><li>${PAY_DONE_COPY.stepApp}${store(appStoreUrl)}</li><li>${esc(PAY_PAGE_COPY.setPassword)}</li></ol>`
          : `<p>${PAY_DONE_COPY.existingNext}</p>${store(appStoreUrl)}`;
      return `<section id="paid">${TICK}<h1 class="state">${PAY_DONE_COPY.paidH}</h1>${line}<h2>${PAY_PAGE_COPY.nextH}</h2>${next}${who}</section>`;
    }
    case 'confirming':
      return v.again
        ? `<section id="confirming" aria-live="polite"><span class="wait" aria-hidden="true"></span><h1 class="state">${PAY_DONE_COPY.confirmingH}</h1><p>${PAY_DONE_COPY.confirming}</p></section>`
        : `<section id="slow"><h1 class="state">${PAY_DONE_COPY.slowH}</h1><p>${esc(PAY_DONE_COPY.slow(v.email))}</p><a class="link" href="${esc(v.checkUrl)}">${PAY_DONE_COPY.checkAgain}</a></section>`;
    case 'failed':
      return `<section id="failed"><h1 class="state">${PAY_DONE_COPY.failedH}</h1><p>${esc(v.reason ?? PAY_DONE_COPY.failedReason)}</p><p>${PAY_DONE_COPY.failedNothing}</p><a class="btn" href="${esc(v.payUrl)}">${PAY_DONE_COPY.tryAgain}</a></section>`;
    case 'cancelled':
      return `<section id="cancelled"><h1 class="state">${PAY_DONE_COPY.cancelledH}</h1><p>${PAY_DONE_COPY.cancelled}</p><a class="btn" href="${esc(v.payUrl)}">${PAY_DONE_COPY.backToPay}</a></section>`;
    case 'refunded':
      return `<section id="refunded"><h1 class="state">${PAY_DONE_COPY.refundedH}</h1><p>${PAY_DONE_COPY.refunded}</p></section>`;
    case 'disputed':
      return `<section id="disputed"><h1 class="state">${PAY_DONE_COPY.disputedH}</h1><p>${v.open ? PAY_DONE_COPY.disputed : PAY_DONE_COPY.disputedOutcome}</p></section>`;
    case 'unknown':
      return `<p class="state">${esc(PAY_DONE_COPY.unknown)}</p>`;
    case 'unavailable':
      return `<p class="state">${esc(PAY_DONE_COPY.unavailable)}</p>`;
  }
}

/** The return page for one state. The confirming state reloads via the Refresh header. */
export function renderPayDonePage(v: PayDoneView, nonce: string, appStoreUrl: string): string {
  const forget = v.kind === 'failed' || v.kind === 'cancelled' ? `\n${forgetSpentKey(v.spent, nonce)}` : '';
  return doc(
    PAY_DONE_COPY.brand,
    nonce,
    `<style nonce="${nonce}">${EXTRA_CSS}</style>
<header class="band"><div class="wrap"><p class="kicker">${PAY_DONE_COPY.brand}</p></div></header>
<main class="wrap sheet done">${body(v, appStoreUrl)}</main>${forget}`,
  );
}
