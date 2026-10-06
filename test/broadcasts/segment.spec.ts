import { combineRuleSets, normalizeTag, parseSegment } from '../../src/broadcasts/segment';
import { BroadcastHttpError } from '../../src/broadcasts/broadcast-errors';

const ID = '11111111-1111-4111-8111-111111111111';

describe('parseSegment', () => {
  it('defaults to every client on the roster', () => {
    expect(parseSegment({})).toEqual({ match: 'all', rules: [] });
  });

  it('accepts each segment field and normalises tags', () => {
    const s = parseSegment({
      match: 'any',
      rules: [
        { field: 'package', op: 'in', values: [ID] },
        { field: 'program', op: 'in', values: [ID] },
        { field: 'tag', op: 'not_in', values: ['  VIP  Clients '] },
        { field: 'signup_date', op: 'within_days', value: 30 },
        { field: 'last_active', op: 'not_within_days', value: 7 },
        { field: 'risk', op: 'in', values: ['red', 'unknown'] },
      ],
    });
    expect(s.rules[2]).toEqual({ field: 'tag', op: 'not_in', values: ['vip clients'] });
    expect(s.rules).toHaveLength(6);
  });

  it.each([
    [{ rules: [{ field: 'email', op: 'in', values: ['x'] }] }, 'field'],
    [{ rules: [{ field: 'package', op: 'not_in', values: [ID] }] }, 'op'],
    [{ rules: [{ field: 'package', op: 'in', values: ["1' OR 1=1"] }] }, 'value_id'],
    [{ rules: [{ field: 'risk', op: 'in', values: ['purple'] }] }, 'value_risk'],
    [{ rules: [{ field: 'last_active', op: 'within_days', value: 0 }] }, 'value_days'],
    [{ coach_id: ID }, 'unknown_field:coach_id'],
  ])('rejects %j with broadcast.segment_invalid (%s)', (input, reason) => {
    try {
      parseSegment(input);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BroadcastHttpError);
      expect((err as BroadcastHttpError).getResponse()).toMatchObject({
        code: 'broadcast.segment_invalid',
        reason,
      });
    }
  });
});

describe('combineRuleSets', () => {
  const roster = ['a', 'b', 'c', 'd'];
  it('all = intersection, any = union, both bounded by the roster', () => {
    const s1 = new Set(['a', 'b', 'zz-other-tenant']);
    const s2 = new Set(['b', 'c']);
    expect(combineRuleSets(roster, 'all', [s1, s2])).toEqual(['b']);
    expect(combineRuleSets(roster, 'any', [s1, s2])).toEqual(['a', 'b', 'c']);
  });
  it('honours explicit exclusions', () => {
    expect(combineRuleSets(roster, 'all', [], ['c'])).toEqual(['a', 'b', 'd']);
  });
});

describe('normalizeTag', () => {
  it('rejects tags outside the allowed alphabet', () => {
    expect(normalizeTag('<script>')).toBeNull();
    expect(normalizeTag('a'.repeat(33))).toBeNull();
    expect(normalizeTag('Week 1')).toBe('week 1');
  });
});
