import {
  checkCommunityText,
  COMMUNITY_FILTER_TERM_COUNT,
  normaliseForFilter,
} from '../../../src/community/safety/community-content-filter';

describe('community objectionable-content filter (Apple 1.2)', () => {
  it('loads the term list', () => {
    expect(COMMUNITY_FILTER_TERM_COUNT).toBeGreaterThan(30);
  });

  it.each([
    'great session today',
    'Hang in there, you have got this',
    'I assess my progress weekly',
    'Scunthorpe classic grass',
    'Nice cock-up on the form, try again',
    'The coach will kill it at the meet',
    'Shitake mushrooms with rice',
  ])('allows ordinary text: %s', (text) => {
    expect(checkCommunityText(text).allowed).toBe(true);
  });

  it.each([
    'kill yourself',
    'kys',
    'f.u.c.k you',
    'fuuuuck off',
    'you are a r3tard',
    'go die',
    'send nudes',
  ])('blocks objectionable text: %s', (text) => {
    expect(checkCommunityText(text).allowed).toBe(false);
  });

  it('checks every field and ignores empty ones', () => {
    expect(checkCommunityText('fine title', null, undefined, 'kys').allowed).toBe(false);
    expect(checkCommunityText(null, undefined, '').allowed).toBe(true);
  });

  it('never returns the matched terms, only a count', () => {
    const r = checkCommunityText('kys');
    expect(Object.keys(r).sort()).toEqual(['allowed', 'matches']);
    expect(r.matches).toBeGreaterThan(0);
  });

  it('folds substitutions and separators', () => {
    expect(normaliseForFilter('F.U.C.K')).toBe('fuck');
    expect(normaliseForFilter('k1ll')).toBe('kill');
  });
});
