// Module 1: per-entity voice card. One machine-readable spec per workspace
// (brand entity), enforced on every generated output. Cards live on the
// workspace profile (profile.voiceCard), so rules never leak across entities.
// Pure string checks, zero model tokens. Fail closed: a violation is cited
// with its span, the generator retries once, a second failure is escalated.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Seed vocabulary. Owner-specific additions go in profile.voiceCard.
export const DEFAULT_CARD = {
  banned_phrases: [
    '—', '–', // em and en dash (doctrine law 9)
    'game-changer', 'game changer', 'dive in', 'dive into', 'unleash', 'unlock', 'elevate your',
    "in today's fast-paced world", 'fast-paced world', 'delve', 'tapestry', 'testament to',
    'bucket list', 'hidden gem', 'wanderlust', 'trip of a lifetime', 'once in a lifetime',
    'stunning', 'breathtaking', 'nestled', 'whisk you away', 'curated experience',
    'influencer', 'seamless', 'robust', 'cutting-edge', 'next level', 'revolutionize',
  ],
  // Structural bans. Each is {id, re, label}; re is stored as a source string
  // so a card survives JSON round trips.
  banned_patterns: [
    { id: 'negate_reframe', label: 'negation then reframe ("it\'s not X, it\'s Y")', re: "\\b(?:it|this|that)(?:'s| is| isn't| is not) not (?:just |only |about )?[^.!?\\n]{1,80}[,;:]? (?:it's|it is|but|rather|instead)\\b" },
    { id: 'not_just', label: 'not just X, but Y', re: "\\bnot (?:just|only|merely) [^.!?\\n]{1,80}, but\\b" },
    { id: 'engagement_bait', label: 'engagement bait', re: "\\b(?:drop a [^\\s]+ (?:in the comments|below)|tag (?:a|someone)|like and share|smash (?:that|the) (?:like|follow)|double[- ]tap if|comment ['\"]?yes['\"]? if)\\b" },
    { id: 'mechanical_transition', label: 'mechanical transition', re: '(?:^|\\n|\\. )(?:Moreover|Furthermore|Additionally|In conclusion|In summary|Ultimately),' },
    { id: 'rhetorical_opener', label: 'rhetorical question opener', re: "^(?:Ever wondered|Have you ever wondered|Are you ready to|Looking for)\\b" },
  ],
  style_targets: {
    max_sentence_words: 32,
    contractions: 'prefer',
    first_person: 'required in stories and posts',
  },
  entity_facts: [],
};

const text = (v) => (v == null ? '' : Array.isArray(v) ? v.map(text).join('\n') : typeof v === 'object' ? Object.values(v).map(text).join('\n') : String(v));

// Card for this entity: defaults, plus the creator's own additions, plus the
// per-workspace hard blocklist. Never reads another workspace.
export function getVoiceCard(profile) {
  const own = profile?.voiceCard || {};
  const never = (profile?.business?.neverMention || []).map((t) => String(t || '').trim()).filter(Boolean);
  const phrases = [...new Set([...DEFAULT_CARD.banned_phrases, ...(own.banned_phrases || [])])];
  const patterns = [...DEFAULT_CARD.banned_patterns, ...(own.banned_patterns || [])]
    .filter((p) => p && p.re)
    .filter((p, i, a) => a.findIndex((q) => q.id === p.id) === i);
  return {
    banned_phrases: phrases,
    banned_terms: never, // blocklist, matched on word boundaries
    banned_patterns: patterns,
    style_targets: { ...DEFAULT_CARD.style_targets, ...(own.style_targets || {}) },
    entity_facts: own.entity_facts || [],
  };
}

const spanAround = (s, i, len) => s.slice(Math.max(0, i - 20), Math.min(s.length, i + len + 20)).replace(/\s+/g, ' ').trim();

// Returns [{rule, id, span, message}]. Empty means the text is on voice.
export function scanText(card, raw) {
  const s = text(raw);
  const out = [];
  if (!s) return out;
  for (const phrase of card.banned_phrases) {
    const isDash = phrase === '—' || phrase === '–';
    const re = new RegExp(isDash ? escapeRe(phrase) : `(?<![\\w])${escapeRe(phrase)}(?![\\w])`, 'ig');
    for (const m of s.matchAll(re)) {
      out.push({ rule: 'banned_phrase', id: phrase, span: spanAround(s, m.index, m[0].length), message: isDash ? 'em or en dash' : `banned phrase "${phrase}"` });
      if (isDash) break;
    }
  }
  for (const term of card.banned_terms || []) {
    const m = new RegExp(`(?<![\\w])${escapeRe(term)}(?![\\w])`, 'i').exec(s);
    if (m) out.push({ rule: 'blocklist', id: term, span: spanAround(s, m.index, m[0].length), message: `blocklisted term "${term}"` });
  }
  for (const p of card.banned_patterns) {
    let re;
    try { re = new RegExp(p.re, 'im'); } catch { continue; }
    const m = re.exec(s);
    if (m) out.push({ rule: 'banned_pattern', id: p.id, span: spanAround(s, m.index, m[0].length), message: p.label });
  }
  const max = card.style_targets?.max_sentence_words;
  if (max) {
    for (const sentence of s.split(/(?<=[.!?])\s+/)) {
      const words = sentence.trim().split(/\s+/).filter(Boolean).length;
      if (words > max && !/^#{1,6}\s/.test(sentence)) {
        out.push({ rule: 'style', id: 'sentence_length', span: sentence.trim().slice(0, 80), message: `sentence over ${max} words` });
        break;
      }
    }
  }
  return out;
}

// Scan every text field of a generated platform asset.
export function scanFields(card, fields) {
  const out = [];
  for (const [key, value] of Object.entries(fields || {})) {
    for (const v of scanText(card, value)) out.push({ ...v, field: key });
  }
  return out;
}

export const formatViolations = (vs) =>
  vs.slice(0, 12).map((v) => `- ${v.field ? `${v.field}: ` : ''}${v.message}: "${v.span}"`).join('\n');
