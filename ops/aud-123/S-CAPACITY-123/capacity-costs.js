// Decision estimates only. No service calls or infrastructure changes.
const flySource = 'https://docs.fly.io/about/pricing/';
const supabaseSource = 'https://supabase.com/pricing';
const secondsPerMonth = 2592000;
const sjcMarkup = 1.192307692;
const cpuPrices = { shared: 0.0000008465, performance: 0.000012732 };
const includedMemory = { shared: 0.25, performance: 2 };
const extraMemoryPerGBSecond = 0.000002316;
const round = (value) => Number(value.toFixed(2));
const presets = [
  { name: 'shared-cpu-2x / 2GB', kind: 'shared', cpus: 2, memoryGB: 2 },
  { name: 'shared-cpu-2x / 4GB', kind: 'shared', cpus: 2, memoryGB: 4 },
  { name: 'performance-1x / 2GB', kind: 'performance', cpus: 1, memoryGB: 2 },
  { name: 'performance-2x / 4GB', kind: 'performance', cpus: 2, memoryGB: 4 }
].map((preset) => {
  const perSecond = (
    preset.cpus * cpuPrices[preset.kind] +
    (preset.memoryGB - preset.cpus * includedMemory[preset.kind]) * extraMemoryPerGBSecond
  ) * sjcMarkup;
  return {
    ...preset, perSecond,
    hourlyUSD: Number((perSecond * 3600).toFixed(4)),
    monthly30DaysUSD: round(perSecond * secondsPerMonth),
    source: flySource
  };
});
function estimate(name, presetIndex, machines, supabase) {
  const fly = presets[presetIndex].perSecond * secondsPerMonth * machines;
  return {
    name, machines, flyPreset: presets[presetIndex].name,
    flyUSD: round(fly), supabaseUSD: supabase,
    totalUSD: round(fly + supabase)
  };
}
console.log(JSON.stringify({
  currency: 'USD',
  region: 'sjc',
  billingAssumption: '30 days of continuous Fly runtime; Supabase approximate monthly list prices for one project',
  exclusions: 'Redis, provider/API/AI charges, taxes, egress, stopped rootfs, additional projects and usage overages',
  inputs: { secondsPerMonth, sjcMarkup, cpuPrices, includedMemory, extraMemoryPerGBSecond, source: flySource },
  presets,
  supabase: {
    proBaseUSD: 25, computeCreditUSD: 10,
    microComputeUSD: 10, smallComputeUSD: 15, mediumComputeUSD: 60,
    proMicroTotalUSD: 25, proSmallTotalUSD: 30, proMediumTotalUSD: 75,
    source: supabaseSource
  },
  options: [
    estimate('One shared / Pro Micro', 0, 1, 25),
    estimate('Two shared / Pro Small', 0, 2, 30),
    estimate('One performance / Pro Small', 2, 1, 30),
    estimate('Two performance / Pro Small', 2, 2, 30),
    estimate('One larger performance / Pro Small', 3, 1, 30),
    estimate('Two larger performance / Pro Small', 3, 2, 30)
  ],
  peakOnlySecondPerformanceMachine10HoursUSD: round(presets[2].perSecond * 3600 * 10)
}, null, 2));
