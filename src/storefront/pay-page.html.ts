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
} as const;

export const APP_STORE_URL_DEFAULT = 'https://apps.apple.com/app/id6765847915';

export interface PayPageContext {
  token: string;
  lp: string | null;
  onBehalfOf: string;
  nonce: string;
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
<form id="pay" class="card">
<div id="express"></div><p class="or" id="or" hidden>${PAY_PAGE_COPY.orCard}</p>
<label for="nm">${PAY_PAGE_COPY.name}</label><input id="nm" autocomplete="name" required minlength="2" maxlength="120">
<label for="ph">${PAY_PAGE_COPY.phone}</label><input id="ph" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32">
<label for="em">${PAY_PAGE_COPY.email}</label><input id="em" type="email" autocomplete="email" required maxlength="254" autocapitalize="off" spellcheck="false">
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
export function renderConfirmedPage(nonce: string, appStoreUrl: string): string {
  const store = `<a class="btn" href="${esc(/^https:\/\//i.test(appStoreUrl) ? appStoreUrl : APP_STORE_URL_DEFAULT)}">${PAY_PAGE_COPY.appStore}</a>`;
  return doc(
    'TGP Fitness',
    nonce,
    `<header class="band"><div class="wrap"><p class="kicker">TGP Fitness</p></div></header>
<main class="wrap sheet"><section id="ok"><h1 class="state">${PAY_PAGE_COPY.confirmedH}</h1><p>${PAY_PAGE_COPY.confirmed}</p>${store}
<p class="who"><span>${PAY_PAGE_COPY.loginWith}</span><strong id="le">${PAY_PAGE_COPY.loginEmailUnknown}</strong></p><p class="terms">${esc(PAY_PAGE_COPY.setPassword)}</p></section>
<section id="gone" hidden><h1 class="state">${PAY_PAGE_COPY.expiredH}</h1><p>${esc(PAY_PAGE_COPY.expired)}</p>${store}</section></main>
<script nonce="${nonce}">${CONFIRMED_JS}</script>`,
  );
}

function doc(title: string, nonce: string, body: string): string {
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
#le{min-width:0;overflow-wrap:anywhere}.btn{display:flex;align-items:center;justify-content:center;min-height:3.25rem;margin:1.25rem 0;border-radius:.75rem;background:var(--forest);color:var(--on);font-weight:600;text-decoration:none}
@media (prefers-reduced-motion:reduce){.hey{transition:none}}.state{margin:0;font:500 1.375rem/1.35 var(--serif)}[hidden]{display:none!important}`;

// Static browser script: reads only #cfg, never interpolated. One payment
// form (name, phone, email, card or wallet: GC-PHONE). Same flow for the
// wallet buttons (their billing contact carries the buyer's name, phone and
// email) and the card form: elements.submit(), POST checkout (idempotency key
// kept per tab and email), then stripe.confirmPayment. A new email pays at
// once, with no check (owner #170-2). An email with a TGP account gets 403
// BUYER_CODE_REQUIRED before any PaymentIntent exists; the page then sends the
// code (POST check-email) and shows the code step (POST verify-code), then
// "Hey {N}, Welcome Back!" fades to its summary (#169-8) over the same payment
// form, and the next tap carries the proof (buyer_token). A refusal (another
// coach: #SWITCH-V1; a coach account) shows on the code step and the payment
// form stays closed. Every failed attempt goes through say(), which drops the
// key: the server treats a failed attempt's key as spent, and nothing was
// charged on it. The code-step nodes are read only when that step opens.
const CLIENT_JS = `(function(){
var c=JSON.parse(document.getElementById('cfg').textContent),$=function(i){return document.getElementById(i)};
var f=$('pay'),b=$('go'),m=$('msg'),nm=$('nm'),ph=$('ph'),em=$('em'),K='tgp-pay:'+c.token,E='',T=null,S=null;
var api='/api/v1/packages/public/join/'+encodeURIComponent(c.token)+'/checkout';
function wait(n,v){n.disabled=v;n.setAttribute('aria-busy',String(v))}
function busy(v){wait(b,v)}
function txt(d,t){return d&&d.message?[].concat(d.message).join(' '):t}
function say(t){m.textContent=t||c.copy.failed;busy(false);try{sessionStorage.removeItem(K)}catch(_){}}
addEventListener('pageshow',function(e){if(e.persisted)busy(false)});
if(!window.Stripe){b.disabled=true;m.textContent=c.copy.failed;return}
var stripe=Stripe(c.pk);
var el=stripe.elements({mode:c.mode,amount:c.amount,currency:'usd',onBehalfOf:c.obo,paymentMethodTypes:['card'],
appearance:{theme:'stripe',variables:{colorPrimary:'#2C4A36',colorText:'#1A1A18',colorTextSecondary:'#2C2C2C',colorDanger:'#B91C1C',colorBackground:'#ffffff',borderRadius:'12px',fontSizeBase:'16px'},rules:{'.Input':{border:'1px solid #DCD5CC',boxShadow:'none'}}}});
var pe=el.create('payment',{fields:{billingDetails:{name:'never',email:'never'}},wallets:{applePay:'never',googlePay:'never',link:'never'}});
pe.on('loaderror',function(){b.disabled=true;m.textContent=c.copy.failed});pe.mount('#card');
var x=el.create('expressCheckout',{emailRequired:true,phoneNumberRequired:true,billingAddressRequired:true,buttonHeight:48,paymentMethods:{link:'never',paypal:'never',amazonPay:'never'}});
x.on('ready',function(e){if(e.availablePaymentMethods)$('or').hidden=false;else $('express').hidden=true});
x.on('loaderror',function(){$('express').hidden=true});
x.mount('#express');
async function post(p,body){var r=null,d=null;
try{r=await fetch(api+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});d=await r.json()}catch(_){}
return{ok:!!(r&&r.ok),d:d||{}}}
function step(){if(S)return S;S={f2:$('f2'),b2:$('b2'),m2:$('m2'),cd:$('cd'),rs:$('rs'),s3:$('s3'),hey:$('hey'),sum:$('sum'),inc:$('inc0')};
S.f2.addEventListener('submit',verify);S.rs.addEventListener('click',resend);$('ch').addEventListener('click',again);return S}
function view(k,w,p){var s=step();s.f2.hidden=!k;s.s3.hidden=!w;f.hidden=!p}
async function code(e){var r=await post('/check-email',{guest_email:e});
if(!r.ok||r.d.account!=='existing'){say(txt(r.d,c.copy.checkFailed));return}
var s=step();E=e;T=null;$('to').textContent=e;s.cd.value='';s.cd.disabled=false;s.m2.textContent='';s.b2.hidden=false;s.rs.hidden=false;
s.sum.hidden=true;s.hey.hidden=false;s.hey.className='hey';if(s.inc)s.inc.hidden=false;view(1,0,0);s.cd.focus()}
async function verify(ev){ev.preventDefault();var s=step(),k=s.cd.value.replace(/\\s/g,'');
if(!/^[0-9]{6}$/.test(k)){s.m2.textContent=c.copy.badCode;s.cd.focus();return}
wait(s.b2,true);var r=await post('/verify-code',{guest_email:E,code:k});wait(s.b2,false);
if(!r.ok||!r.d.buyer_token){s.m2.textContent=txt(r.d,c.copy.checkFailed);
if(r.d.error==='BUYER_HAS_COACH'||r.d.error==='BUYER_NOT_CLIENT'){s.b2.hidden=true;s.rs.hidden=true;s.cd.disabled=true}return}
T=r.d.buyer_token;welcome(r.d.first_name,r.d.summary)}
async function resend(){var s=step();s.m2.textContent='';var r=await post('/check-email',{guest_email:E});s.m2.textContent=r.ok?c.copy.resent:txt(r.d,c.copy.checkFailed)}
function again(){E='';T=null;view(0,0,1);em.focus();if(em.select)em.select()}
var still=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
function welcome(n,k){var s=step();s.hey.textContent=n?c.copy.hey.split('{N}').join(n):c.copy.back;view(0,1,0);s.hey.focus();
setTimeout(function(){s.hey.className='hey out';setTimeout(function(){s.hey.hidden=true;
var ns=s.sum.querySelectorAll('[data-k]'),i;for(i=0;i<ns.length;i++)ns[i].hidden=ns[i].getAttribute('data-k')!==k;
if(s.inc)s.inc.hidden=true;s.sum.hidden=false;view(0,1,1);s.sum.focus()},still?0:600)},still?1200:1600)}
function key(e){var h=0,s=null,i;for(i=0;i<e.length;i++)h=(h*31+e.charCodeAt(i))|0;
try{s=JSON.parse(sessionStorage.getItem(K))}catch(_){}
if(!s||s.h!==h){s={k:crypto.randomUUID(),h:h};try{sessionStorage.setItem(K,JSON.stringify(s))}catch(_){}}return s.k}
async function pay(name,phone,email){busy(true);m.textContent='';
var r=await post(c.lp?'?lp='+encodeURIComponent(c.lp):'',{guest_name:name,guest_phone:phone,guest_email:email,idempotency_key:key(email),buyer_token:T||undefined}),d=r.d;
if(!r.ok||!d.client_secret){say(r.ok?c.copy.failed:txt(d,c.copy.failed));if(d.error==='BUYER_CODE_REQUIRED'){m.textContent='';await code(email)}return false}
var res=await stripe.confirmPayment({elements:el,clientSecret:d.client_secret,confirmParams:{return_url:location.origin+'/p/'+encodeURIComponent(c.token)+'/done',payment_method_data:{billing_details:{name:name,phone:phone,email:email}}}});
if(res.error){say(res.error.message);return false}return true}
x.on('confirm',async function(e){var bd=e.billingDetails||{},name=(bd.name||nm.value).trim(),phone=(bd.phone||ph.value).trim(),email=(bd.email||em.value).trim();
if(name.length<2){e.paymentFailed({reason:'fail'});say(c.copy.needName);nm.focus();return}
var s=await el.submit();if(s.error){e.paymentFailed({reason:'fail'});say(s.error.message);return}
if(!(await pay(name,phone,email)))e.paymentFailed({reason:'fail'})});
f.addEventListener('submit',async function(ev){ev.preventDefault();busy(true);
var s=await el.submit();if(s.error){say(s.error.message);return}await pay(nm.value.trim(),ph.value.trim(),em.value.trim())});
})();`;

// The confirm state's script: reads only the URL fragment Supabase adds after
// the invite link (#access_token=… or #error=…), shows the login email from
// the token's payload, then drops the fragment from the address bar. Nothing
// is sent anywhere (connect-src stays 'self' + Stripe; no fetch here).
const CONFIRMED_JS = `(function(){
var $=function(i){return document.getElementById(i)},h=new URLSearchParams(location.hash.slice(1)),e='';
if(h.get('error')||h.get('error_code')){$('ok').hidden=true;$('gone').hidden=false}
else{try{var t=(h.get('access_token')||'').split('.')[1];
if(t){var p=JSON.parse(decodeURIComponent(escape(atob(t.replace(/-/g,'+').replace(/_/g,'/')))));if(typeof p.email==='string')e=p.email}}catch(_){}
if(e)$('le').textContent=e}
if(location.hash&&history.replaceState)history.replaceState(null,'',location.pathname+location.search);
})();`;
