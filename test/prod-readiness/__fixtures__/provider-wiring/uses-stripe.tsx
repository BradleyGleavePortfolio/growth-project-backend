// Regression fixture for F003 (TSX imports missed).
//
// A minimal React (TSX) component that imports the Stripe SDK. The
// provider-wiring import collector must discover the `stripe` import from a
// `.tsx` file — the old `.ts`-only filter skipped TSX components entirely, so a
// provider used solely from React components reported NOT_USED. The JSX in the
// component body also exercises the `ScriptKind.TSX` parse path: without it the
// `<button>` element would be misparsed and the import lost.
//
// This file is a fixture, not production code — it is never imported by the app;
// the tests read it from disk.
import Stripe from 'stripe';

const stripe = new Stripe('sk_test_fixture_not_a_real_key');

export function CheckoutButton(): JSX.Element {
  const onClick = async (): Promise<void> => {
    await stripe.paymentIntents.create({ amount: 1000, currency: 'usd' });
  };
  return <button onClick={onClick}>Pay</button>;
}
