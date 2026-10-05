// Module 2: hook library. Every hook comes from a managed template; nothing
// is invented freeform. A template has slots. Fact slots must be filled from
// the entity's knowledge base (verified or owner statement), and the filled
// hook must pass the voice card and the fact gate, or it fails closed.
//
// Storage per workspace (studio.json):
//   hooks:     owner-added or promoted templates [{id, pattern, template, slots, niche, platform, source, createdAt}]
//   hookStats: {templateId: {uses, bookedCalls, dms, saves, shares, follows, promotedAt, retiredAt, history: [...]}}
// The five seed templates live in code so every brand starts with them.

import { studioStore, uid } from './store.js';
import { getVoiceCard, scanText } from './voice.js';
import { getKnowledgeBase, gateText } from './facts.js';

// The five super hooks. One deliberate change from the spec: the contrarian
// hook targets a common BELIEF, never a group of people. "Most [practitioners]
// are [unflattering truth]" would disparage other advisors, which doctrine
// law 17 (industry respect) forbids everywhere.
export const SEED_HOOKS = [
  { id: 'seed-specific-number', pattern: 'specific_number', template: '[NUMBER]. That\'s [MEANING].',
    slots: { NUMBER: 'fact', MEANING: 'fact' }, note: 'A real number from the knowledge base, then what it cost or meant.' },
  { id: 'seed-contrarian-belief', pattern: 'contrarian_belief', template: 'Most people think [COMMON_BELIEF]. [WHAT_I_SEE].',
    slots: { COMMON_BELIEF: 'free', WHAT_I_SEE: 'fact' }, note: 'Challenges a belief, never a group of people or anyone in the industry.' },
  { id: 'seed-curiosity-gap', pattern: 'curiosity_gap', template: 'The [OUTCOME] that didn\'t exist [EARLIER_TIME].',
    slots: { OUTCOME: 'fact', EARLIER_TIME: 'free' }, note: 'An outcome she created that was not there before.' },
  { id: 'seed-insider-confession', pattern: 'insider_confession', template: 'I [DO_X] like the person who used to [DO_Y]. Because I was.',
    slots: { DO_X: 'free', DO_Y: 'fact' }, note: 'Her earlier role, from the knowledge base, explains how she works now.' },
  { id: 'seed-invisible-work', pattern: 'invisible_work', template: '[SPECIFICS]. Nobody ever found out.',
    slots: { SPECIFICS: 'fact' }, note: 'Behind-the-scenes work that went right, with no complaint about anyone.' },
].map((h) => ({ ...h, niche: '*', platform: '*', source: 'seeded' }));

export const PATTERNS = ['specific_number', 'contrarian_belief', 'curiosity_gap', 'insider_confession', 'invisible_work'];

const studio = () => studioStore.get();
const statsOf = (id) => studio().hookStats?.[id] || {};

const SLOT_RE = /\[([A-Z_]+)\]/g;
export const slotNames = (template) => [...String(template).matchAll(SLOT_RE)].map((m) => m[1]);

// Hierarchy from Module 7: booked calls, then DMs, saves, shares, follows.
// Likes are never a metric. Weights keep the order lexicographic in practice.
export function perfScore(p = {}) {
  const n = (k) => Number(p[k]) || 0;
  return n('bookedCalls') * 1e8 + n('dms') * 1e6 + n('saves') * 1e4 + n('shares') * 1e2 + n('follows');
}

export function listHooks({ includeRetired = false } = {}) {
  const custom = studio().hooks || [];
  return [...custom, ...SEED_HOOKS].map((h) => {
    const s = statsOf(h.id);
    const source = s.promotedAt ? 'promoted' : h.source;
    return { ...h, source, performance: { uses: s.uses || 0, bookedCalls: s.bookedCalls || 0, dms: s.dms || 0, saves: s.saves || 0, shares: s.shares || 0, follows: s.follows || 0 }, promotedAt: s.promotedAt || null, retiredAt: s.retiredAt || null };
  }).filter((h) => includeRetired || !h.retiredAt);
}

// Promoted winners outrank seeds; within a tier, real performance per use.
export function rankHooks({ platform = '*', niche = '*' } = {}) {
  const fits = (h) => (h.platform === '*' || h.platform === platform) && (h.niche === '*' || !niche || niche === '*' || String(h.niche).toLowerCase() === String(niche).toLowerCase());
  const tier = (h) => (h.source === 'promoted' ? 2 : h.source === 'owner' ? 1 : 0);
  return listHooks().filter(fits).sort((a, b) =>
    tier(b) - tier(a) || perfScore(b.performance) / Math.max(1, b.performance.uses) - perfScore(a.performance) / Math.max(1, a.performance.uses));
}

export const getHook = (id) => listHooks({ includeRetired: true }).find((h) => h.id === id) || null;

export function saveHook({ id, pattern, template, slots, niche = '*', platform = '*' }) {
  const t = String(template || '').replace(/[–—]/g, ',').trim().slice(0, 200);
  if (!t || !slotNames(t).length) throw new Error('a template needs at least one [SLOT]');
  const kinds = Object.fromEntries(slotNames(t).map((n) => [n, slots?.[n] === 'free' ? 'free' : 'fact']));
  const entry = { id: id && !id.startsWith('seed-') ? id : uid(), pattern: PATTERNS.includes(pattern) ? pattern : 'specific_number', template: t, slots: kinds, niche: String(niche || '*').slice(0, 60), platform: String(platform || '*').slice(0, 40), source: 'owner', createdAt: new Date().toISOString() };
  studioStore.update((s) => ({ ...s, hooks: [entry, ...(s.hooks || []).filter((h) => h.id !== entry.id)] }));
  return entry;
}

export function deleteHook(id) {
  studioStore.update((s) => ({ ...s, hooks: (s.hooks || []).filter((h) => h.id !== id) }));
}

export function updateStats(id, fn) {
  studioStore.update((s) => ({ ...s, hookStats: { ...(s.hookStats || {}), [id]: fn({ ...(s.hookStats?.[id] || {}) }) } }));
}
export const recordUse = (id, now = new Date()) => updateStats(id, (s) => {
  const m = now.toISOString().slice(0, 7);
  return { ...s, uses: (s.uses || 0) + 1, lastUsedAt: now.toISOString(), usesByMonth: { ...(s.usesByMonth || {}), [m]: ((s.usesByMonth || {})[m] || 0) + 1 } };
});

// ---- filling and validating ----------------------------------------------------

const STOP = new Set('the and for with that this from have has had was were are you your our their they them who what when where which will would into over about after before more most some any all not but out one than then also just only very that\'s'.split(' '));
const numbers = (s) => [...String(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ''));
const words = (s) => (String(s).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(?:ing|ed|es|s)$/, ''));

// A fact slot value is supported when some usable knowledge-base entry
// carries every number in it and most of its content words.
export function slotSupported(value, kb) {
  const nums = numbers(value);
  const ws = words(value);
  return kb.filter((e) => e.status !== 'unverified').some((e) => {
    const en = new Set(numbers(e.claim));
    if (nums.some((n) => !en.has(n))) return false;
    if (!ws.length) return nums.length > 0;
    const ew = new Set(words(e.claim));
    return ws.filter((w) => ew.has(w)).length / ws.length >= 0.6;
  });
}

const cleanSlot = (v) => String(v ?? '').replace(/[–—]/g, ',').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().slice(0, 120);

// Returns {ok, text, problems}. Fails closed on any problem.
export function fillHook(entry, values, profile) {
  const problems = [];
  if (!entry) return { ok: false, text: '', problems: ['unknown template'] };
  const kb = getKnowledgeBase(profile);
  let text = entry.template;
  for (const name of slotNames(entry.template)) {
    const v = cleanSlot(values?.[name]);
    if (!v) { problems.push(`slot ${name} is empty`); continue; }
    if (entry.slots?.[name] !== 'free' && !slotSupported(v, kb)) problems.push(`slot ${name} ("${v}") is not a verified fact for this brand`);
    text = text.replace(`[${name}]`, v);
  }
  text = text.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
  for (const v of scanText(getVoiceCard(profile), text)) if (v.rule !== 'style') problems.push(`voice: ${v.message}`);
  for (const d of gateText(text, kb).blocked) problems.push(`unverified claim: "${d.claim}"`);
  return { ok: !problems.length, text, problems };
}

// Prompt block that lists the library for the model to choose from.
export function libraryPrompt(entries, kbClaims, topic, trendHint = '') {
  return `Choose hooks for this content ONLY from the hook library below. You may not write a hook of your own: pick a template id and fill its [SLOTS]. Slots marked fact must be copied from the CHECKED FACTS list (the exact numbers and wording); slots marked free may be your words. Never use dashes. Never criticize, compare against, or disparage anyone or anything in the travel industry. Never put a double quote inside a value.

TOPIC: ${topic}
${trendHint ? `TREND CONSTRAINTS ON HOOK STRUCTURE: ${trendHint}\n` : ''}
HOOK LIBRARY (best first):
${entries.map((h) => `- id ${h.id} (${h.pattern}): ${h.template}  slots: ${Object.entries(h.slots).map(([k, v]) => `${k}=${v}`).join(', ')}${h.note ? `  note: ${h.note}` : ''}`).join('\n')}

CHECKED FACTS:
${kbClaims.length ? kbClaims.map((c) => `- ${c}`).join('\n') : '- (none on file)'}

Return 3 picks, each a different template where possible (or three different fills of the same template when only one is listed), strongest first. Respond with ONLY JSON: {"picks": [{"templateId": "id", "slots": {"SLOT": "value"}}]}`;
}

// Ask the model for picks, fill and validate each. Returns
// {hook, options, rejected}. hook is null when nothing passed (fail closed).
export async function chooseHooks({ profile, topic, platform = '*', trendHint = '', templateId = null, ask }) {
  const niche = profile?.business?.niche || '*';
  const forced = templateId ? getHook(templateId) : null;
  if (templateId && !forced) return { hook: null, options: [], rejected: [{ templateId, problems: ['unknown hook template'] }] };
  const entries = forced ? [forced] : rankHooks({ platform, niche }).slice(0, 12);
  const kb = getKnowledgeBase(profile).filter((e) => e.status !== 'unverified');
  const claims = kb.map((e) => e.claim.slice(0, 240)).slice(0, 60);
  let picks = [];
  try {
    const out = await ask(libraryPrompt(entries, claims, topic, trendHint));
    picks = Array.isArray(out?.picks) ? out.picks.slice(0, 5) : [];
  } catch (err) {
    return { hook: null, options: [], rejected: [{ problems: [`hook selection failed: ${String(err.message).slice(0, 160)}`] }] };
  }
  const passed = [];
  const rejected = [];
  for (const p of picks) {
    const entry = entries.find((h) => h.id === p?.templateId);
    const r = fillHook(entry, p?.slots, profile);
    if (r.ok && !passed.some((x) => x.text === r.text)) passed.push({ templateId: entry.id, pattern: entry.pattern, slots: p.slots, text: r.text });
    else rejected.push({ templateId: p?.templateId || null, text: r.text, problems: r.problems });
  }
  return { hook: passed[0] || null, options: passed.slice(0, 3), rejected };
}
