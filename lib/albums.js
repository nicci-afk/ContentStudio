// Albums: the Photos app's collections carried into the studio so the AI
// understands each one as a body of work (what it is, where and when, how it
// can be used), not just as 50,000 loose files. An album record is created by
// the ingest (stable id from the Photos uuid); its AI profile is built from the
// captions the analysis already wrote, so it costs one small text call per
// album and never re-reads an image.

import crypto from 'node:crypto';
import { catalog, albumStore, isUsable } from './store.js';
import { claudeJson, providerStatus } from './providers.js';

export const albumIdFor = (library, uuid) =>
  `alb_${crypto.createHash('sha1').update(`${library}:${uuid}`).digest('hex').slice(0, 12)}`;

const clean = (s) => String(s ?? '').replace(/[–—]/g, ',');
const cleanDeep = (v) => {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)]));
  return v;
};

// Live statistics from the catalog (nothing stored, so it never goes stale).
// One pass over a library fills every album at once; held items are never
// counted, so a quarantined photo cannot even inflate an album's size.
function collectStats(items) {
  const acc = new Map();
  const score = (i) => (i.quality || 0) + (i.apple?.favorite ? 2 : 0);
  for (const i of items) {
    if (!i.albums?.length || i.moderation?.status === 'held') continue;
    for (const id of i.albums) {
      let s = acc.get(id);
      if (!s) { s = { items: 0, usable: 0, analyzed: 0, videos: 0, favorites: 0, from: null, to: null, places: new Map(), best: null, bestScore: -1, anyImage: null }; acc.set(id, s); }
      s.items += 1;
      if (i.kind === 'video') s.videos += 1; else if (!s.anyImage) s.anyImage = i;
      if (i.apple?.favorite) s.favorites += 1;
      if (i.analyzed) s.analyzed += 1;
      const usable = isUsable(i);
      if (usable) s.usable += 1;
      if (i.takenAt) { if (!s.from || i.takenAt < s.from) s.from = i.takenAt; if (!s.to || i.takenAt > s.to) s.to = i.takenAt; }
      if (i.place) s.places.set(i.place, (s.places.get(i.place) || 0) + 1);
      if (usable && i.analyzed && score(i) > s.bestScore) { s.best = i; s.bestScore = score(i); }
    }
  }
  const out = new Map();
  for (const [id, s] of acc) {
    out.set(id, {
      items: s.items, usable: s.usable, analyzed: s.analyzed, videos: s.videos, photos: s.items - s.videos,
      favorites: s.favorites, from: s.from, to: s.to, coverId: (s.best || s.anyImage)?.id || null,
      places: [...s.places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p),
    });
  }
  return out;
}

const EMPTY_STATS = { items: 0, usable: 0, analyzed: 0, videos: 0, photos: 0, favorites: 0, from: null, to: null, coverId: null, places: [] };

export function albumStats(album) {
  return collectStats(catalog.inLibrary(album.library)).get(album.id) || EMPTY_STATS;
}

export function albumList(library) {
  const stats = collectStats(catalog.inLibrary(library));
  return albumStore.inLibrary(library)
    .map((a) => ({ ...a, stats: stats.get(a.id) || EMPTY_STATS }))
    .filter((a) => a.stats.items > 0)
    .sort((a, b) => (b.stats.to || '').localeCompare(a.stats.to || ''));
}

// Decorates items with the text of their albums (names plus profile themes)
// so selection can reason about collections. Returns shallow copies.
export function withAlbumContext(items, library) {
  const byId = new Map(albumStore.inLibrary(library).map((a) => [a.id, a]));
  if (!byId.size) return items;
  return items.map((i) => {
    if (!i.albums?.length) return i;
    const albums = i.albums.map((id) => byId.get(id)).filter(Boolean);
    if (!albums.length) return i;
    const albumNames = albums.map((a) => a.name);
    const albumText = [...albumNames, ...albums.flatMap((a) => [...(a.profile?.themes || []), ...(a.profile?.bestUses || [])])].join(' ');
    return { ...i, albumNames, albumText };
  });
}

function profilePrompt(album, stats, sample, biz) {
  const lines = sample.map((m) =>
    `[${m.id}] ${m.kind}${m.takenAt ? ` ${m.takenAt.slice(0, 10)}` : ''}${m.place ? ` @ ${m.place}` : ''} q${m.quality ?? '?'}${m.apple?.favorite ? ' FAV' : ''}: ${m.caption || m.alt || ''}${m.keywords?.length ? ` | ${m.keywords.slice(0, 6).join(', ')}` : ''}`).join('\n');
  return `Album "${album.name}"${album.folder?.length ? ` (in folder ${album.folder.join(' / ')})` : ''}.
${stats.items} items (${stats.photos} photos, ${stats.videos} videos, ${stats.favorites} favorites), ${stats.from ? `${stats.from.slice(0, 10)} to ${stats.to.slice(0, 10)}` : 'dates unknown'}${stats.places.length ? `, places: ${stats.places.join('; ')}` : ''}.
Owner: ${biz.name || 'a travel professional'}${biz.industry ? ` (${biz.industry})` : ''}.

A sample of its best items:
${lines}

Write an album profile the content engine will use to reuse this album well. Respond with ONLY JSON, no markdown fence, never a literal double-quote inside a string value:
{
  "summary": "2-3 sentences: what this album is, when and where, its story",
  "themes": ["4-8 short topical themes"],
  "mood": "a few words",
  "bestUses": ["3-6 specific content uses, such as a hook shot for a destination guide or a proof series for a supplier partnership"],
  "pillarsFit": ["content pillar types it supports, such as destination education or behind the scenes"],
  "heroIds": ["up to 6 ids from the sample that make the strongest hero or cover shots"],
  "gaps": ["1-3 shot types this album lacks that would round out a story"],
  "suggestedTopics": ["3-5 topic ideas this album could anchor"]
}`;
}

export async function buildAlbumProfile(album, profile) {
  if (!providerStatus().anthropic) throw new Error('no Claude key configured');
  const stats = albumStats(album);
  const biz = profile?.business || {};
  const sample = catalog.inLibrary(album.library)
    .filter((i) => i.albums?.includes(album.id) && isUsable(i) && i.analyzed)
    .sort((a, b) => ((b.quality || 0) + (b.apple?.favorite ? 2 : 0)) - ((a.quality || 0) + (a.apple?.favorite ? 2 : 0)))
    .slice(0, 50);
  if (!sample.length) throw new Error('nothing in this album has been analyzed yet');
  const banned = (biz.neverMention || []).filter(Boolean);
  const result = await claudeJson({
    system: `You write concise internal notes about a creator's photo albums. Rules: never use em dashes or en dashes; say nothing negative about any supplier, resort, hotel, cruise line, airline, tour operator, venue, destination, booking site or other advisor; neutral or positive framing only; describe only what the captions support.${banned.length ? ` Never mention: ${banned.join(', ')}.` : ''}`,
    messages: [{ role: 'user', content: profilePrompt(album, stats, sample, biz) }],
    maxTokens: 1200,
    usageBucket: 'album-profile',
  }, 2);
  const ok = new Set(sample.map((m) => m.id));
  const out = cleanDeep({
    summary: String(result.summary || '').slice(0, 600),
    themes: (result.themes || []).slice(0, 8),
    mood: String(result.mood || '').slice(0, 80),
    bestUses: (result.bestUses || []).slice(0, 6),
    pillarsFit: (result.pillarsFit || []).slice(0, 6),
    heroIds: (result.heroIds || []).filter((id) => ok.has(id)).slice(0, 6),
    gaps: (result.gaps || []).slice(0, 3),
    suggestedTopics: (result.suggestedTopics || []).slice(0, 5),
    builtAt: new Date().toISOString(),
    builtFromItems: stats.items,
  });
  albumStore.upsertMany([{ id: album.id, profile: out }]);
  return out;
}

export const profileStale = (album, stats = albumStats(album)) => {
  const s = stats;
  if (!s.analyzed) return false;
  if (!album.profile) return true;
  return Math.abs(s.items - (album.profile.builtFromItems || 0)) > Math.max(5, (album.profile.builtFromItems || 0) * 0.2);
};

export const albumJob = { running: false, total: 0, done: 0, errors: [], startedAt: null, finishedAt: null };

// Builds profiles for every album that has analyzed items and none yet (or a
// stale one), newest album first, a few at a time.
export async function buildMissingProfiles(profile, library, { limit = Infinity } = {}) {
  if (albumJob.running) throw new Error('album profiles are already building');
  Object.assign(albumJob, { running: true, total: 0, done: 0, errors: [], startedAt: new Date().toISOString(), finishedAt: null });
  try {
    const todo = albumList(library).filter((a) => profileStale(a, a.stats)).slice(0, limit);
    albumJob.total = todo.length;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const a = todo[next++];
        try { await buildAlbumProfile(a, profile); } catch (err) { albumJob.errors.push({ id: a.id, name: a.name, error: String(err.message || err).slice(0, 160) }); }
        albumJob.done += 1;
      }
    };
    await Promise.all([worker(), worker()]);
    albumStore.flush();
  } finally {
    albumJob.running = false;
    albumJob.finishedAt = new Date().toISOString();
  }
  return { ...albumJob };
}
