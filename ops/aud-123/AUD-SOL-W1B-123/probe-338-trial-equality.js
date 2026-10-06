// Read-only, lightweight execution of the reviewed equality predicate body.
// This is not a mounted-screen, Jest, network, or native-device test.
const fs = require("node:fs");
const source = fs.readFileSync(
  `${__dirname}/packageCreateIntent-338.ts`,
  "utf8",
);
const functionStart = source.indexOf("export function sameCreateInput(");
if (functionStart < 0) throw new Error("sameCreateInput not found");
const returnStart = source.indexOf("return (", functionStart);
const returnEnd = source.indexOf("\n  );", returnStart);
if (returnStart < 0 || returnEnd < 0) throw new Error("return expression not found");
const expression = source.slice(returnStart + "return (".length, returnEnd);
const sameCreateInput = new Function("a", "b", `return (${expression});`);
const before = {
  title: "Coaching",
  description: "Weekly coaching",
  priceCents: 9900,
  currency: "usd",
  billingInterval: "monthly",
  intervalCount: 1,
  trialDays: 0,
};
const cases = [
  ["trial None -> 7", { ...before, trialDays: 7 }, false],
  ["unchanged terms", { ...before }, true],
  ["changed price control", { ...before, priceCents: 19900 }, false],
];
for (const [name, after, expected] of cases) {
  const actual = sameCreateInput(before, after);
  console.log(JSON.stringify({ name, expected, actual, passes: actual === expected }));
}
