// Profile linter: catches rule breaks in the creator's OWN profile text
// before they reach generation. The profile feeds every prompt and the
// published JSON-LD, so a blocklisted word or a disparaging phrase living
// in a credential line leaks into every package built afterward (it already
// has: "budget pressure" sat in a credentials field on the blocklist).
// Pure string checks, zero model tokens. Findings are warnings, never
// blocks: the creator decides, the studio just makes the leak visible.

const text = (v) => (v == null ? '' : Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Same unambiguous vocabulary the industry_respect rubric check enforces on
// packages (lib/visibility.js), so the profile is held to the same bar.
const DISPARAGING = /\b(cesspool|dumpster fire|scammy|scam artists?|rip[- ]?offs?|sleazy|sketchy|predatory|soulless|race to the bottom|churn and burn)\b/i;
const DASHES = /[\u2013\u2014]/;

// Free-text profile fields that feed prompts and schema. neverMention itself
// is excluded on purpose: it is the list, not a leak.
function profileFields(profile) {
  const biz = profile?.business || {};
  const person = biz.person || {};
  const fields = [
    ['business.name', biz.name],
    ['business.tagline', biz.tagline],
    ['business.audience', biz.audience],
    ['business.offers', biz.offers],
    ['business.location', biz.location],
    ['business.person.name', person.name],
    ['business.person.title', person.title],
    ['business.person.credentials', person.credentials],
    ['interview.brief', profile?.interview?.brief],
    ['voiceDna.summary', profile?.voiceDna?.summary],
  ];
  (profile?.testimonials || []).forEach((t, i) => fields.push([`testimonials[${i}].quote`, t?.quote]));
  return fields.map(([path, value]) => [path, text(value)]).filter(([, v]) => v);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function lintProfile(profile) {
  const warnings = [];
  const fields = profileFields(profile);
  const banned = (profile?.business?.neverMention || []).map((t) => String(t || '').trim()).filter(Boolean);

  for (const [path, value] of fields) {
    for (const term of banned) {
      // Word-boundary match, so a banned "Expedia" never flags "expedition".
      if (new RegExp(`(?<![\\w])${escapeRe(term)}(?![\\w])`, 'i').test(value)) {
        warnings.push({
          id: 'blocklist', field: path, term,
          message: `"${term}" is on your blocklist but appears in ${path}. Generation reads this field, so the word can leak into published copy and schema. Reword it here.`,
        });
      }
    }
    const slur = value.match(DISPARAGING);
    if (slur) {
      warnings.push({
        id: 'industry_respect', field: path, term: slur[0],
        message: `"${slur[0]}" in ${path} is disparaging vocabulary. Your industry-respect rule forbids it everywhere, and generation will echo it.`,
      });
    }
    if (DASHES.test(value)) {
      warnings.push({
        id: 'no_dashes', field: path,
        message: `${path} contains an em or en dash. Generation echoes profile wording, so replace it with a comma, colon, or period.`,
      });
    }
  }
  return warnings;
}
