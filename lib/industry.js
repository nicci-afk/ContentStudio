// Per-business industry wording. The studio was built for a travel advisor, so
// its prompts carried travel specific rules (never criticize a resort, a
// cruise line, a booking site, ...). A business in another trade, for example
// egress window installation, must never receive those rules or travel
// defaults (a "Travel & Events" video category, "travel shorts" searches,
// trip-based templates): they would leak one brand's world into another.
//
// Travel stays the default so every existing travel workspace keeps EXACTLY
// the wording it has today. A workspace is treated as a home-services trade
// only when its industry, niche, name or website says so, or when
// profile.business.industryKind is set to 'trade' (or back to 'travel').

const TRADE = /\b(window|egress|contract(?:or|ing)?|construction|remodel|basement|plumb|roof|hvac|concrete|excavat|home[- ]improvement|renovat|carpent|electric|landscap|handyman|foundation|waterproof)/i;

export function industryKind(profile) {
  const b = profile?.business || {};
  if (b.industryKind === 'trade' || b.industryKind === 'travel') return b.industryKind;
  let host = '';
  try { host = new URL(b.links?.website).host; } catch { /* no site yet */ }
  const hay = [b.industry, b.niche, b.name, host].filter(Boolean).join(' ');
  return TRADE.test(hay) ? 'trade' : 'travel';
}

export const isTrade = (profile) => industryKind(profile) === 'trade';
export const industryLabel = (profile) => (isTrade(profile) ? (profile?.business?.industry || profile?.business?.niche || 'home services') : 'travel');
export const creatorWord = (profile) => (isTrade(profile) ? 'business owner' : 'travel creator');

// Doctrine law 17, in full.
export function respectLaw(profile) {
  if (!isTrade(profile)) return null; // callers keep the original travel text
  const label = industryLabel(profile);
  return `17. INDUSTRY RESPECT. The creator is a ${label} professional. Never write anything negative, critical, mocking, or cautionary about any competitor, other contractor or installer, supplier, manufacturer, product brand, inspector, lead-generation site, or any other business in the ${label} industry, whether named or implied. No complaints, horror stories, warnings, insults, or comparisons that place anyone or anything below the creator. Never use derogatory or disgust vocabulary about anyone in the industry. Differentiate by describing the creator's own work, process, warranty, licensing and results, never by disparaging the alternative. Stating building code, permit and safety requirements factually and neutrally is expected and fine, but never imply that a named or unnamed competitor fails them. If source material contains a negative experience, omit it or recast it as a neutral, unnamed lesson. Every mention of anyone else's product or service must be neutral or positive.`;
}

// One sentence for the many utility prompts (captions, replies, titles).
export function respectClause(profile) {
  return isTrade(profile)
    ? `Never write anything negative about, compare against, or characterize any competitor, other contractor, supplier, manufacturer, product brand, or other business in the ${industryLabel(profile)} industry.`
    : 'Never write anything negative about, compare against, or characterize any supplier, resort, hotel, cruise line, airline, tour operator, venue, destination, booking site, platform, or other advisor.';
}

// The answer layer (FAQ) rule against differentiating by contrast.
export function noComparisonRule(profile) {
  return isTrade(profile)
    ? 'ABSOLUTE RULE for every question and answer: never compare the creator to, characterize, or imply anything lacking about any competitor, other contractor or installer, supplier, manufacturer, product brand, or lead-generation site, and never describe what anyone else fails to provide. No "cheap contractors", no "cookie cutter", no "unlike other companies". Answer worth-it and cost questions purely by describing what the creator provides, who it fits, and what it costs.'
    : 'ABSOLUTE RULE for every question and answer: never compare the creator to, characterize, or imply anything lacking about any booking site, listing platform, online travel agency, search engine, supplier, agency, or other travel advisor, and never describe what anyone else fails to provide. No "big-box", no "cookie cutter", no "generic booking", no "order takers", no "advisors chasing commission", no "unlike other ...". Answer worth-it questions purely by describing what the creator provides, who it fits, and what it costs.';
}

export const contrastSources = (profile) => (isTrade(profile)
  ? 'competitors, other contractors, suppliers, or product brands'
  : 'booking sites, search engines, or other advisors');

export const youtubeCategory = (profile) => (isTrade(profile) ? 'Howto & Style' : 'Travel & Events');
export const fillerHook = (profile) => (isTrade(profile) ? 'home tips' : 'travel tips');

export const HOOK_PATTERNS_TRADE = 'the detail most people miss about [the job]; what a [job type] really involves, start to finish; POV: [a real moment on the job]; wait for the last shot; the one thing I check first before [job]';

export function disclosureSponsor(profile, by) {
  if (!isTrade(profile)) return by ? `I traveled as a guest of ${by}.` : 'This trip was hosted.';
  return by ? `This video includes paid promotion from ${by}.` : 'This video includes paid promotion.';
}
