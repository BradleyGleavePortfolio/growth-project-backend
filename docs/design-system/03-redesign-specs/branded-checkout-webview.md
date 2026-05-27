# Redesign Spec — `client/BrandedCheckoutWebViewScreen.tsx`

_Target file: [src/screens/client/BrandedCheckoutWebViewScreen.tsx](../../repos/growth-project-mobile/src/screens/client/BrandedCheckoutWebViewScreen.tsx). Current audit score: **1.7/5 overall** (2 Premium, 1 Rewarding, 2 CogSimple). Highest-stakes screen in the entire product. Spec only._

---

## Current state (prose)

This screen is the in-app, branded Stripe Checkout webview that handles all B2B exempt payments — the moment money actually moves from the client to the coach ([source header comment](../../repos/growth-project-mobile/src/screens/client/BrandedCheckoutWebViewScreen.tsx#L1-L36)). It is structurally a thin React Native wrapper around a `react-native-webview` pointed at `app.bradleytgpcoaching.com/checkout`, with a custom header (TGP logo + "Secure Checkout" + X button) and origin allow-listing for security.

What the user experiences today:
1. Screen mounts with our header bar. Loading spinner. Then the Stripe Checkout DOM renders inside the webview.
2. The user types card details into a UI that looks subtly different from the rest of our app (Stripe's defaults).
3. On success, the webview navigates to `…/checkout/success` and the native screen detects this, calls `onSuccess`, and pops. The user is dropped back into whatever screen invoked checkout, with no native acknowledgement of what just happened beyond the next screen rendering.
4. On error, raw error text from Stripe or the webview load failure is shown above the (often blank) webview.

The audit's verdict: "WebView/checkout wrapper is high-stakes but mostly technical; needs trust choreography and closure" ([audit row](../../audits/ux_review_report.md#L58), [Worst-10 #2](../../audits/ux_review_report.md#L251)). Top-20 fix #6 makes the prescription explicit: "Add status checklist, security reassurance, transition skeleton, and warm paid/failed closure instead of technical WebView feel" ([audit Top-20 #6](../../audits/ux_review_report.md#L294)).

---

## Problem statement

Checkout is the moment Phantom's polish-as-trust doctrine applies most directly. In every category where users hand over money or assets, "the quality of visible craftsmanship predicts (in the user's emotional model) the quality of invisible craftsmanship" ([Mobile Doc §2.2 polish-as-trust](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L391-L407)). A janky transition into the checkout webview, a raw Stripe-default form, and a silent native pop on success collectively communicate: *the team was not careful here* — which is the exact emotional inference we cannot afford on a payment screen.

The screen violates **Principle 5 (Haptics replace explanation)** by having no haptics at all on the most consequential action in the product, **Principle 2 (Every completion is a peak moment)** by treating a successful payment as silent navigation, and **Principle 3 (The screen breathes between actions)** by sitting frozen while the webview loads.

The CALM framework ([Mobile Doc §2.2 Phantom](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L445-L466)) maps directly onto checkout — Clarity, Animation, Light feedback, Mascot/character presence. We don't have a mascot, but the other three are all applicable and currently all absent.

---

## Target state (prose mock — top to bottom)

The redesigned checkout flow is **four phases inside one screen**: pre-load trust choreography, the webview itself (wrapped in our chrome), the resolution moment, and the warm closure. The user perceives one continuous, deliberately calm sequence — never a "loading screen → blank webview → success Alert" stutter.

### Phase 1 — Pre-load trust choreography (0–800ms after entry)

The screen mounts. Instead of an immediate spinner, the user sees:

1. **Header bar.** TGP logo left in `mutedGold` ink; the word "Checkout" centered in `bodyMd`; X button right. Hairline rule below.

2. **The trust checklist** — three lines appearing one at a time with the `enter` motion preset, 200ms stagger, each with a small `confirm` haptic as it appears:
   - "Secured by Stripe." (with a small subtle lock icon, not in red — in `textMuted`)
   - "Charged once. No subscription added without your okay."
   - "You can cancel anytime in Settings → How we reach you." (using the redesigned settings nomenclature from `client-settings.md`)

3. **A single line of context** below the checklist in `body`: "{{Coach name}}'s {{Package name}} — ${{amount}}." This is the only place the dollar amount appears outside the webview. It anchors the user before the Stripe form renders.

4. **The webview silhouette skeleton** below — a `<QuietSkeleton>` shaped like the eventual Stripe form: name field, card field, expiry, CVC, postal — five rectangles pulsing at the 1600ms cadence. This communicates "the form is coming" without showing a generic spinner.

By the end of Phase 1 (~800ms), the user has read three lines that lower anxiety, seen the amount they're about to be charged, and seen the shape of the form. Their card is probably already coming out of their wallet.

### Phase 2 — Webview interaction

The Stripe Checkout DOM fades in over the skeleton with a 400ms `exit`-then-`enter` crossfade. The webview itself remains the source of truth for card collection — we are not reimplementing Stripe Elements — but the visual surround is ours:

1. The header bar persists, breathing on the centered "Checkout" word (`breath` motion).
2. Below the webview, a single sticky line in `textMuted` `caption`: "Your card never touches our servers. Stripe handles encryption." This is permanent calm presence, not a notice that has to be dismissed.
3. The user types card details. The webview's own focus/blur/submit handlers run as Stripe defines them.
4. As Stripe processes the submit, the webview shows its own intermediate state (Stripe's spinner). We do not overlay ours on top — that would be double feedback. Our header bar's `breath` continues, communicating: the system is alive.

### Phase 3 — Resolution moment

The webview navigates to `…/checkout/success` (or `…/checkout/cancel`, or returns an error). The native screen detects this navigation event — exactly as it does today — but now intercepts the visual transition.

**On success:**
1. The webview fades out over 600ms with the `exit` preset.
2. The screen background remains `bgPrimary`. Centered, with `enter` preset and `peak` motion: the word "Done." in Cormorant `display` size, ink. Underneath in `body`: "${{amount}} processed. You're set." (no exclamation point, lifestyle voice).
3. `success` haptic fires at the moment "Done." lands; 200ms later, `peak` haptic chain fires.
4. A `<CompletionMoment variant="peak">` overlays — but configured to render as inline composition rather than bottom sheet, since this *is* the screen now. Props:
   ```tsx
   <CompletionMoment
     variant="peak"
     title="Done."
     subtitle="${{amount}} processed. You're set."
     nextAction={{ label: 'Back to your plan', onPress: onSuccess }}
   />
   ```
5. After 4 seconds with no tap, auto-dismiss → invoke `onSuccess` callback → pop the screen.

**On cancel:**
1. The webview fades out.
2. Centered, in `h2` Cormorant: "Stopped." In `body` below: "No charge. We held nothing."
3. `confirm` haptic only.
4. Single ink-fill CTA below: "Back to the package." Tap → `onCancel` callback.

**On error (network, declined, etc.):**
1. The webview fades out.
2. `<CalmError>` renders centered, with copy keyed to the error class:
   - Network: "We couldn't reach Stripe just now." / Recovery: "Try again"
   - Declined: "Your bank declined the card." / Recovery: "Use a different card"
   - Allowlist violation: "That redirect wasn't allowed. We've stopped the transaction to keep you safe." / Recovery: "Back to the package"
3. `error` haptic fires once on mount.
4. No webview reload in place — every retry is a fresh checkout session (the existing backend mints a new session URL).

### Phase 4 — Warm closure

After the resolution moment auto-dismisses or the user taps the next action, control returns to the invoking screen. The invoking screen (typically `ClientPackagesScreen` or a coach booking flow) should also render its own quiet `<CompletionMoment variant="quiet" title="You're subscribed.">` strip on focus — this is the "second-touch confirmation" that the payment is reflected in the next screen, not just the one we just left. (The current `CheckoutReturnScreen.tsx`, [audit row 3.0/5](../../audits/ux_review_report.md#L59), is the right place for that — it gets a small upgrade to use the standard primitive.)

---

## Component breakdown — primitives used

| Primitive | Where it fires |
|---|---|
| `useSpring('enter')` | Trust-checklist lines staggered on Phase 1; "Done." headline on Phase 3 |
| `useSpring('exit')` | Webview crossfade on Phase 2 entry and Phase 3 resolution |
| `useSpring('breath')` | Header bar's "Checkout" word, continuously |
| `useSpring('peak')` | The "Done." reveal on successful payment |
| `useHaptic('confirm')` | Each trust-checklist line as it appears; cancel resolution |
| `useHaptic('success')` then `useHaptic('peak')` | Chained on successful payment |
| `useHaptic('error')` | Any error resolution |
| `<QuietSkeleton>` | Phase 1 webview-shape silhouette |
| `<CompletionMoment variant="peak">` | Phase 3 success state, configured inline |
| `<CalmError>` | All Phase 3 error states, error-class-keyed copy |

The Stillwater Path block:

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     Package selection screen (client or coach-led) or booking checkout.
 * HERE:     Read trust framing, enter card details in the Stripe webview,
 *           wait for resolution.
 * NEXT:     The invoking screen, on success, cancel, or error.
 * CLOSURE:  Peak on success (in-screen, full "Done." reveal). Quiet on
 *           cancel. CalmError on error. Plus a second-touch quiet
 *           CompletionMoment on the next screen.
 *
 * Primitives: useSpring(enter, exit, breath, peak), useHaptic(all six),
 *             CompletionMoment(peak), CalmError, QuietSkeleton
 */
export const stillwater = {
  primaryDecision: 'Confirm payment for this package',
  primaryActionLabel: 'Pay {{amount}}', // rendered inside the Stripe webview;
                                         // our chrome shows "Checkout" only.
  expectedExit: 'complete',
} as const;
```

---

## Copy patches — before / after

| Element | Before | After |
|---|---|---|
| Header center title | "Secure Checkout" | "Checkout" (calmer; "Secure" lives in the trust checklist below where it's earned, not in the header where it's claimed) |
| Pre-load state | Loading spinner | The three trust-checklist lines + webview skeleton |
| Trust line 1 | (none) | "Secured by Stripe." |
| Trust line 2 | (none) | "Charged once. No subscription added without your okay." |
| Trust line 3 | (none) | "You can cancel anytime in Settings." |
| Webview persistent footer | (none) | "Your card never touches our servers. Stripe handles encryption." |
| Success state | Native pop, no acknowledgement | `<CompletionMoment variant="peak">` with "Done." / "${{amount}} processed. You're set." |
| Success next-action label | (no native CTA on success today) | "Back to your plan" |
| Cancel state | Native pop with raw cancel callback | "Stopped." / "No charge. We held nothing." / "Back to the package" |
| Network error | Raw error text | "We couldn't reach Stripe just now." / "Try again" |
| Card declined error | Raw Stripe error | "Your bank declined the card." / "Use a different card" |
| Allowlist block | Technical message | "That redirect wasn't allowed. We've stopped the transaction to keep you safe." / "Back to the package" |

---

## Haptic / motion spec — when does what fire

| Event | Haptic | Motion |
|---|---|---|
| Screen mount | none on mount itself | `enter` cascade on trust checklist; `breath` on header begins |
| Each trust-checklist line appears | `confirm` | `enter` for that line |
| Webview content first paints | none | `exit` of skeleton crossfades into webview content |
| Form field focus / blur (inside webview) | none (we don't intercept Stripe's UI) | Stripe-native |
| Submit press (inside webview) | none from us | Stripe-native |
| Successful payment confirmed | `success` then 200ms later `peak` | `exit` of webview → `peak` reveal of "Done." |
| Auto-dismiss after 4s of success | none | `exit` of the success composition |
| Cancel detected | `confirm` | `exit` of webview → fade in of "Stopped." |
| Error (any class) | `error` | `exit` of webview → fade in of `<CalmError>` |
| X button tap | `caution` | If form is touched (Stripe can tell us via the navigation state), show a one-decision sheet: "Leave checkout? Nothing has been charged." with "Leave" and "Stay" buttons. If form is untouched, just dismiss. |

---

## Success criteria

1. **Audit score moves from 1.7/5 to ≥4.0/5.** Premium climbs from 2 to ≥4 thanks to trust choreography. Rewarding climbs from 1 to ≥4 thanks to peak success state. CogSimple climbs from 2 to ≥4 thanks to one-decision sequencing.
2. **Drop-off between checkout-screen-entered and checkout-attempted (form submit) drops by ≥20%.** The trust choreography is specifically designed to convert hesitation into commitment in the first 800ms.
3. **Payment success → next-action engagement.** ≥70% of users tap the "Back to your plan" CTA before auto-dismiss fires, indicating the success state was registered (not skipped past).
4. **No raw Stripe / WebView error text reaches the user.** Every error path renders `<CalmError>` with mapped lifestyle-voice copy. Engineering audit: grep for `errorMessage(` calls reaching the render tree.
5. **Net Promoter on the "how did paying feel?" question post-checkout** (added to existing post-payment survey) shifts from current baseline to ≥+30. The qualitative target: at least one verbatim mention of "calm" or "smooth" per 20 surveys.
6. **No regression on Apple App Review.** The custom chrome and trust framing must not violate Rule 3.1.3(b)/(e) — the existing source header notes this is the explicit constraint ([source comment](../../repos/growth-project-mobile/src/screens/client/BrandedCheckoutWebViewScreen.tsx#L1-L36)). The redesign adds visual surround, not payment-flow logic, so the rule compliance is unchanged.

---

_End of `branded-checkout-webview.md`._
