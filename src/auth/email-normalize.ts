// Clinic launch C13 fix round — one email canonicaliser for the signup paths.
//
// `User.email` is a case-sensitive TEXT unique index, while Supabase folds
// addresses to lowercase. Before this helper, `Jane@Example.com` (stored as
// typed) and `jane@example.com` (from Google/Apple, or a second register)
// were two different accounts to the "new vs existing" decision, which let a
// case variant of a known address mint a brand-new coach row.
//
// NFKC folds fullwidth / ligature forms (`ﬁ` -> `fi`) so the lookup value and
// the stored value always agree. Homoglyphs in a different Unicode letter are
// a different address and stay one — that is a new account, which PLG allows.
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}
