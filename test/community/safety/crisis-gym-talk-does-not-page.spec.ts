/**
 * LS-1232R1 B2 (b#1232 CRISIS-TEXT-BE @ d3c15742): ordinary gym talk must not page every TGP staff account. screenText
 * runs Roman's one-person classifier over group text with no context (community-safety.service.ts:87-93), so these
 * everyday lines (joking exaggeration after a workout, breathlessness told in the past tense with a laugh, a coach's own
 * safety reminder that names chest pain and 911) come back emergency or self_harm and alertStaff pages the owner-role
 * accounts, urgent, past Mute all and quiet hours. Samples are ROT13 and described, never quoted ([R22]).
 */
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';

const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));
const stub = <T>(v: unknown): T => v as T;
const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';

const GYM_TALK: Array<[string, string]> = [
  // A joke about wanting to die after a set of burpees.
  ['joking exaggeration after burpees', rot13('V jnag gb qvr nsgre gubfr ohecrrf')],
  // Breathless after a workout, past tense, with a laugh.
  ['cannot breathe after the workout, laughing', rot13('pnaabg oerngur nsgre gung jbexbhg unun')],
  // Breathless for a minute after sprints, told afterwards.
  ['could not breathe for a minute after sprints', rot13("gung ynfg frg bs fcevagf, V yvgrenyyl pbhyqa'g oerngur sbe n zvahgr")],
  // A coach's safety reminder: on chest pain, stop and call 911.
  ['a coach safety reminder naming chest pain and 911', rot13('Erzvaqre sebz lbhe pbnpu: vs lbh rire srry purfg cnva qhevat n frffvba, fgbc naq pnyy 911')],
  // A coach quoting a client's breathless text and saying she was fine.
  ['quoting a client who could not breathe and was fine', rot13("zl pyvrag grkgrq zr V pna'g oerngur nsgre gur uvyy fcevagf, fur jnf svar gjb zvahgrf yngre")],
];

describe('LS-1232R1 B2: ordinary gym talk does not page staff', () => {
  const safety = new CommunitySafetyService(stub({}), undefined);
  it.each(GYM_TALK)('%s: no flag, no page', (_name, text) => {
    const screen = safety.screenText('space_chat', POSTER, [text]);
    expect(screen).toMatchObject({ flag: false, page: false });
  });
});
