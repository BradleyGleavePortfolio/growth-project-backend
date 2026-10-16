// SHARE-UNWIND (#SHARE-SIMPLE, SoT A2 item 13): one place decides whether a coach reads a client's
// workouts, food logs or weigh-ins: ConsentService (coachCanAccess, grantedScopesByClient). Every other
// source file that touches the consent table is listed with why it is not such a read; a new direct read
// of the table fails here. The reads that go through the rule are walked in share-unwind-rls.spec.ts.
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const SWITCH_ONLY = /clientCoachConsent\.findFirst\(\{\s*where: \{[^}]*scope: \{ in: \[\.\.\.COACH_SWITCH_SCOPES\] \}/;
const NOT_A_LINKED_READ: Record<string, [number, RegExp]> = {
  // The rule itself, and the client's own consent screens and history.
  'src/consent/consent.service.ts': [9, /COACH_LINK_SCOPES\.has\(scope\)/],
  // The join accept's grants.
  'src/consent/coach-sharing-notice.ts': [2, /tx\.clientCoachConsent\.upsert/],
  // "Has this client made a choice yet", for the first sign-in sentence.
  'src/consent/coach-sharing-first-sign-in.service.ts': [1, /clientCoachConsent\.count/],
  // When a Check-ins and habits switch last went off, for stored insights and briefs.
  'src/ai/coach/coach-ai.service.ts': [1, SWITCH_ONLY],
  'src/coach/brief/coach-brief.service.ts': [1, SWITCH_ONLY],
};

it('SHARE-UNWIND: no coach read of workouts, food logs or weigh-ins goes around ConsentService', () => {
  const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => relative(ROOT, join(ROOT, 'src', f)))
    .filter((f) => /clientCoachConsent|"ClientCoachConsent"/.test(readFileSync(join(ROOT, f), 'utf8')));
  expect(files.sort()).toEqual(Object.keys(NOT_A_LINKED_READ).sort());
  for (const [f, [calls, why]] of Object.entries(NOT_A_LINKED_READ)) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    expect([f, text.match(/clientCoachConsent\.\w+\(/g)?.length]).toEqual([f, calls]);
    expect(text).toMatch(why);
  }
});
