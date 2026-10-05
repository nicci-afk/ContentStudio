// Module 6: thumbnail brief generator. Every Reel or video asset ships with a
// brief: {overlay_text (6 words max), visual_direction, safe_zone_layout,
// format, min_resolution}. Rules enforced here, not just requested:
// - overlay restates the hook's intrigue and never duplicates the caption's
//   first line
// - text sits in the safe band: the top 14% (username) and the bottom 35%
//   (CTA and app UI) are dead zones
// - a human face preferred, motion in the first frame, high contrast
// - full bleed, never letterboxed
// A batch whose video assets lack a valid brief fails the batch check.

import { PLATFORMS } from './platforms.js';
import { getVoiceCard, scanText } from './voice.js';

export const isVideoPlatform = (id) => !!PLATFORMS[id]?.videoSpec || ['youtube_long', 'youtube_shorts', 'instagram_reel', 'facebook_reel', 'tiktok'].includes(id);

export const SAFE_ZONE = {
  deadZones: [{ name: 'username and top UI', fromTopPct: 0, toTopPct: 14 }, { name: 'caption, CTA and bottom UI', fromTopPct: 65, toTopPct: 100 }],
  textBand: { fromTopPct: 20, toTopPct: 60, marginSidePct: 8, note: 'Overlay text sits in the center band, roughly 20% to 60% from the top, centered, with 8% side margins.' },
};

const formatFor = (id) => (id === 'youtube_long' ? { format: '16:9', min_resolution: '1920x1080' } : { format: '9:16', min_resolution: '1080x1920' });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const firstLine = (s) => String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const captionOf = (fields = {}) => fields.caption || fields.description || fields.post || '';

// Validates a brief; returns the list of problems (empty = valid).
export function checkBrief(brief, { fields = {}, profile } = {}) {
  const p = [];
  if (!brief) return ['missing thumbnail brief'];
  const o = String(brief.overlay_text || '').trim();
  if (!o) p.push('overlay_text is empty');
  if (wordCount(o) > 6) p.push(`overlay_text has ${wordCount(o)} words (6 max)`);
  const cap = norm(firstLine(captionOf(fields)));
  if (o && cap && (cap === norm(o) || cap.startsWith(norm(o)) || norm(o).includes(cap))) p.push('overlay_text duplicates the caption\'s first line');
  if (!brief.visual_direction) p.push('visual_direction is empty');
  const dir = String(brief.visual_direction || '').replace(/\b(?:no|never|without|not|avoid)\s+(?:any\s+)?(?:letterbox\w*|black bars|bars)\b/gi, '');
  if (/letterbox|black bars|bars top and bottom/i.test(dir)) p.push('visual_direction asks for letterboxing');
  if (!brief.safe_zone_layout) p.push('safe_zone_layout missing');
  if (!brief.format || !brief.min_resolution) p.push('format or min_resolution missing');
  if (profile) for (const v of scanText(getVoiceCard(profile), o)) if (v.rule !== 'style') p.push(`overlay voice: ${v.message}`);
  return p;
}

// Picks the strongest first frame from attached media: a person beats
// scenery, moving footage beats a still.
export function pickCover(media = []) {
  const score = (m) => {
    const txt = `${m.alt || ''} ${m.caption || ''} ${(m.keywords || []).join(' ')}`.toLowerCase();
    return (/\b(person|people|woman|man|face|smil|portrait|nicci|she|her|guest|group)\b/.test(txt) ? 4 : 0) + (m.kind === 'video' ? 2 : 0) + (Number(m.quality) || 0) / 10;
  };
  return [...media].sort((a, b) => score(b) - score(a))[0] || null;
}

// Deterministic overlay: compress the hook to its intrigue in 6 words or
// fewer, then make sure it does not repeat the caption's first line.
const FILL = new Set(['the', 'a', 'an', 'that', 'and', 'of', 'to', 'it', 'is', 'was', 'i', 'my', 'that\'s', 'just', 'really', 'very']);
export function overlayFromHook(hook, caption) {
  const sentences = String(hook || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  // The intrigue usually lives in the turn (second sentence), else the first.
  const candidates = [...sentences.slice(1), sentences[0] || ''].map((s) => s.replace(/[.!?]+$/, ''));
  const cap = norm(firstLine(caption));
  for (const c of candidates) {
    let ws = c.split(/\s+/).filter(Boolean);
    if (ws.length > 6) ws = ws.filter((w, i) => i === 0 || !FILL.has(w.toLowerCase()));
    const out = ws.slice(0, 6).join(' ');
    if (out && !(cap && (cap === norm(out) || cap.startsWith(norm(out))))) return out;
  }
  return '';
}

export function buildBrief({ platformId, fields = {}, hookText = '', media = [], ai = null }) {
  const cover = pickCover(media);
  const overlay = (ai?.overlay_text && String(ai.overlay_text).replace(/[–—]/g, ',').trim()) || overlayFromHook(hookText || fields.hook, captionOf(fields));
  const fromMedia = cover ? `Open on ${cover.kind === 'video' ? 'a moving clip' : 'the still'} "${String(cover.alt || cover.caption || cover.name || cover.id).slice(0, 120)}"` : 'Open on the strongest real shot from her own footage';
  return {
    platformId,
    overlay_text: overlay,
    visual_direction: ai?.visual_direction
      ? String(ai.visual_direction).replace(/[–—]/g, ',').slice(0, 400)
      : `${fromMedia}. A human face in frame if any shot has one, motion in the first frame, high contrast between the text and the image (white text with a dark outline or a soft dark scrim behind the band). Full bleed, no letterboxing, no borders.`,
    coverMediaId: cover?.id || null,
    safe_zone_layout: SAFE_ZONE,
    ...formatFor(platformId),
    createdAt: new Date().toISOString(),
  };
}

// Builds and validates a brief for every video asset in a package. Returns
// {thumbnails, problems}. Callers store pkg.thumbnails.
export function briefsForPackage(pkg, profile, media = [], aiBriefs = {}) {
  const thumbnails = { ...(pkg.thumbnails || {}) };
  const problems = {};
  for (const [id, asset] of Object.entries(pkg.platforms || {})) {
    if (!isVideoPlatform(id)) continue;
    let b = buildBrief({ platformId: id, fields: asset.fields, hookText: pkg.hook?.text || asset.fields?.hook, media, ai: aiBriefs[id] });
    let p = checkBrief(b, { fields: asset.fields, profile });
    if (p.length && aiBriefs[id]) {
      // The model's overlay failed a rule: fall back to the deterministic one.
      b = buildBrief({ platformId: id, fields: asset.fields, hookText: pkg.hook?.text || asset.fields?.hook, media });
      p = checkBrief(b, { fields: asset.fields, profile });
    }
    thumbnails[id] = { ...b, problems: p, status: p.length ? 'blocked' : 'passed' };
    if (p.length) problems[id] = p;
  }
  return { thumbnails, problems };
}

// Batch check: every video asset must carry a passing brief.
export function batchCheck(pkg) {
  const missing = [];
  for (const id of Object.keys(pkg.platforms || {})) {
    if (!isVideoPlatform(id)) continue;
    const t = pkg.thumbnails?.[id];
    if (!t) missing.push({ platformId: id, message: 'No thumbnail brief. Build briefs before approving this batch.' });
    else if (t.status !== 'passed') missing.push({ platformId: id, message: `Thumbnail brief fails: ${(t.problems || []).join('; ')}` });
  }
  return missing;
}
