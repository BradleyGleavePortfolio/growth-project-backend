// test/roman/roman-quote.spec.ts
//
// ROMAN-QUOTE-SAFETY-BE: the pure split and proof in src/roman/guardrails/roman-quote.ts, against the phone's own
// excerpt and wire form (copied in roman-quote-safety.harness.ts from growth-project-mobile at
// cd791b8c4532bfd017ecdd3980534b658f7b3365). Neutral words and Roman's own fixed replies only. No I/O.

import { ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import { quoteOpensReply, splitRomanQuote } from '../../src/roman/guardrails/roman-quote';
import { NEUTRAL_BODY, NEUTRAL_REPLY, romanQuoteExcerpt, withRomanQuote } from './roman-quote-safety.harness';

const LONG = ROMAN_SAFETY_TEMPLATES.self_harm;

describe('splitRomanQuote: the phone\'s shape, on the raw text', () => {
  it('splits the phone\'s wire form into the quote line and the member\'s words', () => {
    expect(splitRomanQuote(withRomanQuote(NEUTRAL_REPLY, NEUTRAL_BODY))).toEqual({ quote: NEUTRAL_REPLY, body: NEUTRAL_BODY });
    expect(splitRomanQuote(withRomanQuote(LONG, NEUTRAL_BODY))?.quote).toBe(romanQuoteExcerpt(LONG));
  });

  it('only the first line goes; a body that starts with "> " or holds blank lines keeps them', () => {
    expect(splitRomanQuote(`> a\n\n> b\n\nc`)).toEqual({ quote: 'a', body: '> b\n\nc' });
    expect(splitRomanQuote(`> a\n\nb\n\nc`)).toEqual({ quote: 'a', body: 'b\n\nc' });
  });

  it.each([
    ['one newline', `> a\nb`],
    ['a leading space', ` > a\n\nb`],
    ['no space after ">"', `>a\n\nb`],
    ['a blank body', `> a\n\n \n `],
    ['a quote on the second line', `b\n> a\n\nb`],
    ['no quote', NEUTRAL_BODY],
  ])('not the shape (%s): null', (_name, text) => {
    expect(splitRomanQuote(text)).toBeNull();
  });
});

describe('quoteOpensReply: a prefix of the reply as the phone excerpts it', () => {
  it('proves every excerpt the phone makes', () => {
    expect(quoteOpensReply(romanQuoteExcerpt(LONG), LONG)).toBe(true); // cut, ends in U+2026
    expect(quoteOpensReply(romanQuoteExcerpt(LONG, 37), LONG)).toBe(true); // a limit shrunk near the send cap
    expect(quoteOpensReply(romanQuoteExcerpt(NEUTRAL_REPLY), NEUTRAL_REPLY)).toBe(true); // shorter than the limit
    const marked = LONG.replace('I am sorry', '**I am sorry**').replace(/\. /g, '.\n\n');
    expect(quoteOpensReply(romanQuoteExcerpt(marked), marked)).toBe(true); // ** and newlines
  });

  it('never a match inside a reply, past its end, or of an empty quote', () => {
    expect(quoteOpensReply(LONG.slice(40, 120), LONG)).toBe(false);
    expect(quoteOpensReply(`${NEUTRAL_REPLY} more`, NEUTRAL_REPLY)).toBe(false);
    expect(quoteOpensReply(`${romanQuoteExcerpt(LONG, 60)}x`, LONG)).toBe(false);
    expect(quoteOpensReply('…', LONG)).toBe(false);
    expect(quoteOpensReply(' ', LONG)).toBe(false);
  });
});
