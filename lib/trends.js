// Templates and trend watch.
//
// A template is a STRUCTURE: the hook pattern, the beat order and timing, how
// fast it cuts, how its text looks, the kind of sound. It carries no footage,
// no voice, no music and no wording from the reel it was read from. The edit
// engine fills a template's beats with the creator's OWN footage and her own
// true words, and she adds the trending sound inside the app when she posts.
//
// Trend watch reads only public YouTube metadata for short-form videos in the
// brand's niche (titles, lengths, view velocity, hashtags) through the official
// API. It never downloads, stores or reuses anyone's media.

import fs from 'node:fs';
import path from 'node:path';
import { uid, studioStore, stateStore, tripStore, listWorkspaces, runWithWorkspace } from './store.js';
import { ffmpeg, ffmpegPath, rendersDir } from './render.js';
import { probeMedia } from './shorts.js';
import { claudeJson, imageBlock, providerStatus } from './providers.js';
import * as g from './google.js';
import { spawn } from 'node:child_process';

const dashless = (s) => String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ');
const clean = (s, n) => dashless(s).replace(/\s+/g, ' ').trim().slice(0, n);

// ---- starter structures (generic patterns, nobody's footage) ----------------------

const beat = (role, seconds, shot, text) => ({ role, seconds, shot, text });
export const STARTER_TEMPLATES = [
  { id: 'starter-place-reveal', name: 'Place reveal', structure: { summary: 'A strong opening image, three fast scenic cuts, then the payoff shot.', hookPattern: 'name the place and promise the one thing most visitors miss', durationSec: 22, cutCount: 7, avgCutSeconds: 3, textStyle: 'one short line per beat, top third, pop in', transitions: 'cuts', audioKind: 'warm, building, mid tempo', captionPattern: 'answer in the first line, one save prompt',
    beats: [beat('hook', 3, 'the single best wide shot', 'hook line naming the place'), beat('context', 3, 'wide establishing', 'where this is'), beat('moment', 3, 'close detail', 'one specific named moment'), beat('moment', 3, 'person moving through the scene', 'one specific named moment'), beat('moment', 3, 'texture or food detail', 'one specific named moment'), beat('payoff', 4, 'the reveal shot that pays off the hook', 'the answer to the hook'), beat('cta', 3, 'calm closing wide', 'save this for your trip to the place')] } },
  { id: 'starter-day-in', name: 'A day in', structure: { summary: 'A timestamped day told in moments, one clip per time of day.', hookPattern: 'a day in [place], hour by hour', durationSec: 28, cutCount: 8, avgCutSeconds: 3.5, textStyle: 'small time label top left, caption lower', transitions: 'quick fades', audioKind: 'light, easy, steady tempo', captionPattern: 'list the moments, one question to close',
    beats: [beat('hook', 3, 'morning light shot', 'a day in the place'), beat('moment', 3.5, 'breakfast or first stop', '8am label and the moment'), beat('moment', 3.5, 'activity', 'midday label and the moment'), beat('moment', 3.5, 'travel between places', 'afternoon label'), beat('moment', 3.5, 'golden hour', 'evening label'), beat('moment', 4, 'dinner or night shot', 'night label'), beat('cta', 3, 'last wide', 'what would you add?')] } },
  { id: 'starter-before-you-go', name: 'Before you go (3 tips)', structure: { summary: 'Three useful tips, each shown on a real shot, ending on a save prompt.', hookPattern: '3 things to know before you go to [place]', durationSec: 25, cutCount: 6, avgCutSeconds: 4, textStyle: 'numbered text, big and centered in the upper half', transitions: 'cuts', audioKind: 'confident, steady', captionPattern: 'the three tips as a list, save prompt',
    beats: [beat('hook', 3, 'the best place shot', '3 things to know before [place]'), beat('moment', 6, 'shot that proves tip one', '1. the first tip in 7 words'), beat('moment', 6, 'shot that proves tip two', '2. the second tip in 7 words'), beat('moment', 6, 'shot that proves tip three', '3. the third tip in 7 words'), beat('cta', 4, 'closing wide', 'save this before you go')] } },
  { id: 'starter-photo-rhythm', name: 'Photo rhythm (beat cut)', structure: { summary: 'A run of stills and short clips cut exactly on the beat of the music, one idea.', hookPattern: 'one line setting the mood, then the rhythm does the work', durationSec: 20, cutCount: 12, avgCutSeconds: 1.6, textStyle: 'minimal: hook at the top, one line near the end', transitions: 'hard cuts on the beat', audioKind: 'upbeat, clear beat, 110 to 125 bpm', captionPattern: 'short, place named, ask for a send',
    beats: [beat('hook', 2, 'strongest image', 'mood line with the place'), beat('moment', 14, 'twelve varied shots at one beat each, wide then close then person', ''), beat('payoff', 2.5, 'hero shot held', 'a closing line'), beat('cta', 1.5, 'same hero shot', 'send this to your travel person')] } },
  { id: 'starter-question-answer', name: 'Question and answer', structure: { summary: 'A question people really ask, the answer in the first seconds, then the proof.', hookPattern: 'the exact question as text, the answer spoken or shown immediately', durationSec: 30, cutCount: 6, avgCutSeconds: 4.5, textStyle: 'question at the top, answer line in the middle', transitions: 'cuts', audioKind: 'calm, low bed under speech', captionPattern: 'answer first, detail second, one link',
    beats: [beat('hook', 4, 'a clear shot of the thing in question', 'the question people ask'), beat('payoff', 5, 'the answer, shown', 'the short answer'), beat('moment', 6, 'proof shot', 'a specific number or detail'), beat('moment', 6, 'second proof shot', 'a specific detail'), beat('moment', 5, 'context shot', 'who this suits'), beat('cta', 4, 'calm close', 'ask me your question')] } },
  { id: 'starter-pov', name: 'POV moment', structure: { summary: 'First person, one continuous feeling, held shots, no talking.', hookPattern: 'POV: one real moment', durationSec: 18, cutCount: 5, avgCutSeconds: 3.6, textStyle: 'single line top, appears once and stays', transitions: 'slow fades', audioKind: 'dreamy, slow, ambient', captionPattern: 'one feeling in a sentence and the place',
    beats: [beat('hook', 4, 'first person view of the arrival', 'POV: the moment'), beat('moment', 4, 'what you see next', ''), beat('moment', 4, 'what you do', ''), beat('payoff', 4, 'the quiet detail that sums it up', ''), beat('cta', 2, 'wide hold', 'save it for later')] } },
].map((t) => ({ ...t, source: 'starter', readOnly: true }));

// ---- template store ------------------------------------------------------------------

const list = () => studioStore.get().templates || [];
const saveList = (fn) => studioStore.update((s) => ({ ...s, templates: fn(s.templates || []) }));

export const listTemplates = () => [...list(), ...STARTER_TEMPLATES];
export const getTemplate = (id) => listTemplates().find((t) => t.id === id) || null;

const normStructure = (s = {}) => ({
  summary: clean(s.summary, 300), hookPattern: clean(s.hookPattern, 200),
  durationSec: Math.round(Number(s.durationSec) || 0), cutCount: Math.round(Number(s.cutCount) || 0), avgCutSeconds: Math.round((Number(s.avgCutSeconds) || 0) * 10) / 10,
  textStyle: clean(s.textStyle, 200), transitions: clean(s.transitions, 120), audioKind: clean(s.audioKind, 160), captionPattern: clean(s.captionPattern, 200),
  beats: (Array.isArray(s.beats) ? s.beats : []).slice(0, 24).map((b) => ({
    role: ['hook', 'context', 'moment', 'proof', 'payoff', 'cta'].includes(b?.role) ? b.role : 'moment',
    seconds: Math.round(Math.min(30, Math.max(0.5, Number(b?.seconds) || 2)) * 10) / 10, shot: clean(b?.shot, 140), text: clean(b?.text, 140),
  })),
});

export function saveTemplate({ id, name, structure, source = 'manual', note }) {
  const t = { id: id || uid(), name: clean(name || 'My template', 80), source, createdAt: new Date().toISOString(), note: clean(note, 300), structure: normStructure(structure) };
  saveList((l) => (id && l.some((x) => x.id === id) ? l.map((x) => (x.id === id ? { ...x, ...t, createdAt: x.createdAt } : x)) : [t, ...l]));
  return t;
}

export function deleteTemplate(id) { saveList((l) => l.filter((t) => t.id !== id)); }

// ---- reading a reference reel --------------------------------------------------------------

function sceneTimes(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file, '-an', '-vf', "select='gt(scene,0.32)',showinfo", '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    proc.on('close', () => resolve([...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]))));
    proc.on('error', () => resolve([]));
  });
}

const REF_RULES = `You are reading the STRUCTURE of a short-form reel so a creator can build her own original video with the same shape. Describe only structure. Do NOT transcribe speech or lyrics, do NOT name any person, creator, brand, song or artist, and do NOT describe what makes the content distinctive to its maker. Keep every field generic enough that it could describe thousands of reels.

Respond with ONLY JSON: {"name": "a short generic name for this pattern", "summary": "one sentence", "hookPattern": "the pattern of the first two seconds, in generic words", "beats": [{"role": "hook|context|moment|proof|payoff|cta", "seconds": number, "shot": "generic shot type, for example wide establishing, close detail, person moving, text card", "text": "generic pattern for any on-screen text, for example a question, a number, a place name"}], "textStyle": "where and how text appears", "transitions": "mostly cuts, quick fades, and so on", "audioKind": "mood and tempo of the sound in generic words, no titles", "captionPattern": "how a caption for this kind of reel is shaped"}. Never put a double quote inside a value. Use the measured cut times to set beat seconds.`;

export async function analyzeReference(file, nameHint) {
  const probe = await probeMedia(file);
  if (probe.duration > 120) throw new Error('reference reels longer than 2 minutes are not supported');
  const cuts = await sceneTimes(file);
  const tmp = path.join(rendersDir(), `tmp-ref-${uid()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const frames = [];
    for (let i = 0; i < 8; i++) {
      const t = Math.min(probe.duration - 0.2, Math.max(0, (probe.duration * (i + 0.5)) / 8));
      const f = path.join(tmp, `f${i}.jpg`);
      try { await ffmpeg(['-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '6', '-y', f], 60000); frames.push({ t: Math.round(t * 10) / 10, b64: fs.readFileSync(f).toString('base64') }); } catch { /* thin sample */ }
    }
    const measured = { durationSec: Math.round(probe.duration * 10) / 10, cutCount: cuts.length + 1, avgCutSeconds: Math.round((probe.duration / (cuts.length + 1)) * 10) / 10, cutTimes: cuts.slice(0, 40).map((x) => Math.round(x * 10) / 10) };
    if (!providerStatus().anthropic) throw new Error('reading a reference reel needs the Claude key');
    const content = [{ type: 'text', text: `MEASURED: duration ${measured.durationSec}s, ${measured.cutCount} shots, cuts at ${measured.cutTimes.join(', ')} seconds. Frames below are evenly spaced.` }];
    for (const f of frames) content.push({ type: 'text', text: `Frame at ${f.t}s:` }, imageBlock(f.b64));
    content.push({ type: 'text', text: REF_RULES });
    const out = await claudeJson({ usageBucket: 'light', maxTokens: 2000, messages: [{ role: 'user', content }] });
    const structure = normStructure({ ...out, durationSec: measured.durationSec, cutCount: measured.cutCount, avgCutSeconds: measured.avgCutSeconds });
    return saveTemplate({ name: nameHint || out.name || 'Reference pattern', structure, source: 'reference' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function templateFromNotes(name, notes) {
  if (!providerStatus().anthropic) throw new Error('this needs the Claude key');
  const out = await claudeJson({
    tier: 'light', usageBucket: 'light', maxTokens: 1500,
    messages: [{ role: 'user', content: `Turn this description of a short-form video pattern into a structure. Describe structure only, generically; no names of people, brands or songs.\n\nDESCRIPTION: ${String(notes).slice(0, 1500)}\n\nRespond with ONLY JSON: {"summary": "", "hookPattern": "", "beats": [{"role": "hook|context|moment|proof|payoff|cta", "seconds": number, "shot": "", "text": ""}], "textStyle": "", "transitions": "", "audioKind": "", "captionPattern": "", "durationSec": number}. Never put a double quote inside a value.` }],
  });
  const beats = normStructure(out).beats;
  const cutCount = beats.length;
  const durationSec = beats.reduce((a, b) => a + b.seconds, 0);
  return saveTemplate({ name, structure: { ...out, durationSec, cutCount, avgCutSeconds: cutCount ? durationSec / cutCount : 0 }, source: 'notes', note: notes });
}

// ---- trend watch -----------------------------------------------------------------------------------

export function trendQueries(profile) {
  const saved = studioStore.get().settings?.trendQueries;
  if (saved?.length) return saved;
  const biz = profile.business || {};
  const q = [];
  if (biz.niche) q.push(`${biz.niche} shorts`);
  const place = String(biz.location || '').split(',')[0].trim();
  if (place) q.push(`${place} travel shorts`);
  for (const p of (profile.pillars || []).slice(0, 2)) if (p.name) q.push(`${p.name} shorts`);
  return [...new Set(q.map((x) => clean(x, 60)).filter(Boolean))].slice(0, 4);
}

export const trendState = () => ({ trends: studioStore.get().trends || {}, settings: studioStore.get().settings || {}, queries: trendQueries(stateStore.get().profile), canFetch: g.googleConfig().apiKey || g.isConnected() });

export async function runTrendWatch() {
  if (!(g.googleConfig().apiKey || g.isConnected())) throw new Error('set YOUTUBE_API_KEY on the server (or connect YouTube) to watch trends');
  const profile = stateStore.get().profile;
  const queries = trendQueries(profile);
  if (!queries.length) throw new Error('add a niche, a location or a pillar to the profile (or set your own search phrases) first');
  const after = new Date(Date.now() - 14 * 86400000).toISOString();
  const seen = new Map();
  const errors = [];
  for (const query of queries) {
    try {
      for (const v of await g.searchShortForm({ query, publishedAfter: after, maxResults: 15 })) if (!seen.has(v.id)) seen.set(v.id, { ...v, query });
    } catch (err) { errors.push(`${query}: ${String(err.message).slice(0, 100)}`); }
  }
  const now = Date.now();
  const videos = [...seen.values()].map((v) => {
    const ageDays = Math.max(1, (now - Date.parse(v.publishedAt || now)) / 86400000);
    return { id: v.id, title: clean(v.title, 120), channel: clean(v.channelTitle, 60), url: `https://www.youtube.com/shorts/${v.id}`, views: v.views, viewsPerDay: Math.round(v.views / ageDays), durationSec: Math.round(v.durationSec), publishedAt: v.publishedAt, tags: (String(v.description).match(/#[\w]+/g) || []).slice(0, 5), query: v.query };
  }).sort((a, b) => b.viewsPerDay - a.viewsPerDay).slice(0, 30);
  if (!videos.length) throw new Error(errors[0] || 'no short-form videos came back for those searches');
  let patterns = null;
  let patternError = null;
  if (providerStatus().anthropic) {
    try {
      const trips = tripStore.get().items.filter((t) => t.useInContent !== false).slice(0, 4).map((t) => `${t.name}: ${(t.places || []).join(', ')}`).join('; ');
      const out = await claudeJson({
        tier: 'light', usageBucket: 'light', maxTokens: 2200,
        system: 'You study public short-form video metadata to find patterns for a travel creator. Describe patterns and topic ideas only. Never suggest copying any video, creator, wording or sound. Never use em dashes or en dashes. Never criticize or compare against anyone or anything in the travel industry.',
        messages: [{ role: 'user', content: `Brand: ${profile.business?.name || ''}; niche: ${profile.business?.niche || ''}; real places and trips she has: ${trips || 'none listed'}.\n\nPublic short-form videos from the last 14 days, fastest growing first (JSON):\n${JSON.stringify(videos.slice(0, 25).map((v) => ({ t: v.title, vpd: v.viewsPerDay, s: v.durationSec, tags: v.tags }))).slice(0, 7000)}\n\nRespond with ONLY JSON: {"titleFormulas": [{"pattern": "a generic title shape", "example": "a made-up example about her niche, not copied"}], "topics": ["recurring topics"], "lengthSweetSpot": "one sentence with the typical length range", "hashtags": ["recurring hashtags"], "ideas": [{"title": "an original Short idea she could film from her own real trips", "why": "the pattern it follows", "hook": "an 8 word or shorter hook"}]}. 3 to 5 titleFormulas, 5 topics, 5 ideas. Never put a double quote inside a value.` }],
      });
      const arr = (a, n) => (Array.isArray(a) ? a : []).slice(0, n);
      patterns = {
        titleFormulas: arr(out.titleFormulas, 5).map((f) => ({ pattern: clean(f.pattern, 140), example: clean(f.example, 140) })),
        topics: arr(out.topics, 6).map((x) => clean(x, 80)), lengthSweetSpot: clean(out.lengthSweetSpot, 200),
        hashtags: arr(out.hashtags, 8).map((x) => clean(x, 40)),
        ideas: arr(out.ideas, 6).map((i) => ({ title: clean(i.title, 140), why: clean(i.why, 200), hook: clean(i.hook, 80) })),
      };
    } catch (err) { patternError = String(err.message).slice(0, 200); }
  }
  const trends = { at: new Date().toISOString(), queries, videos, patterns, patternError, errors: errors.length ? errors : undefined };
  studioStore.update((s) => ({ ...s, trends }));
  return trends;
}

export function saveTrendSettings({ queries, auto }) {
  const q = (Array.isArray(queries) ? queries : String(queries || '').split('\n')).map((x) => clean(x, 60)).filter(Boolean).slice(0, 5);
  studioStore.update((s) => ({ ...s, settings: { ...(s.settings || {}), trendQueries: q, trendAuto: !!auto } }));
  return trendState();
}

let sweeping = false;
export async function sweepTrends() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const w of listWorkspaces().items) {
      await runWithWorkspace(w.id, async () => {
        const st = studioStore.get();
        if (!st.settings?.trendAuto) return;
        if (st.trends?.at && Date.now() - Date.parse(st.trends.at) < 6.5 * 86400000) return;
        try { await runTrendWatch(); } catch (err) { console.warn(`trends ${w.id}: ${err.message}`); }
      });
    }
  } finally { sweeping = false; }
}

export function scheduleTrends() {
  if (process.env.DISABLE_TRENDS) return;
  setTimeout(() => sweepTrends().catch(() => {}), Number(process.env.TRENDS_FIRST_RUN_MS || 8 * 60 * 1000)).unref?.();
  setInterval(() => sweepTrends().catch(() => {}), 12 * 3600 * 1000).unref?.();
}
