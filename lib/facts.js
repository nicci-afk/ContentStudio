// Module 5: fact-check gate. Every checkable claim in a draft is matched
// against the entity's knowledge base; unverified claims are blocked, never
// shipped. Deterministic (no model tokens) so the fabricated-claim set is
// classified identically every time. The classifier interface is a stub for
// a future automated first pass (Jev); human review stays mandatory.
//
// Knowledge base entry: {id, claim, status: verified|owner_statement|unverified, source, date}
// Stored on profile.knowledgeBase (per workspace, so entities never blend).
// Entries are also derived read-only from the profile and the approved
// content-plan facts, so existing owner-written material counts as
// owner_statement without re-entry.

export const STATUSES = ['verified', 'owner_statement', 'unverified'];

const text = (v) => (v == null ? '' : Array.isArray(v) ? v.map(text).join(' ') : typeof v === 'object' ? Object.values(v).map(text).join(' ') : String(v));

const STOP = new Set('the and for with that this from have has had was were are you your our their they them his her its who what when where which will would can could into over under about after before more most some any all not but out one two than then also just only very'.split(' '));

const normNum = (s) => s.replace(/[,$]/g, '');
const numbers = (s) => [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => normNum(m[0]));
const words = (s) => [...new Set((s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(?:ing|ed|es|s)$/, '')))];

// What makes a sentence a checkable claim: money, percentages, years,
// quantities of people/things, dates, credentials, awards, superlatives.
const CLAIM_PATTERNS = [
  /\$\s?\d/, /\b\d[\d,.]*\s?(?:%|percent)/i,
  /\b(?:19|20)\d{2}\b/,
  /\b\d[\d,.]*\s?\+?\s?(?:years?|months?|nights?|days?|clients?|guests?|attendees?|advisors?|seats?|members?|trips?|events?|people|properties|countries|destinations|bookings?|followers|miles|hours)\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s\d{1,2}\b/i,
  /\b(?:certified|accredited|licensed|award[- ]winning|awarded|ranked|member of|partner(?:ed)? with|preferred (?:agency|partner)|official)\b/i,
  /#\s?1\b|\b(?:the )?(?:only|first|largest|best|top|leading|number one)\b/i,
];
const isClaim = (sentence) => CLAIM_PATTERNS.some((re) => re.test(sentence));

export function extractClaims(raw) {
  const s = text(raw).replace(/^#{1,6}\s.*$/gm, '').replace(/\[[^\]]*\]/g, ' ');
  return s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 8 && isClaim(x));
}

// Entries from the profile and approved plan facts. Owner-written, so
// owner_statement unless a plan fact is labeled as a project file.
export function deriveEntries(profile) {
  const b = profile?.business || {};
  const p = b.person || {};
  const made = [];
  const add = (claim, source, status = 'owner_statement') => { const c = text(claim).trim(); if (c) made.push({ id: `d:${source}:${made.length}`, claim: c, status, source, date: null, derived: true }); };
  [['business.name', b.name], ['business.tagline', b.tagline], ['business.offers', b.offers], ['business.location', b.location],
    ['business.audience', b.audience], ['person.name', p.name], ['person.title', p.title], ['person.credentials', p.credentials],
    ['interview.brief', profile?.interview?.brief]].forEach(([src, v]) => add(v, src));
  for (const t of profile?.testimonials || []) if (t?.consent) add(t.quote, 'testimonial');
  for (const f of profile?.contentPlan?.facts || []) {
    const status = f.label === 'project file' ? 'verified' : f.label === 'creator direct' ? 'owner_statement' : 'unverified';
    add(f.text, f.source || 'content plan fact', status);
  }
  return made;
}

export const getKnowledgeBase = (profile) => [
  ...(profile?.knowledgeBase || []).filter((e) => e?.claim && STATUSES.includes(e.status)),
  ...deriveEntries(profile),
];

const RANK = { verified: 3, owner_statement: 2, unverified: 0 };

// Does this KB entry support the claim sentence? Every number in the claim
// must appear in the entry, and the two must share at least two content
// words (or one when the claim carries a number). Unverified entries match
// but classify as unverified, so an explicit "do not claim this" wins.
function supports(claim, entry) {
  const nums = numbers(claim);
  const entryNums = new Set(numbers(entry.claim));
  if (nums.some((n) => !entryNums.has(n))) return false;
  const shared = words(claim).filter((w) => words(entry.claim).includes(w)).length;
  return shared >= (nums.length ? 1 : 3);
}

export function classifyClaim(claim, kb) {
  let best = null;
  for (const e of kb) {
    if (!supports(claim, e)) continue;
    if (!best || RANK[e.status] > RANK[best.status]) best = e;
  }
  if (!best || best.status === 'unverified') return { claim, status: 'unverified', source: best?.source || null, entryId: best?.id || null };
  return { claim, status: best.status, source: best.source, entryId: best.id, date: best.date || null };
}

// Gate a block of text (or a fields object). Returns every decision; the
// caller ships only if blocked is empty.
export function gateText(raw, kb, scope = {}) {
  const decisions = extractClaims(raw).map((c) => ({ ...scope, ...classifyClaim(c, kb) }));
  return { decisions, blocked: decisions.filter((d) => d.status === 'unverified') };
}

export function gateFields(fields, kb, platformId) {
  const decisions = [];
  for (const [field, value] of Object.entries(fields || {})) {
    decisions.push(...gateText(value, kb, { platformId, field }).decisions);
  }
  return { decisions, blocked: decisions.filter((d) => d.status === 'unverified') };
}

export const formatBlocked = (blocked) =>
  blocked.slice(0, 10).map((d) => `- ${d.field ? `${d.field}: ` : ''}"${d.claim.slice(0, 160)}"`).join('\n');

// Interface stub for the future automated first-pass classifier (Jev,
// TypeSafe.ai decision API). Intentionally unbuilt until funnel volume
// justifies it. Must return the same decision shape as classifyClaim.
export async function externalClassifier(/* claims, kb */) {
  throw new Error('external classifier not configured');
}
