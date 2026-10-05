import { spawnSync } from 'node:child_process';

describe('AUD-SOL-D6-120 candidate-only trusted R75 range check', () => {
  it('the #705 own range satisfies the required gate (audit additions excluded)', () => {
    const fetch = spawnSync('git', [
      'fetch', '--no-tags', '--depth=30', 'origin',
      '5138947cd082328b81cbeb787833914431b22fc1',
    ], { encoding: 'utf8', timeout: 60000 });
    expect({ code: fetch.status, stderr: fetch.stderr }).toMatchObject({ code: 0 });
    const ranges = [
      ['control #704', '21714f7bba299336cf71df0c87288c798fd5da13', '49d0b66e8a0a1cab02f0a5a03d48cad276a08e20'],
      ['#705 own piece', '49d0b66e8a0a1cab02f0a5a03d48cad276a08e20', '5138947cd082328b81cbeb787833914431b22fc1'],
      ['#705 composed vs main', 'ee55f814eb02b530e6578a168dc16c7ea7e2b07b', '5138947cd082328b81cbeb787833914431b22fc1'],
    ];
    const results = ranges.map(([name, base, head]) => {
      const scan = spawnSync(process.execPath, [
        'scripts/check-r75.js', '--mode=range', `--base=${base}`, `--head=${head}`,
      ], { encoding: 'utf8', timeout: 60000 });
      console.log(name, scan.stdout, scan.stderr);
      return { name, code: scan.status };
    });
    expect(results).toEqual(ranges.map(([name]) => ({ name, code: 0 })));
  }, 180000);
});
