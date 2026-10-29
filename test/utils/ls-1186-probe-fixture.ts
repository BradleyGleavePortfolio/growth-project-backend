import * as fs from 'fs';
import * as path from 'path';

export const REPO = path.resolve(__dirname, '../..');
export const FIXTURE_REL = 'src/ls1186-notify-probe.ts';

/** CI-only fixtures: the durable proof commit contains only tests. */
export function installFixture(text: string): void {
  const file = path.join(REPO, FIXTURE_REL);
  if (fs.existsSync(file)) throw new Error('LS-1186 fixture path already exists');
  fs.writeFileSync(file, text);
  afterAll(() => fs.rmSync(file, { force: true }));
}

export function cutGuard(file: string, before: string, after: string): void {
  const abs = path.join(REPO, file);
  const text = fs.readFileSync(abs, 'utf8');
  if (text.split(before).length !== 2) throw new Error('LS-1186 guard anchor must occur once');
  fs.writeFileSync(abs, text.replace(before, after));
  afterAll(() => fs.writeFileSync(abs, text));
}
