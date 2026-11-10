/**
 * LS-1232R1 B2 (b#1232 CRISIS-TEXT-BE @ d3c15742), rewritten by FIX-1232R1 under owner #203-E21 ("Op 1: normal
 * push"). The lens asked that these rows not page (a community-only guard); the owner kept Roman's check on community
 * text exactly as it is (#200-S1 op 1), so a row Roman's check matches still flags the poster's answer and still tells
 * staff. What changed is how: one inbox row per staff account and a normal push (not urgent: Mute all stops it, quiet
 * hours hold it, at most one per poster per day). Each row: screenText's flag is Roman's own call on the same field
 * (classifySafety), the row pages, and the real alertStaff queues pushes with urgent false.
 * Samples are ROT13 as filed and described by kind only ([R22]).
 */
import { classifySafety } from '../../../src/roman/guardrails/safety-router';
import { POSTER, STAFF_A, STAFF_B, staffAlertWorld } from './staff-alert-world';

const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));

const GYM_TALK: Array<[string, string]> = [
  // Training hyperbole after a set.
  ['training hyperbole after a set', rot13('V jnag gb qvr nsgre gubfr ohecrrf')],
  // Breathlessness after a workout, with a laugh marker.
  ['breathlessness after a workout, with a laugh marker', rot13('pnaabg oerngur nsgre gung jbexbhg unun')],
  // Breathlessness after sprints, told afterwards.
  ['breathlessness after sprints, told afterwards', rot13("gung ynfg frg bs fcevagf, V yvgrenyyl pbhyqa'g oerngur sbe n zvahgr")],
  // A coach's safety reminder.
  ["a coach's safety reminder", rot13('Erzvaqre sebz lbhe pbnpu: vs lbh rire srry purfg cnva qhevat n frffvba, fgbc naq pnyy 911')],
  // A coach quoting a client's past breathlessness.
  ["a coach quoting a client's past breathlessness", rot13("zl pyvrag grkgrq zr V pna'g oerngur nsgre gur uvyy fcevagf, fur jnf svar gjb zvahgrf yngre")],
];

describe('LS-1232R1 B2 (#203-E21): a match in ordinary gym talk reaches staff as a normal push', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(GYM_TALK)("%s: Roman's own call, one row per staff account, a push that is not urgent", async (_name, text) => {
    const w = staffAlertWorld();
    const screen = w.safety.screenText('space_chat', POSTER, [text]);
    const roman = classifySafety(text).class;
    expect(screen).toMatchObject({ flag: roman === 'emergency' || roman === 'self_harm', page: true });
    await w.safety.alertStaff(screen, 'row-1');
    expect(w.inbox.map((r) => r.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
    expect(w.out.rows.map((r) => [r.user_id, r.urgent]).sort()).toEqual([[STAFF_A, false], [STAFF_B, false]].sort());
  });
});
