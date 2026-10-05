// Module 3: trend ingestion. Trends are DATA, not logic: a weekly trends.json
// of observations, each {platform, format_shift, hook_structure, audio_trend,
// observed_date, source}. They become generation CONSTRAINTS (structure),
// never copy templates, and every output they shape records the entry ids.
// Entries expire 30 days after they were last observed; re-observing one
// renews it. With no entries at all, generation runs the evergreen baseline.
//
// Stored per workspace in studio.json under trendInputs, so brands never
// share trend data. Separate from the YouTube trend watch in lib/trends.js,
// which can feed this as one more source.

import { studioStore, uid } from './store.js';
import { PLATFORMS } from './platforms.js';

export const TTL_DAYS = 30;
const DAY = 86400000;
const clean = (s, n) => String(s ?? '').replace(/\s*[–—]\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, n);
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) && !Number.isNaN(Date.parse(String(s).slice(0, 10))) ? String(s).slice(0, 10) : null);

// Platform keys a trend may name. Meta surfaces map to every format there.
const GROUPS = {
  instagram: ['instagram_reel', 'instagram_post', 'instagram_carousel'],
  facebook: ['facebook', 'facebook_reel'],
  meta: ['instagram_reel', 'instagram_post', 'instagram_carousel', 'facebook', 'facebook_reel'],
  youtube: ['youtube_shorts', 'youtube_long'],
  all: Object.keys(PLATFORMS),
};
export const platformsFor = (p) => GROUPS[p] || (PLATFORMS[p] ? [p] : []);

const keyOf = (e) => [e.platform, e.format_shift, e.hook_structure, e.audio_trend].map((x) => String(x || '').toLowerCase()).join('|');

const list = () => studioStore.get().trendInputs || [];

// Validates and merges a batch (a trends.json file). Entries with no date or
// no source are rejected and reported, never stored.
export function importTrends(input, now = Date.now()) {
  const rows = Array.isArray(input) ? input : Array.isArray(input?.trends) ? input.trends : [];
  const accepted = [];
  const rejected = [];
  for (const raw of rows.slice(0, 200)) {
    const e = {
      platform: clean(raw?.platform, 40).toLowerCase(),
      format_shift: clean(raw?.format_shift, 240),
      hook_structure: clean(raw?.hook_structure, 240),
      audio_trend: clean(raw?.audio_trend, 200),
      observed_date: isoDate(raw?.observed_date),
      source: clean(raw?.source, 200),
    };
    const why = !e.observed_date ? 'missing or invalid observed_date'
      : !e.source ? 'missing source'
      : !platformsFor(e.platform).length ? `unknown platform "${e.platform}"`
      : !(e.format_shift || e.hook_structure || e.audio_trend) ? 'no observation (format_shift, hook_structure or audio_trend)'
      : Date.parse(e.observed_date) > now + DAY ? 'observed_date is in the future' : null;
    if (why) rejected.push({ entry: raw, reason: why });
    else accepted.push(e);
  }
  studioStore.update((s) => {
    const cur = [...(s.trendInputs || [])];
    for (const e of accepted) {
      const i = cur.findIndex((x) => keyOf(x) === keyOf(e));
      if (i >= 0) {
        // Re-observed: renew the date, keep the id so citations stay valid.
        const prev = cur[i];
        cur[i] = { ...prev, observed_date: e.observed_date > prev.observed_date ? e.observed_date : prev.observed_date, sources: [...new Set([...(prev.sources || [prev.source]), e.source])].slice(0, 10), source: prev.source === 'first-party' ? prev.source : e.source };
      } else {
        cur.push({ id: `tr-${uid().slice(0, 8)}`, ...e, first_seen: e.observed_date, sources: [e.source] });
      }
    }
    return { ...s, trendInputs: cur.slice(-400) };
  });
  return { accepted: accepted.length, rejected, trends: listTrends(now) };
}

export const isActive = (e, now = Date.now()) => now - Date.parse(e.observed_date) <= TTL_DAYS * DAY;

export function listTrends(now = Date.now()) {
  return list().map((e) => ({ ...e, active: isActive(e, now), expiresOn: new Date(Date.parse(e.observed_date) + TTL_DAYS * DAY).toISOString().slice(0, 10) }))
    .sort((a, b) => (b.observed_date || '').localeCompare(a.observed_date || ''));
}

export function deleteTrend(id) {
  studioStore.update((s) => ({ ...s, trendInputs: (s.trendInputs || []).filter((e) => e.id !== id) }));
}

// First-party observations (the owner's own results) outrank public research.
export function activeTrends(platformId, now = Date.now()) {
  return list().filter((e) => isActive(e, now) && platformsFor(e.platform).includes(platformId))
    .sort((a, b) => (b.source === 'first-party') - (a.source === 'first-party') || b.observed_date.localeCompare(a.observed_date))
    .slice(0, 5);
}

// Constraint block for one platform prompt, plus the ids it carries. Empty
// when nothing is active: generation then runs the evergreen baseline.
export function constraintsFor(platformId, now = Date.now()) {
  const act = activeTrends(platformId, now);
  if (!act.length) return { text: '', ids: [] };
  const lines = act.map((e) => `- [${e.id}] ${[e.format_shift && `format: ${e.format_shift}`, e.hook_structure && `hook structure: ${e.hook_structure}`, e.audio_trend && `audio: ${e.audio_trend}`].filter(Boolean).join('; ')} (observed ${e.observed_date}, ${e.source})`);
  return {
    ids: act.map((e) => e.id),
    text: `\nTREND CONSTRAINTS (dated observations; apply them as STRUCTURE only, through the voice rules and the chosen hook. Never copy wording, never name another creator, song or artist, and never let a trend override a voice or fact rule):\n${lines.join('\n')}\n`,
  };
}

export function hookHint(platformId, now = Date.now()) {
  return activeTrends(platformId, now).filter((e) => e.hook_structure).map((e) => `[${e.id}] ${e.hook_structure}`).join('; ');
}
