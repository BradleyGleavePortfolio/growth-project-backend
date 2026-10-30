// STORE-E4C (agent 185): the policy lines that describe the "Before we start"
// boxes after STORE-E4 (one required box, Roman's AI asked the first time
// Roman opens; owner #184-E5 / #184-E6 op 1). Each line is true both before
// and after the phone update ships (people who joined on the two-box screen
// keep their records), never calls the box "consent" (RCW 19.373.010(6)(b)(i)),
// and ships only with the owner's word (Wording needed POL-1 to POL-6 on b#1188).
// FR-E4B (fix round 1): RENEW-1, the uses line naming the plan renewal offers the
// box turns on (LO-E4 N3). POL-7 and POL-8 (Roman's memory and notes, LS-E4 R1_B1)
// are pinned in test/trust-pages.spec.ts.
// FR-E4B (agent 186): the approved phrase B (185-W4, 10-30) "when you first open
// Roman"; POL-7 and POL-8 also pinned here, and the whole class (every sentence
// on every policy page that places the Roman permission in the consultation must
// also name the first Roman open) is checked by one table-driven test below.
import { renderTrustPage, type TrustPage } from '../src/public-pages/trust-pages.html';

function visibleText(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const map: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
  return body
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => map[m] ?? m)
    .replace(/\s+/g, ' ');
}

const ASK =
  'the app asks for it when you first open Roman or, in some versions of the app, in a second box on the same screen.';

const LINES: { id: string; page: TrustPage; text: string }[] = [
  {
    id: 'POL-1',
    page: 'privacy',
    text: `Roman is an AI assistant powered by Anthropic. At the start of the consultation the app asks you to tick a box, which you need to do to continue: it covers the personal-training waiver and lets TGP and your coach collect and use your information to coach you. Letting Roman and your coach’s AI drafts use your information is a separate, optional choice that names Anthropic as the AI provider and lists the data it receives: ${ASK} If you do not allow it, nothing about you is sent to Anthropic, and your plan, your coach, the community and Roman’s guided tour work as usual.`,
  },
  {
    id: 'POL-2',
    page: 'privacy',
    text: 'Sorting only includes posts and messages from members who allowed Roman and AI to use their information; everything else stays in the coach’s regular inbox, unsorted.',
  },
  {
    id: 'POL-3',
    page: 'consumer-health',
    text: 'so it can sort and summarise them for your coach (only if you allowed Roman and AI to use your information);',
  },
  {
    id: 'POL-4',
    page: 'consumer-health',
    text: 'After you allow Roman and AI to use your information, Roman may read, and send to Anthropic, your fasting logs,',
  },
  {
    id: 'POL-5',
    page: 'consumer-health',
    text: `Before we collect your consultation answers, the app asks you to tick a box, which you need to do to continue: it covers the personal-training waiver and lets TGP and your coach collect and use your information to coach you. Letting Roman and your coach's AI drafts use your information is a separate, optional choice that names Anthropic as the AI provider and lists the data it receives: ${ASK} If you do not allow it, nothing about you is sent to Anthropic. Connecting Apple Health or Health Connect asks for separate permission on your phone.`,
  },
  {
    id: 'POL-6',
    page: 'terms',
    text: 'Before your consultation you are asked to accept the personal-training waiver, which you need to do to continue. Letting Roman and your coach’s AI drafts use your information, processed by Anthropic, is a separate, optional choice.',
  },
  {
    id: 'POL-7',
    page: 'privacy',
    text: 'Roman’s memory is part of the Roman permission the app asks for when you first open Roman or, in some versions of the app, in a second box at the start of the consultation, and it is on unless you turn it off.',
  },
  {
    id: 'POL-8',
    page: 'consumer-health',
    text: 'as part of the Roman permission the app asks for when you first open Roman or, in some versions of the app, in a second box at the start of the consultation. Used to personalise Roman’s replies.',
  },
  {
    id: 'RENEW-1',
    page: 'privacy',
    text: 'To send the messages you expect: account emails, reminders and push notifications. TGP Fitness may send you plan renewal offers, which you can turn off in Settings.',
  },
];

// Words that described the two-box screen as the only screen, or the AI choice as a box.
const RETIRED = [
  /two separate boxes/i,
  /The second is optional/i,
  /optional AI box/i,
  /separate, optional box/i,
  /If you leave it unticked/i,
  // Phrase A (replaced by the approved phrase B, 185-W4) and the consultation-only
  // location of the Roman permission (LS-E4 R1_B1).
  /asks it the first time you open Roman/i,
  /asks for the first time you open Roman/i,
  /Roman permission you give in the consultation/i,
];

describe('STORE-E4C policy lines (one box at "Before we start"; Roman asked when first opened)', () => {
  it.each(LINES)('$id is on the $page page, word for word', ({ page, text }) => {
    expect(visibleText(renderTrustPage(page))).toContain(text);
  });

  it.each(['privacy', 'consumer-health', 'terms'] as TrustPage[])('the %s page no longer describes the old boxes', (page) => {
    const text = visibleText(renderTrustPage(page));
    for (const re of RETIRED) expect(text).not.toMatch(re);
  });

  it('never calls the box "consent", and the Settings lines that stay true are unchanged', () => {
    for (const { text } of LINES) expect(text).not.toMatch(/consent/i);
    const privacy = visibleText(renderTrustPage('privacy'));
    const health = visibleText(renderTrustPage('consumer-health'));
    expect(privacy).toContain(
      'You can allow or withdraw the optional AI agreement at any time in Settings > Privacy > Roman and AI; when you withdraw it, Roman and AI drafts about you stop until you agree again.',
    );
    expect(health).toContain('You can withdraw the optional AI agreement at any time in Settings > Privacy; Roman and AI drafts about you then stop.');
  });
});

// The class (LS-E4 R1_B1): a sentence that speaks of the Roman permission (or
// the AI agreement or choice) and places it in the consultation must also name
// the first Roman open, because a one-box client is never asked in the
// consultation. Each page lists how many such sentences it has today, so a new
// one cannot slip in untested and the check is never vacuous.
const GRANT = /Roman permission|AI agreement|Letting Roman|allow(?:ed)? Roman|optional AI|optional choice/i;
const IN_CONSULTATION = /\b(?:in|at the start of|during|before) (?:the |your )?consultation\b/i;
const FIRST_OPEN = 'when you first open Roman';

const CLASS: { page: TrustPage; placed: number; firstOpen: number }[] = [
  { page: 'privacy', placed: 1, firstOpen: 2 }, // POL-7; POL-1 + POL-7
  { page: 'consumer-health', placed: 1, firstOpen: 2 }, // POL-8; POL-5 + POL-8
  { page: 'terms', placed: 0, firstOpen: 0 }, // POL-6 names no place
];

describe('FR-E4B: no policy sentence places the Roman permission only in the consultation', () => {
  it.each(CLASS)('$page: every such sentence also names the first Roman open', ({ page, placed, firstOpen }) => {
    const text = visibleText(renderTrustPage(page));
    const sentences = text.split(/(?<=[.!?])\s+/);
    const inConsultation = sentences.filter((s) => GRANT.test(s) && IN_CONSULTATION.test(s));
    expect(inConsultation).toHaveLength(placed);
    for (const s of inConsultation) expect(s).toContain(FIRST_OPEN);
    expect(text.split(FIRST_OPEN).length - 1).toBe(firstOpen);
  });
});
