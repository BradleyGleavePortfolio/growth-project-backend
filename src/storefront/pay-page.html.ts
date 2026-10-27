import type { PublicPackageData } from './storefront.types';

// GC-1 — the guest pay page at /p/:token (#GC-DOMAIN). Server-rendered; every
// coach-supplied string goes through esc(), and the browser config is JSON in
// a <script type="application/json"> with `<` escaped, so coach text can never
// close a tag or run. Amounts come only from PublicPackageData (the checkout's
// own chargeQuote); the browser never adds prices. Stripe Elements runs in
// deferred-intent mode: the PaymentIntent is minted by the existing
// POST /api/v1/packages/public/join/:token/checkout only when the buyer pays.

export const PAY_PAGE_COPY = {
  kicker: (coach: string) => `${coach} on The Growth Project`,
  from: (coach: string) => `From ${coach}`,
  included: "What's included",
  billing: 'Billing',
  nextCharge: 'Next charge',
  dueToday: 'Due today',
  orCard: 'Or pay with card',
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  footnote:
    'Card details go straight to Stripe, the payment provider. The Growth Project never sees your full card number.',
  notOffered:
    'This plan is no longer offered. Message the coach who shared this link for the current one.',
  notReady: "This coach can't take payments yet. Nothing was charged.",
  failed:
    'The payment did not start, so nothing was charged. Check your connection, then pay again.',
  needName: 'Add your name, then pay again.',
  // GUEST-ELIGIBILITY (owner #169-8, #170-2): the code step for an existing
  // TGP email, "Hey {N}, Welcome Back!" and its summary, and the new buyer's
  // confirm-and-download state. Wording: PR table GE-W*.
  next: 'Continue',
  codeTo: 'This email has a TGP Fitness account, so we emailed a 6-digit code to',
  code: 'Code',
  resend: 'Send a new code',
  otherEmail: 'Use a different email',
  hey: 'Hey {N}, Welcome Back!',
  back: 'Welcome Back!',
  appChangeH: 'How your app will change',
  appChange: (coach: string) =>
    `After you pay, ${coach} becomes your coach in the TGP Fitness app. Their plan, check-ins and messages show up there, and your log and history stay as they are.`,
  oneCoachH: 'One coach at a time',
  oneCoach: (coach: string) =>
    `A TGP Fitness account has one coach at a time, and yours is ${coach}. This package is added to what you already have with them.`,
  nextH: 'What happens next',
  nextSteps: 'After you pay, open the TGP Fitness app and log in as usual. The package shows under Your plans.',
  checkFailed: "We couldn't check that email. Check your connection, then try again.",
  badCode: 'Enter the 6-digit code from the email.',
  resent: 'We sent a new code. Use the newest email.',
  confirmedH: 'Your email is confirmed',
  confirmed: 'Your TGP Fitness account is set up. Download the app, then log in to start with your coach.',
  appStore: 'Download on the App Store',
  loginWith: 'Log in with',
  loginEmailUnknown: 'the email you paid with',
  setPassword:
    "You haven't set a password yet. On the app's login screen, tap Forgot password? and we'll email you a link to set one.",
  expiredH: 'This link has run out',
  expired:
    "Your account is still there. Download the TGP Fitness app, tap Forgot password? on the login screen and enter the email you paid with. We'll email you a new link.",
  // WEB-BUYER-FLOW (owner #172-7 op 1): the confirm page asks for the
  // password. Wording: PR table WBF-W*.
  pwIntro: "Set a password to finish your account. You'll use it with this email to log in to the app.",
  pwLabel: 'Password',
  pwHint: 'At least 8 characters, one uppercase letter, one number and one special character.',
  pwRule: 'Password must be at least 8 characters with one uppercase letter, one number, and one special character.',
  pwSave: 'Set password',
  pwSavedH: 'Your password is set',
  pwFailed: "We couldn't save your password. Check your connection, then try again.",
  pwTooMany: 'Too many tries. Wait a few minutes, then try again.',
} as const;

export const APP_STORE_URL_DEFAULT = 'https://apps.apple.com/app/id6765847915';

export interface PayPageContext {
  token: string;
  lp: string | null;
  onBehalfOf: string;
  nonce: string;
  /** GC-2 — Stripe's return_url, from payDoneUrl (storefront-links.ts). */
  returnUrl: string;
}

const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const cadence = (i: string, n: number) => (n > 1 ? `every ${n} ${i}s` : `a ${i}`);
const period = (i: string, n: number) => (n > 1 ? `${n} ${i}s` : i);
const longDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The words the page shows for this package: the app's planTerms wording, from server amounts only. */
export function payPageTerms(p: PublicPackageData) {
  const due = usd(p.due_today_cents);
  const r = p.recurring;
  if (!r) return { price: `${due} once`, cta: `Pay ${due}`, billing: null };
  const each = `${usd(r.amount_cents)} ${cadence(r.interval, r.interval_count)}`;
  const first = period(r.interval, r.interval_count);
  return {
    price: r.one_time_cents > 0 ? `${each}, plus ${usd(r.one_time_cents)} once` : each,
    cta: r.one_time_cents > 0 ? `Subscribe, pay ${due} today` : `Subscribe for ${each}`,
    billing: {
      each,
      next: longDate(r.next_charge_at),
      today:
        r.one_time_cents > 0
          ? `You pay ${due} today: ${usd(r.one_time_cents)} once plus your first ${first} at ${usd(r.amount_cents)}.`
          : `You pay ${due} today for your first ${first}.`,
      renewal: `Renews automatically at ${each} until you cancel. Cancel anytime in the TGP Fitness app, under Your plans; you keep the plan until the end of the period you paid for.`,
    },
  };
}

export function renderPayPage(p: PublicPackageData, ctx: PayPageContext): string {
  const t = payPageTerms(p);
  const coach = p.coach.display_name;
  // The coach's description, one bullet per line (the board's list).
  const included = (p.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const avatar =
    p.coach.avatar_url && /^https:\/\//i.test(p.coach.avatar_url)
      ? `<img class="av" src="${esc(p.coach.avatar_url)}" alt="" width="48" height="48">`
      : `<span class="av" aria-hidden="true">${esc(coach.charAt(0).toUpperCase())}</span>`;
  const incList = `<h2>${PAY_PAGE_COPY.included}</h2><ul class="inc">${included.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  const c = esc(coach);
  const billing = t.billing
    ? `<section><h2>${PAY_PAGE_COPY.billing}</h2>
<p class="row"><span>${PAY_PAGE_COPY.billing}</span><strong>${t.billing.each}</strong></p>
<p class="row"><span>${PAY_PAGE_COPY.nextCharge}</span><strong>${t.billing.next}</strong></p>
<p class="note">${t.billing.today}</p><p class="terms">${t.billing.renewal}</p></section>`
    : '';
  const cfg = JSON.stringify({
    pk: p.stripe_publishable_key,
    token: ctx.token,
    lp: ctx.lp,
    obo: ctx.onBehalfOf,
    mode: p.recurring ? 'subscription' : 'payment',
    amount: p.due_today_cents,
    ret: ctx.returnUrl,
    copy: {
      failed: PAY_PAGE_COPY.failed,
      needName: PAY_PAGE_COPY.needName,
      checkFailed: PAY_PAGE_COPY.checkFailed,
      badCode: PAY_PAGE_COPY.badCode,
      resent: PAY_PAGE_COPY.resent,
      hey: PAY_PAGE_COPY.hey,
      back: PAY_PAGE_COPY.back,
    },
  }).replace(/</g, '\\u003c');
  return doc(
    p.package_name,
    ctx.nonce,
    `<header class="band"><div class="wrap">${avatar}<div>
<p class="kicker">${esc(PAY_PAGE_COPY.kicker(coach))}</p><h1>${esc(p.package_name)}</h1><p class="price">${t.price}</p></div></div></header>
<main class="wrap sheet">
${p.coach.bio?.trim() ? `<figure class="quote"><blockquote>${esc(p.coach.bio.trim())}</blockquote><figcaption>${esc(PAY_PAGE_COPY.from(coach))}</figcaption></figure>` : ''}
${included.length ? `<section id="inc0">${incList}</section>` : ''}
${billing}
<p class="due"><span>${PAY_PAGE_COPY.dueToday}</span><strong>${usd(p.due_today_cents)}</strong></p>
<form id="f1" class="card">
<label for="e1">${PAY_PAGE_COPY.email}</label><input id="e1" type="email" autocomplete="email" required maxlength="254" autocapitalize="off" spellcheck="false">
<p id="m1" class="msg" role="alert"></p><button id="b1" type="submit">${PAY_PAGE_COPY.next}</button>
</form>
<form id="f2" class="card" hidden novalidate>
<p class="lead">${PAY_PAGE_COPY.codeTo} <strong id="to"></strong>.</p>
<label for="cd">${PAY_PAGE_COPY.code}</label><input id="cd" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<p id="m2" class="msg" role="alert"></p><button id="b2" type="submit">${PAY_PAGE_COPY.next}</button>
<p class="links"><button id="rs" type="button" class="link">${PAY_PAGE_COPY.resend}</button><button id="ch" type="button" class="link">${PAY_PAGE_COPY.otherEmail}</button></p>
</form>
<section id="s3" class="back" hidden aria-live="polite"><p id="hey" class="hey" tabindex="-1"></p>
<div id="sum" class="sum" tabindex="-1" hidden>${included.length ? incList : ''}
<div data-k="no_coach"><h2>${PAY_PAGE_COPY.appChangeH}</h2><p>${PAY_PAGE_COPY.appChange(c)}</p></div>
<div data-k="same_coach"><h2>${PAY_PAGE_COPY.oneCoachH}</h2><p>${PAY_PAGE_COPY.oneCoach(c)}</p><h2>${PAY_PAGE_COPY.nextH}</h2><p>${PAY_PAGE_COPY.nextSteps}</p></div>
</div></section>
<form id="pay" class="card" hidden>
<p class="who"><span>${PAY_PAGE_COPY.email}</span><strong id="pe"></strong></p><p class="links"><button id="ce" type="button" class="link">${PAY_PAGE_COPY.otherEmail}</button></p>
<div id="express"></div><p class="or" id="or" hidden>${PAY_PAGE_COPY.orCard}</p>
<label for="nm">${PAY_PAGE_COPY.name}</label><input id="nm" autocomplete="name" required minlength="2" maxlength="120">
<label for="ph">${PAY_PAGE_COPY.phone}</label><input id="ph" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32">
<div id="card"></div><p id="msg" class="msg" role="alert"></p>
<button id="go" type="submit">${t.cta}</button>
</form>
<p class="foot">${PAY_PAGE_COPY.footnote}</p>
</main>
<script type="application/json" id="cfg">${cfg}</script>
<script nonce="${ctx.nonce}" src="https://js.stripe.com/acacia/stripe.js"></script>
<script nonce="${ctx.nonce}">${CLIENT_JS}</script>`,
  );
}

/** A calm closed state (404): no package, coach or buyer data. */
export function renderPayPageState(message: string, nonce: string): string {
  return doc(
    'The Growth Project',
    nonce,
    `<header class="band"><div class="wrap"><p class="kicker">The Growth Project</p></div></header>
<main class="wrap sheet"><p class="state">${esc(message)}</p></main>`,
  );
}

/** GUEST-ELIGIBILITY — where a new buyer's confirm link lands (/p/:token?confirmed=1): app download + login email. */
// The confirm page (/p/:token?confirmed=1, where the confirm link lands).
// WEB-BUYER-FLOW (owner #172-7 op 1): it asks for the password first (#pw),
// then shows download + log in (#ok). #nolink: the link's session is not in
// this tab any more (opened again later): the app's Forgot password? path.
// #gone: Supabase said the link ran out, or the route refused it (used,
// expired) — "Forgot password?" in the app, as before.
export function renderConfirmedPage(nonce: string, appStoreUrl: string): string {
  const store = `<a class="btn" href="${esc(/^https:\/\//i.test(appStoreUrl) ? appStoreUrl : APP_STORE_URL_DEFAULT)}">${PAY_PAGE_COPY.appStore}</a>`;
  const who = (id: string) =>
    `<p class="who"><span>${PAY_PAGE_COPY.loginWith}</span><strong id="${id}">${PAY_PAGE_COPY.loginEmailUnknown}</strong></p>`;
  const copy = JSON.stringify({
    rule: PAY_PAGE_COPY.pwRule,
    failed: PAY_PAGE_COPY.pwFailed,
    tooMany: PAY_PAGE_COPY.pwTooMany,
  }).replace(/</g, '\\u003c');
  return doc(
    'TGP Fitness',
    nonce,
    `<header class="band"><div class="wrap"><p class="kicker">TGP Fitness</p></div></header>
<main class="wrap sheet"><section id="pw"><h1 class="state">${PAY_PAGE_COPY.confirmedH}</h1><p>${esc(PAY_PAGE_COPY.pwIntro)}</p>
<form id="pf" class="card"><input id="un" type="email" autocomplete="username" hidden readonly>${who('le')}
<label for="pwd">${PAY_PAGE_COPY.pwLabel}</label><input id="pwd" type="password" autocomplete="new-password" required minlength="8" maxlength="72" aria-describedby="pwh">
<p id="pwh" class="terms">${PAY_PAGE_COPY.pwHint}</p><p id="pm" class="msg" role="alert"></p><button id="pb" type="submit">${PAY_PAGE_COPY.pwSave}</button></form></section>
<section id="ok" class="done" hidden><h1 id="okh" class="state" tabindex="-1">${PAY_PAGE_COPY.pwSavedH}</h1><p>${PAY_PAGE_COPY.confirmed}</p>${store}
${who('le2')}</section>
<section id="nolink" hidden><h1 class="state">${PAY_PAGE_COPY.confirmedH}</h1><p>${PAY_PAGE_COPY.confirmed}</p>${store}
${who('le3')}<p class="terms">${esc(PAY_PAGE_COPY.setPassword)}</p></section>
<section id="gone" hidden><h1 class="state">${PAY_PAGE_COPY.expiredH}</h1><p>${esc(PAY_PAGE_COPY.expired)}</p>${store}</section></main>
<script type="application/json" id="cf">${copy}</script>
<script nonce="${nonce}">${CONFIRMED_JS}</script>`,
  );
}

export function doc(title: string, nonce: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#2C4A36"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head>
<body>${body}</body></html>`;
}

// Style C tokens from the app (theme/tokens.ts): bone, surface, ink, muted,
// forest, textOnAccent, textOnMastheadMuted, border, gold.300 (error goes to Stripe's colorDanger only).
// muted is #2C2C2C, the one small-grey-text colour on light grounds (owner #168-13).
const CSS = `:root{--bone:#F5EFE4;--surface:#FFFDF8;--ink:#1A1A18;--muted:#2C2C2C;--forest:#2C4A36;--on:#FBF7F0;--on2:#B8CCBF;--line:#DCD5CC;--gold:#D4B96B;--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
*{box-sizing:border-box}body{margin:0;background:var(--bone);color:var(--ink);font:1rem/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:30rem;margin:0 auto;padding:0 1.25rem}.band{background:var(--forest);color:var(--on);padding:1.5rem 0 2.75rem}
.band::after{content:"";display:block;width:calc(100% - 2.5rem);max-width:27.5rem;margin:1.25rem auto 0;border-top:1px solid var(--gold);opacity:.6}
.band .wrap{display:flex;gap:.875rem;align-items:center}.band .wrap>div{min-width:0}
.av{flex:none;width:3rem;height:3rem;border-radius:50%;border:1px solid var(--gold);background:var(--surface);color:var(--forest);display:grid;place-items:center;font:italic 1.375rem var(--serif);object-fit:cover}
.kicker,h2{margin:0;font-size:.6875rem;letter-spacing:.14em;text-transform:uppercase}.kicker{color:var(--on2)}
h1{margin:.125rem 0 0;font:500 1.625rem/1.2 var(--serif);overflow-wrap:anywhere}.price{margin:.125rem 0 0;font-size:.875rem;color:var(--on2)}
.sheet{background:var(--bone);border-radius:1.5rem 1.5rem 0 0;margin-top:-1.5rem;padding-top:1.5rem;padding-bottom:2.5rem}
.quote{margin:0 0 1.5rem}blockquote{margin:0;font:italic 1.0625rem/1.5 var(--serif);white-space:pre-line;overflow-wrap:anywhere}
figcaption{margin-top:.25rem;font-size:.8125rem;color:var(--muted)}section{margin:0 0 1.5rem}h2{font-weight:600;margin-bottom:.5rem}
.inc{margin:0;padding:0;list-style:none}.inc li{position:relative;padding:.1875rem 0 .1875rem 1.125rem;overflow-wrap:anywhere}
.inc li::before{content:"";position:absolute;left:.125rem;top:.75em;width:.375rem;height:.375rem;border-radius:50%;background:var(--gold)}
.row{display:flex;justify-content:space-between;gap:1rem;margin:0;padding:.625rem 0;border-bottom:1px dashed var(--line)}.row span{flex:none;color:var(--muted)}.row strong{text-align:right}
.note{margin:.75rem 0 0}.terms{margin:.5rem 0 0;font-size:.8125rem;color:var(--muted)}
.due{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 1rem;padding:1rem 0;border-top:1px solid var(--line)}.due strong{font:500 1.375rem var(--serif)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.25rem;display:flex;flex-direction:column;gap:.5rem}
.or{display:flex;align-items:center;gap:.75rem;margin:.5rem 0;color:var(--muted);font-size:.875rem}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
label{font-size:.875rem;margin-top:.5rem}input{font:inherit;min-height:3rem;padding:.75rem;border:1px solid var(--line);border-radius:.75rem;background:#fff;color:var(--ink)}
input:focus,button:focus-visible{outline:2px solid var(--forest);outline-offset:2px}#card{margin-top:.5rem}
.msg{margin:.5rem 0 0}.msg:empty{display:none}
button{margin-top:1rem;font:inherit;font-weight:600;line-height:1.25;min-height:3.25rem;padding:.75rem 1rem;border:0;border-radius:.75rem;background:var(--forest);color:var(--on);cursor:pointer}
button:disabled{background:#E0D9CE;color:#524E47;cursor:progress}
button[aria-busy=true]::after{content:"";display:inline-block;width:1em;height:1em;margin-left:.5em;vertical-align:-.15em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){button[aria-busy=true]::after{animation:none}}
.foot{margin:1rem .25rem 0;font-size:.8125rem;color:var(--muted);text-align:center}
.back{margin-top:1rem}.lead{margin:0;overflow-wrap:anywhere}.code{font-size:1.25rem;letter-spacing:.3em}
.links{display:flex;flex-wrap:wrap;gap:0 1.5rem;margin:0}button.link{margin:0;min-height:2.75rem;padding:.5rem 0;background:none;color:var(--forest);text-decoration:underline;text-underline-offset:.2em}
.hey{margin:1.5rem 0;font:500 1.625rem/1.25 var(--serif);text-align:center;outline:0;transition:opacity .6s}.hey.out{opacity:0}.sum{outline:0}.sum>div{margin:0 0 1.25rem}.sum p{margin:0}.sum h2{margin-top:1.25rem}
.who{margin:0}.who span,.who strong{display:block}.who span{font-size:.875rem;color:var(--muted)}
.who strong{min-width:0;overflow-wrap:anywhere}.btn{display:flex;align-items:center;justify-content:center;min-height:3.25rem;margin:1.25rem 0;border-radius:.75rem;background:var(--forest);color:var(--on);font-weight:600;text-decoration:none}
@media (prefers-reduced-motion:reduce){.hey{transition:none}}.state{margin:0;font:500 1.375rem/1.35 var(--serif)}.done{animation:rise .3s ease-out}@keyframes rise{from{opacity:0;transform:translateY(.375rem)}}
@media (prefers-reduced-motion:reduce){.done{animation:none}}[hidden]{display:none!important}`;

// Static browser script: reads only #cfg, never interpolated. Email first
// (owner #172-8): step 1 asks only for the email and POST check-email
// decides. A new email goes straight to the payment form, with no welcome
// and no code (#170-2); account set-up comes after payment. An email with a
// TGP account was just sent a code by that same call: the code step (POST
// verify-code), then "Hey {N}, Welcome Back!" fades to its summary (#169-8),
// then the payment form. A refusal (another coach: #SWITCH-V1; a coach
// account) shows on the code step and the payment form stays closed. The
// payment form shows the email fixed; "Use a different email" (there or on
// the code step) goes back to step 1, so a changed email is always checked
// again. Stripe Elements mount when the payment form first opens. Same flow
// for the wallet buttons (their billing contact carries the buyer's name and
// phone; the email is the fixed one) and the card form: elements.submit(),
// POST checkout (idempotency key kept per tab and email), then
// stripe.confirmPayment. If checkout still answers 403 BUYER_CODE_REQUIRED
// (the proof ran out, or the account appeared since step 1) the page sends a
// code and shows the code step. Every failed attempt goes through say(),
// which drops the key: the server treats a failed attempt's key as spent,
// and nothing was charged on it.
const CLIENT_JS = `(function(){
var c=JSON.parse(document.getElementById('cfg').textContent),$=function(i){return document.getElementById(i)};
var f=$('pay'),b=$('go'),m=$('msg'),nm=$('nm'),ph=$('ph'),f1=$('f1'),e1=$('e1'),b1=$('b1'),m1=$('m1'),K='tgp-pay:'+c.token,E='',T=null,el=null,stripe=null;
var S={f2:$('f2'),b2:$('b2'),m2:$('m2'),cd:$('cd'),rs:$('rs'),s3:$('s3'),hey:$('hey'),sum:$('sum'),inc:$('inc0')};
var api='/api/v1/packages/public/join/'+encodeURIComponent(c.token)+'/checkout';
function wait(n,v){n.disabled=v;n.setAttribute('aria-busy',String(v))}
function busy(v){wait(b,v)}
function txt(d,t){return d&&d.message?[].concat(d.message).join(' '):t}
function say(t){m.textContent=t||c.copy.failed;busy(false);try{sessionStorage.removeItem(K)}catch(_){}}
addEventListener('pageshow',function(e){if(e.persisted){busy(false);wait(b1,false)}});
if(!window.Stripe){b1.disabled=true;m1.textContent=c.copy.failed;return}
async function post(p,body){var r=null,d=null;
try{r=await fetch(api+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});d=await r.json()}catch(_){}
return{ok:!!(r&&r.ok),d:d||{}}}
function view(a,k,w,p){f1.hidden=!a;S.f2.hidden=!k;S.s3.hidden=!w;f.hidden=!p}
function mount(){if(el)return;stripe=Stripe(c.pk);
el=stripe.elements({mode:c.mode,amount:c.amount,currency:'usd',onBehalfOf:c.obo,paymentMethodTypes:['card'],
appearance:{theme:'stripe',variables:{colorPrimary:'#2C4A36',colorText:'#1A1A18',colorTextSecondary:'#2C2C2C',colorDanger:'#B91C1C',colorBackground:'#ffffff',borderRadius:'12px',fontSizeBase:'16px'},rules:{'.Input':{border:'1px solid #DCD5CC',boxShadow:'none'}}}});
var pe=el.create('payment',{fields:{billingDetails:{name:'never',email:'never'}},wallets:{applePay:'never',googlePay:'never',link:'never'}});
pe.on('loaderror',function(){b.disabled=true;m.textContent=c.copy.failed});pe.mount('#card');
var x=el.create('expressCheckout',{emailRequired:false,phoneNumberRequired:true,billingAddressRequired:true,buttonHeight:48,paymentMethods:{link:'never',paypal:'never',amazonPay:'never'}});
x.on('ready',function(e){if(e.availablePaymentMethods)$('or').hidden=false;else $('express').hidden=true});
x.on('loaderror',function(){$('express').hidden=true});
x.on('confirm',async function(e){var bd=e.billingDetails||{},name=(bd.name||nm.value).trim(),phone=(bd.phone||ph.value).trim();
if(name.length<2){e.paymentFailed({reason:'fail'});say(c.copy.needName);nm.focus();return}
var s=await el.submit();if(s.error){e.paymentFailed({reason:'fail'});say(s.error.message);return}
if(!(await pay(name,phone)))e.paymentFailed({reason:'fail'})});
x.mount('#express')}
function open(){mount();$('pe').textContent=E;m.textContent=''}
function payStep(){open();if(S.inc)S.inc.hidden=false;view(0,0,0,1);nm.focus()}
function codeStep(){$('to').textContent=E;S.cd.value='';S.cd.disabled=false;S.m2.textContent='';S.b2.hidden=false;S.rs.hidden=false;
S.sum.hidden=true;S.hey.hidden=false;S.hey.className='hey';if(S.inc)S.inc.hidden=false;view(0,1,0,0);S.cd.focus()}
f1.addEventListener('submit',async function(ev){ev.preventDefault();var e=e1.value.trim();if(!e){e1.focus();return}
m1.textContent='';wait(b1,true);var r=await post('/check-email',{guest_email:e});wait(b1,false);
if(!r.ok||(r.d.account!=='new'&&r.d.account!=='existing')){m1.textContent=txt(r.d,c.copy.checkFailed);return}
E=e;T=null;if(r.d.account==='existing')codeStep();else payStep()});
async function code(){var r=await post('/check-email',{guest_email:E});
if(!r.ok||r.d.account!=='existing'){say(txt(r.d,c.copy.checkFailed));return}codeStep()}
async function verify(ev){ev.preventDefault();var k=S.cd.value.replace(/\\s/g,'');
if(!/^[0-9]{6}$/.test(k)){S.m2.textContent=c.copy.badCode;S.cd.focus();return}
wait(S.b2,true);var r=await post('/verify-code',{guest_email:E,code:k});wait(S.b2,false);
if(!r.ok||!r.d.buyer_token){S.m2.textContent=txt(r.d,c.copy.checkFailed);
if(r.d.error==='BUYER_HAS_COACH'||r.d.error==='BUYER_NOT_CLIENT'){S.b2.hidden=true;S.rs.hidden=true;S.cd.disabled=true}return}
T=r.d.buyer_token;welcome(r.d.first_name,r.d.summary)}
async function resend(){S.m2.textContent='';var r=await post('/check-email',{guest_email:E});S.m2.textContent=r.ok?c.copy.resent:txt(r.d,c.copy.checkFailed)}
function again(){E='';T=null;m1.textContent='';S.sum.hidden=true;if(S.inc)S.inc.hidden=false;view(1,0,0,0);e1.focus();if(e1.select)e1.select()}
S.f2.addEventListener('submit',verify);S.rs.addEventListener('click',resend);$('ch').addEventListener('click',again);$('ce').addEventListener('click',again);
var still=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
function welcome(n,k){S.hey.textContent=n?c.copy.hey.split('{N}').join(n):c.copy.back;view(0,0,1,0);S.hey.focus();
setTimeout(function(){S.hey.className='hey out';setTimeout(function(){S.hey.hidden=true;
var ns=S.sum.querySelectorAll('[data-k]'),i;for(i=0;i<ns.length;i++)ns[i].hidden=ns[i].getAttribute('data-k')!==k;
if(S.inc)S.inc.hidden=true;S.sum.hidden=false;open();view(0,0,1,1);S.sum.focus()},still?0:600)},still?1200:1600)}
function key(e){var h=0,s=null,i;for(i=0;i<e.length;i++)h=(h*31+e.charCodeAt(i))|0;
try{s=JSON.parse(sessionStorage.getItem(K))}catch(_){}
if(!s||s.h!==h){s={k:crypto.randomUUID(),h:h};try{sessionStorage.setItem(K,JSON.stringify(s))}catch(_){}}return s.k}
async function pay(name,phone){busy(true);m.textContent='';var email=E;
var r=await post(c.lp?'?lp='+encodeURIComponent(c.lp):'',{guest_name:name,guest_phone:phone,guest_email:email,idempotency_key:key(email),buyer_token:T||undefined}),d=r.d;
if(!r.ok||!d.client_secret){say(r.ok?c.copy.failed:txt(d,c.copy.failed));if(d.error==='BUYER_CODE_REQUIRED'){m.textContent='';await code()}return false}
var res=await stripe.confirmPayment({elements:el,clientSecret:d.client_secret,confirmParams:{return_url:c.ret,payment_method_data:{billing_details:{name:name,phone:phone,email:email}}}});
if(res.error){say(res.error.message);return false}return true}
f.addEventListener('submit',async function(ev){ev.preventDefault();if(!E)return;busy(true);
var s=await el.submit();if(s.error){say(s.error.message);return}await pay(nm.value.trim(),ph.value.trim())});
})();`;

// The confirm page's script. Supabase adds #access_token=… (or #error=…)
// after the confirm link. The token is kept in this tab only (sessionStorage,
// so a reload still works) and dropped from the address bar at once; the
// login email comes from its payload. The password goes to POST
// …/checkout/set-password (same origin: connect-src 'self'), which takes
// the token once. 401 there means the link is used or ran out (#gone).
const CONFIRMED_JS = `(function(){
var $=function(i){return document.getElementById(i)},h=new URLSearchParams(location.hash.slice(1)),K='tgp-cf:'+location.pathname,t='',e='',s=null,c={};
try{c=JSON.parse($('cf').textContent)}catch(_){}
function show(id){var a=['pw','ok','nolink','gone'],i;for(i=0;i<a.length;i++)$(a[i]).hidden=a[i]!==id}
function forget(){try{sessionStorage.removeItem(K)}catch(_){}}
function mail(tk){try{var p=JSON.parse(decodeURIComponent(escape(atob(tk.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')))));return typeof p.email==='string'?p.email:''}catch(_){return ''}}
try{s=JSON.parse(sessionStorage.getItem(K))}catch(_){}
if(h.get('error')||h.get('error_code')){forget();show('gone')}
else{t=h.get('access_token')||'';
if(t){try{sessionStorage.setItem(K,JSON.stringify({t:t}))}catch(_){}}else if(s&&typeof s.t==='string')t=s.t;
if(t){e=mail(t);show('pw')}else if(s&&s.saved){e=typeof s.e==='string'?s.e:'';show('ok')}else show('nolink')}
if(e){$('le').textContent=e;$('le2').textContent=e;$('un').value=e}
if(location.hash&&history.replaceState)history.replaceState(null,'',location.pathname+location.search);
var f=$('pf'),pw=$('pwd'),pb=$('pb'),pm=$('pm'),tok=location.pathname.split('/')[2]||'';
var api='/api/v1/packages/public/join/'+tok+'/checkout/set-password';
function rule(v){return v.length>=8&&v.length<=72&&/[A-Z]/.test(v)&&/[0-9]/.test(v)&&/[^A-Za-z0-9]/.test(v)}
f.addEventListener('submit',async function(ev){ev.preventDefault();var v=pw.value,r=null,d={};pm.textContent='';
if(!rule(v)){pm.textContent=c.rule;pw.focus();return}
pb.disabled=true;pb.setAttribute('aria-busy','true');
try{r=await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:t,password:v})});d=await r.json()}catch(_){}
pb.disabled=false;pb.setAttribute('aria-busy','false');
if(r&&r.ok&&d&&d.saved){pw.value='';t='';try{sessionStorage.setItem(K,JSON.stringify({saved:1,e:e}))}catch(_){}show('ok');$('okh').focus();return}
if(r&&r.status===401){forget();show('gone');return}
pm.textContent=r&&r.status===400?c.rule:r&&r.status===429?c.tooMany:c.failed;pw.focus()});
})();`;
