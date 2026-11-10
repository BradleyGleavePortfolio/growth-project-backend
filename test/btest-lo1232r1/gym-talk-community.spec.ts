/**
 * LO-1232R1 B2 (lens, agent 203): ordinary gym talk in a community write must not mark the poster's answer or page
 * staff. Samples are ROT13-encoded and described only (R22). Each is training hyperbole, a drill name or a quoted
 * joke that a coached member writes in a group; Roman's own lists (ai-crisis-router.ts) stay as they are, so the fix
 * belongs to the community check.
 */
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';

const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));

const GYM_TALK: [string, string][] = [
  ['out of breath after a finisher, with a laugh', "Gung svavfure unq zr yvxr V pna'g oerngur yby"],
  ['wanting to die after leg day (hyperbole)', 'Yrt qnl gbqnl, V jnag gb qvr'],
  ['a drill named after suicide (burpees)', 'Fhvpvqr ohecrrf ner gur jbefg'],
  ['a drill named after suicide (lines)', 'Pbnpu unq hf qbvat fhvpvqr yvarf gbqnl'],
  ['wishing to be dead after a HIIT class (hyperbole)', 'gung UVVG pynff, V jvfu V jnf qrnq'],
  ['quoting another member\'s leg-day joke', 'Unun fur whfg fnvq V jnag gb qvr nsgre yrt qnl'],
];

describe('LO-1232R1 B2: gym talk in community text is not a crisis', () => {
  const safety = new CommunitySafetyService({} as never, undefined);
  it.each(GYM_TALK)('%s: no crisis_flag, no page', (_kind, encoded) => {
    const screen = safety.screenText('space_chat', 'poster', [rot13(encoded)]);
    expect({ flag: screen.flag, page: screen.page }).toEqual({ flag: false, page: false });
  });
});
