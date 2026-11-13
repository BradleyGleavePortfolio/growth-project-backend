/**
 * LO-1232R1 B2 (lens, agent 203), rewritten by FIX-1232R1 under owner #203-E21 ("Op 1: normal push"). The lens
 * asked for a community-only guard so these rows would neither flag nor page; the owner kept Roman's check on
 * community text exactly as it is (#200-S1 op 1) and chose a normal push instead. So each row now proves the promise:
 * the community check adds no step of its own (the flag is Roman's own call on the same field), the row pages, and the
 * page is one inbox row per staff account plus a push that is not urgent (Mute all and quiet hours apply).
 * Samples are ROT13-encoded as filed and described by kind only ([R22]).
 */
// CRISIS-STAFF-OFF-BE: the community crisis staff alert is off for v1 (owner #203-E34). This file turns it on so
// the off-for-v1 sender's code stays tested (the operator's choice, not an owner word).
jest.mock('../../src/notifications/push/community-crisis-staff-alert', () => ({ COMMUNITY_CRISIS_STAFF_ALERT_ON: true }));
import { classifySafety } from '../../src/roman/guardrails/safety-router';
import { POSTER, STAFF_A, STAFF_B, staffAlertWorld } from '../community/safety/staff-alert-world';

const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));

const GYM_TALK: [string, string][] = [
  ['training hyperbole after a finisher, with a laugh marker', "Gung svavfure unq zr yvxr V pna'g oerngur yby"],
  ['training hyperbole after leg day', 'Yrt qnl gbqnl, V jnag gb qvr'],
  ['a drill name (burpees)', 'Fhvpvqr ohecrrf ner gur jbefg'],
  ['a drill name (lines)', 'Pbnpu unq hf qbvat fhvpvqr yvarf gbqnl'],
  ['training hyperbole after a class', 'gung UVVG pynff, V jvfu V jnf qrnq'],
  ["a quoted member's training joke", 'Unun fur whfg fnvq V jnag gb qvr nsgre yrt qnl'],
];

describe("LO-1232R1 B2 (#203-E21): community text keeps Roman's own call, and a match reaches staff as a normal push", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(GYM_TALK)("%s: the flag is Roman's own call, it pages, one row per staff account and a push that is not urgent", async (_kind, encoded) => {
    const text = rot13(encoded);
    const w = staffAlertWorld();
    const screen = w.safety.screenText('space_chat', POSTER, [text]);
    const roman = classifySafety(text).class;
    expect({ flag: screen.flag, page: screen.page }).toEqual({ flag: roman === 'emergency' || roman === 'self_harm', page: true });
    await w.safety.alertStaff(screen, 'row-1');
    expect(w.inbox.map((r) => r.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
    expect(w.out.rows.map((r) => [r.user_id, r.urgent]).sort()).toEqual([[STAFF_A, false], [STAFF_B, false]].sort());
  });
});
